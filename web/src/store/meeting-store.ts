import { create } from 'zustand';
import type { Meeting, MeetingSummary, PipelineStats, Segment, ServerMessage, Speaker } from '@amt/shared';
import type { ConnectionState } from '../lib/connection';

export type CaptureState = 'idle' | 'starting' | 'capturing' | 'paused' | 'stopping';

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  message: string;
  hint?: string;
}

interface MeetingStore {
  meeting: Meeting | null;
  speakers: Record<string, Speaker>;
  segments: Record<string, Segment>;
  order: string[];
  stats: PipelineStats | null;
  summary: MeetingSummary | null;
  connection: ConnectionState;
  pendingUploads: number;
  capture: CaptureState;
  speaking: Record<string, boolean>;
  level: number;
  muted: boolean;
  sources: Array<{ id: string; kind: 'mic' | 'tab'; label: string }>;
  uiLatencyMs: number | null;
  endPending: number | null;
  toasts: Toast[];

  reset: () => void;
  load: (d: { meeting: Meeting; speakers: Speaker[]; segments: Segment[]; summary?: MeetingSummary | null }) => void;
  apply: (msg: ServerMessage, clockOffsetMs: number) => void;
  upsertSegment: (s: Segment) => void;
  upsertSpeaker: (s: Speaker) => void;
  set: (p: Partial<MeetingStore>) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const cmp = (a: Segment, b: Segment) => a.startOffsetMs - b.startOffsetMs || a.subIndex - b.subIndex || a.id.localeCompare(b.id);

function sortIds(segments: Record<string, Segment>): string[] {
  return Object.values(segments)
    .sort(cmp)
    .map((s) => s.id);
}

let toastId = 1;

const initial = {
  meeting: null,
  speakers: {},
  segments: {},
  order: [],
  stats: null,
  summary: null,
  connection: 'closed' as ConnectionState,
  pendingUploads: 0,
  capture: 'idle' as CaptureState,
  speaking: {},
  level: 0,
  muted: false,
  sources: [] as Array<{ id: string; kind: 'mic' | 'tab'; label: string }>,
  uiLatencyMs: null,
  endPending: null,
};

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  ...initial,
  toasts: [],

  reset: () => set({ ...initial }),

  load: ({ meeting, speakers, segments, summary }) => {
    const segs = Object.fromEntries(segments.map((s) => [s.id, s]));
    set({
      meeting,
      speakers: Object.fromEntries(speakers.map((s) => [s.id, s])),
      segments: segs,
      order: sortIds(segs),
      summary: summary === undefined ? get().summary : summary,
    });
  },

  upsertSegment: (s) => {
    const prev = get().segments[s.id];
    // Không để bản tạm thời (interim) đến muộn ghi đè bản đã xác nhận
    if (prev && s.interim && !prev.interim && prev.status === 'final') return;
    const segments = { ...get().segments, [s.id]: s };
    const needsSort = !prev || prev.startOffsetMs !== s.startOffsetMs || prev.subIndex !== s.subIndex;
    set({ segments, order: needsSort ? sortIds(segments) : get().order });
  },

  upsertSpeaker: (s) => set({ speakers: { ...get().speakers, [s.id]: s } }),

  apply: (msg, clockOffsetMs) => {
    switch (msg.type) {
      case 'snapshot':
        get().load({ meeting: msg.meeting, speakers: msg.speakers, segments: msg.segments });
        set({ stats: msg.stats });
        break;
      case 'segment': {
        get().upsertSegment(msg.segment);
        if (!msg.segment.interim) {
          const lat = Date.now() + clockOffsetMs - Date.parse(msg.segment.updatedAt);
          if (lat >= 0 && lat < 60_000) set({ uiLatencyMs: Math.round(lat) });
        }
        break;
      }
      case 'segment_removed': {
        const segments = { ...get().segments };
        delete segments[msg.segmentId];
        set({ segments, order: get().order.filter((id) => id !== msg.segmentId) });
        break;
      }
      case 'speaker':
        get().upsertSpeaker(msg.speaker);
        break;
      case 'meeting':
        set({ meeting: msg.meeting });
        break;
      case 'ended':
        set({ meeting: msg.meeting, endPending: null });
        break;
      case 'stats':
        set({ stats: msg.stats });
        break;
      case 'end_pending':
        set({ endPending: msg.pending });
        break;
      case 'error':
        // Lỗi gắn với một lượt đã hiển thị trên lượt đó; chỉ báo toast cho lỗi chung hoặc lỗi cấu hình
        if (!msg.segmentId || ['auth', 'quota', 'config', 'unsupported'].includes(msg.code)) {
          const dup = get().toasts.some((t) => t.message === msg.message);
          if (!dup) get().toast({ kind: 'error', message: msg.message, hint: msg.hint });
        }
        break;
    }
  },

  set: (p) => set(p),

  toast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    window.setTimeout(() => get().dismiss(id), t.kind === 'error' ? 9000 : 4000);
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Trạng thái hiển thị cho người dùng (luôn kèm chữ + biểu tượng, không chỉ màu). */
export type PipelineStatus = 'waiting' | 'listening' | 'recognizing' | 'translating' | 'disconnected' | 'paused' | 'ended';

export function derivePipelineStatus(s: Pick<MeetingStore, 'meeting' | 'connection' | 'capture' | 'stats' | 'segments'>): PipelineStatus {
  if (s.meeting?.status === 'ended') return 'ended';
  if (s.connection === 'closed') return 'disconnected';
  if (s.meeting?.status === 'paused' || s.capture === 'paused') return 'paused';
  const st = s.stats;
  if (st && st.processingChunks + st.queuedChunks > 0) return 'recognizing';
  if (st && st.pendingTranslations > 0) return 'translating';
  if (s.capture === 'capturing') return 'listening';
  return 'waiting';
}
