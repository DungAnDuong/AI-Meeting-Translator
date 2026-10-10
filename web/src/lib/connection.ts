import type { ClientMessage, ServerMessage } from '@amt/shared';
import { encodeAudioPacket, PCM_SAMPLE_RATE } from '@amt/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

interface PendingChunk {
  chunkId: string;
  sourceId: string;
  sourceLabel: string;
  capturedAtLocal: number;
  durationMs: number;
  pcm: Int16Array;
}

const MAX_PENDING = 150; // ~ 10–15 phút lời nói khi mất mạng

/**
 * Kết nối WebSocket tới một cuộc họp:
 *  - Tự kết nối lại (backoff) khi rớt mạng.
 *  - Mỗi đoạn âm thanh có ID riêng và được giữ lại tới khi server xác nhận (chunk_ack);
 *    sau khi kết nối lại sẽ gửi lại các đoạn chưa xác nhận – server bỏ qua đoạn trùng.
 *  - Hiệu chỉnh lệch đồng hồ client/server để thời điểm phát biểu chính xác.
 */
export class MeetingConnection {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'closed';
  private pending = new Map<string, PendingChunk>();
  private retryMs = 500;
  private closedByUser = false;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  clockOffsetMs = 0; // serverNow - clientNow
  rttMs: number | null = null;

  constructor(
    private readonly meetingId: string,
    private readonly clientId: string,
    private readonly h: {
      onMessage: (m: ServerMessage) => void;
      onState: (s: ConnectionState) => void;
      onPendingChange: (n: number) => void;
      onDropped?: (n: number) => void;
    },
  ) {}

  get pendingCount() {
    return this.pending.size;
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.h.onState(s);
  }

  private open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setState('connecting');

    ws.onopen = () => {
      this.retryMs = 500;
      this.send({ type: 'hello', meetingId: this.meetingId, clientId: this.clientId });
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 15_000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (msg.type === 'snapshot') {
        this.clockOffsetMs = msg.serverNow - Date.now();
        this.setState('open');
        this.flushPending();
      } else if (msg.type === 'pong') {
        const rtt = Date.now() - msg.t;
        this.rttMs = rtt;
        this.clockOffsetMs = msg.serverNow + rtt / 2 - Date.now();
      } else if (msg.type === 'chunk_ack') {
        this.pending.delete(msg.chunkId);
        this.h.onPendingChange(this.pending.size);
      }
      this.h.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.setState('closed');
      if (this.closedByUser || e.code === 4401) return;
      this.reconnectTimer = window.setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(10_000, this.retryMs * 2);
    };
    ws.onerror = () => ws.close();
  }

  private ping() {
    this.send({ type: 'ping', t: Date.now() });
  }

  send(msg: ClientMessage | { type: 'demo_start' }): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Đưa đoạn âm thanh vào hàng đợi chờ xác nhận và gửi ngay nếu đang kết nối. */
  sendAudio(c: Omit<PendingChunk, 'chunkId'>): string {
    const chunk: PendingChunk = { ...c, chunkId: crypto.randomUUID() };
    this.pending.set(chunk.chunkId, chunk);
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value!;
      this.pending.delete(oldest);
      this.h.onDropped?.(1);
    }
    this.h.onPendingChange(this.pending.size);
    if (this.state === 'open') this.transmit(chunk);
    return chunk.chunkId;
  }

  private transmit(c: PendingChunk) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const packet = encodeAudioPacket(
      {
        type: 'chunk',
        chunkId: c.chunkId,
        sourceId: c.sourceId,
        sourceLabel: c.sourceLabel,
        sampleRate: PCM_SAMPLE_RATE,
        capturedAt: c.capturedAtLocal + this.clockOffsetMs,
        durationMs: c.durationMs,
      },
      c.pcm,
    );
    this.ws.send(packet);
  }

  private flushPending() {
    for (const c of this.pending.values()) this.transmit(c);
  }

  /** Chờ tới khi mọi đoạn âm thanh đã được server nhận (hoặc hết thời gian). */
  async waitForUploads(timeoutMs = 15_000): Promise<number> {
    const start = Date.now();
    while (this.pending.size && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 150));
    return this.pending.size;
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export function getClientId(): string {
  try {
    let id = sessionStorage.getItem('amt-client-id');
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      sessionStorage.setItem('amt-client-id', id);
    }
    return id;
  } catch {
    return crypto.randomUUID().slice(0, 8);
  }
}
