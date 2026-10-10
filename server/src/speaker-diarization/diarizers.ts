import type { Speaker } from '@amt/shared';
import type {
  DiarizationInput,
  DiarizedPiece,
  ISpeakerDiarizationProvider,
  KnownSpeakerReference,
  SpeakerAssignment,
  TranscriptionResult,
} from '../ai-provider-manager/types';
import { pcmToWav, slicePcm, wavDataUrl } from '../audio/wav';
import type { TranscriptRepository } from '../transcript-manager/repository';

type OnSpeaker = (s: Speaker) => void;

/** Không phân biệt người nói: mọi lượt gán "Không xác định". */
export class NoDiarization implements ISpeakerDiarizationProvider {
  readonly mode = 'none';
  readonly requiresDiarizedTranscription = false;
  async prepare() {
    return {};
  }
  async assign(input: DiarizationInput, result: TranscriptionResult): Promise<SpeakerAssignment[]> {
    return [{ speakerId: null, text: result.text, startMs: 0, endMs: input.durationMs, overlap: false }];
  }
}

/**
 * Mỗi nguồn âm thanh (micro riêng của từng người, từng thiết bị tham gia, tab cuộc họp) là một người nói.
 * Chính xác khi mỗi người có micro riêng; không tách được nhiều người nói chung một micro.
 */
export class PerSourceDiarization implements ISpeakerDiarizationProvider {
  readonly mode = 'per-source';
  readonly requiresDiarizedTranscription = false;
  constructor(
    private readonly repo: TranscriptRepository,
    private readonly onSpeaker: OnSpeaker,
  ) {}
  async prepare() {
    return {};
  }
  async assign(input: DiarizationInput, result: TranscriptionResult): Promise<SpeakerAssignment[]> {
    let speaker = this.repo.findSpeakerBySource(input.meetingId, input.sourceId);
    if (!speaker) {
      speaker = this.repo.createSpeaker(input.meetingId, { sourceId: input.sourceId });
      this.onSpeaker(speaker);
    }
    return [{ speakerId: speaker.id, text: result.text, startMs: 0, endMs: input.durationMs, overlap: false }];
  }
}

export interface ReferenceDiarizationOptions {
  /** Tổng thời lượng tối thiểu của một giọng mới trong chunk để đủ cơ sở tạo người nói mới. */
  minNewSpeakerMs: number;
  /** Đoạn liên tục dài nhất tối thiểu (API yêu cầu mẫu tham chiếu 2–10 giây). */
  minReferenceMs: number;
  maxReferenceMs: number;
  maxKnownSpeakers: number;
  mergeGapMs: number;
  overlapThresholdMs: number;
}

const DEFAULT_REF_OPTS: ReferenceDiarizationOptions = {
  minNewSpeakerMs: 2000,
  minReferenceMs: 2000,
  maxReferenceMs: 10_000,
  maxKnownSpeakers: 4,
  mergeGapMs: 1200,
  overlapThresholdMs: 150,
};

/**
 * Diarization bằng gpt-4o-transcribe-diarize. Model chỉ gán nhãn A/B/C trong phạm vi MỘT lần gọi,
 * nên để giữ nhãn nhất quán suốt cuộc họp ta gửi kèm mẫu giọng (2–10s) của tối đa 4 người nói gần nhất
 * (known_speaker_references). Giọng chưa biết chỉ được tạo người nói mới khi đủ dài; nếu không → "Không xác định".
 */
export class OpenAIReferenceDiarization implements ISpeakerDiarizationProvider {
  readonly mode = 'openai';
  readonly requiresDiarizedTranscription = true;
  private readonly refs = new Map<string, { wav: Buffer; lastUsed: number }>();
  private readonly prepared = new Map<string, Map<string, string>>(); // chunkId → (refName → speakerId)
  private readonly opts: ReferenceDiarizationOptions;

  constructor(
    private readonly repo: TranscriptRepository,
    private readonly onSpeaker: OnSpeaker,
    opts: Partial<ReferenceDiarizationOptions> = {},
  ) {
    this.opts = { ...DEFAULT_REF_OPTS, ...opts };
  }

  /** Số người nói đang có mẫu giọng tham chiếu (phục vụ kiểm thử/hiển thị). */
  get referenceCount() {
    return this.refs.size;
  }

  async prepare(input: DiarizationInput): Promise<{ knownSpeakers?: KnownSpeakerReference[] }> {
    const speakers = new Map(this.repo.listSpeakers(input.meetingId).map((s) => [s.id, s]));
    const chosen = [...this.refs.entries()]
      .filter(([id]) => speakers.has(id)) // người nói có thể đã bị gộp/xóa
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
      .slice(0, this.opts.maxKnownSpeakers);
    const map = new Map<string, string>();
    const known: KnownSpeakerReference[] = chosen.map(([id, ref]) => {
      const name = `spk_${speakers.get(id)!.label}`;
      map.set(name, id);
      return { name, dataUrl: wavDataUrl(ref.wav) };
    });
    this.prepared.set(input.chunkId, map);
    return known.length ? { knownSpeakers: known } : {};
  }

  async assign(input: DiarizationInput, result: TranscriptionResult): Promise<SpeakerAssignment[]> {
    const nameMap = this.prepared.get(input.chunkId) ?? new Map<string, string>();
    this.prepared.delete(input.chunkId);
    const pieces: DiarizedPiece[] = result.pieces?.length
      ? result.pieces.filter((p) => p.text.trim())
      : result.text.trim()
        ? [{ speakerTag: '?', startMs: 0, endMs: input.durationMs, text: result.text }]
        : [];
    if (!pieces.length) return [];

    // Gom thời lượng theo nhãn cục bộ để quyết định có đủ cơ sở tạo người nói mới không.
    const byTag = new Map<string, { total: number; longest: DiarizedPiece }>();
    for (const p of pieces) {
      if (nameMap.has(p.speakerTag)) continue;
      const d = p.endMs - p.startMs;
      const cur = byTag.get(p.speakerTag);
      if (!cur) byTag.set(p.speakerTag, { total: d, longest: p });
      else {
        cur.total += d;
        if (d > cur.longest.endMs - cur.longest.startMs) cur.longest = p;
      }
    }

    const tagToSpeaker = new Map<string, string | null>(nameMap);
    for (const [tag, info] of byTag) {
      const longestMs = info.longest.endMs - info.longest.startMs;
      if (tag !== '?' && info.total >= this.opts.minNewSpeakerMs && longestMs >= this.opts.minReferenceMs) {
        const speaker = this.repo.createSpeaker(input.meetingId);
        this.onSpeaker(speaker);
        const end = Math.min(info.longest.endMs, info.longest.startMs + this.opts.maxReferenceMs);
        const clip = slicePcm(input.pcm, input.sampleRate, info.longest.startMs, end);
        this.refs.set(speaker.id, { wav: pcmToWav(clip, input.sampleRate), lastUsed: Date.now() });
        tagToSpeaker.set(tag, speaker.id);
      } else {
        tagToSpeaker.set(tag, null); // chưa đủ cơ sở → Không xác định
      }
    }

    const assigned = pieces.map((p) => ({
      speakerId: tagToSpeaker.get(p.speakerTag) ?? null,
      text: p.text.trim(),
      startMs: p.startMs,
      endMs: p.endMs,
      overlap: false,
    }));
    for (const a of assigned) {
      const ref = a.speakerId ? this.refs.get(a.speakerId) : undefined;
      if (ref) ref.lastUsed = Date.now();
    }
    return markOverlaps(mergeAdjacent(assigned, this.opts.mergeGapMs), this.opts.overlapThresholdMs);
  }
}

/** Gộp các đoạn liền kề cùng người nói (người nói ngắt nghỉ ngắn rồi nói tiếp). Không gộp người nói khác nhau. */
export function mergeAdjacent(items: SpeakerAssignment[], gapMs: number): SpeakerAssignment[] {
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const out: SpeakerAssignment[] = [];
  for (const it of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.speakerId !== null && prev.speakerId === it.speakerId && it.startMs - prev.endMs <= gapMs) {
      prev.text = `${prev.text} ${it.text}`.trim();
      prev.endMs = Math.max(prev.endMs, it.endMs);
    } else out.push({ ...it });
  }
  return out;
}

/** Đánh dấu các đoạn của những người nói khác nhau chồng lấn thời gian (nói chồng lời). */
export function markOverlaps(items: SpeakerAssignment[], thresholdMs: number): SpeakerAssignment[] {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.speakerId === b.speakerId && a.speakerId !== null) continue;
      const ov = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
      if (ov > thresholdMs) a.overlap = b.overlap = true;
    }
  }
  return items;
}
