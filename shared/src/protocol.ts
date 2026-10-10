import type { Meeting, Segment, Speaker } from './index';

/**
 * Gói âm thanh nhị phân client → server:
 *   [uint32 LE: độ dài header JSON][header JSON UTF-8][PCM Int16 LE mono]
 */
export interface AudioChunkHeader {
  type: 'chunk';
  chunkId: string; // UUID do client tạo – dùng để chống trùng lặp khi gửi lại
  sourceId: string; // ví dụ "<clientId>:mic"
  sourceLabel: string;
  sampleRate: number; // 16000
  capturedAt: number; // epoch ms (đồng hồ server, đã hiệu chỉnh lệch)
  durationMs: number;
}

export const PCM_SAMPLE_RATE = 16000;

export function encodeAudioPacket(header: AudioChunkHeader, pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + pcm.byteLength);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 4 + json.length);
  return out;
}

export function decodeAudioPacket(buf: Uint8Array): { header: AudioChunkHeader; pcm: Int16Array } {
  if (buf.byteLength < 4) throw new Error('Gói âm thanh quá ngắn');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint32(0, true);
  if (len <= 0 || len > 4096 || 4 + len > buf.byteLength) throw new Error('Header gói âm thanh không hợp lệ');
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len))) as AudioChunkHeader;
  const pcmBytes = buf.subarray(4 + len);
  // Sao chép để đảm bảo căn chỉnh 2 byte
  const copy = new Uint8Array(pcmBytes.byteLength - (pcmBytes.byteLength % 2));
  copy.set(pcmBytes.subarray(0, copy.byteLength));
  return { header, pcm: new Int16Array(copy.buffer) };
}

export type ClientMessage =
  | { type: 'hello'; meetingId: string; clientId: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end'; mode: 'ask' | 'drain' | 'abort' }
  | { type: 'retry_segment'; segmentId: string }
  | { type: 'ping'; t: number };

export interface PipelineStats {
  queuedChunks: number;
  processingChunks: number;
  pendingTranslations: number;
  errors: number;
  avgSttLatencyMs: number | null;
  avgTranslationLatencyMs: number | null;
  lastSttLatencyMs: number | null;
  lastTranslationLatencyMs: number | null;
  aiStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  aiStatusMessage: string | null;
}

export type ServerMessage =
  | { type: 'snapshot'; meeting: Meeting; speakers: Speaker[]; segments: Segment[]; serverNow: number; stats: PipelineStats }
  | { type: 'chunk_ack'; chunkId: string; duplicate: boolean }
  | { type: 'segment'; segment: Segment }
  | { type: 'segment_removed'; segmentId: string }
  | { type: 'speaker'; speaker: Speaker }
  | { type: 'meeting'; meeting: Meeting }
  | { type: 'stats'; stats: PipelineStats }
  | { type: 'end_pending'; pending: number }
  | { type: 'ended'; meeting: Meeting }
  | { type: 'error'; code: string; message: string; hint?: string; segmentId?: string }
  | { type: 'pong'; t: number; serverNow: number };
