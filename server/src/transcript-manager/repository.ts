import crypto from 'node:crypto';
import type { DiarizationMode, Meeting, MeetingStatus, MeetingSummary, Segment, SegmentStatus, Speaker } from '@amt/shared';
import { speakerLabelForIndex } from '@amt/shared';
import { transaction, type Db } from '../database/db';

type Row = Record<string, any>;

const now = () => new Date().toISOString();

function toMeeting(r: Row): Meeting {
  return {
    id: r.id,
    title: r.title,
    context: r.context,
    glossary: r.glossary,
    sourceLanguage: r.source_language,
    targetLanguage: r.target_language,
    status: r.status,
    sttProvider: r.stt_provider,
    translationProvider: r.translation_provider,
    diarizationMode: r.diarization_mode,
    storeAudio: !!r.store_audio,
    isDemo: !!r.is_demo,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    segmentCount: r.segment_count ?? undefined,
  };
}

function toSpeaker(r: Row): Speaker {
  return { id: r.id, meetingId: r.meeting_id, label: r.label, displayName: r.display_name, colorIndex: r.color_index };
}

function toSegment(r: Row): Segment {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    chunkId: r.chunk_id,
    subIndex: r.sub_index,
    speakerId: r.speaker_id,
    sourceId: r.source_id,
    startOffsetMs: r.start_offset_ms,
    endOffsetMs: r.end_offset_ms,
    startedAt: r.started_at,
    language: r.language,
    originalText: r.original_text,
    translatedText: r.translated_text,
    status: r.status,
    error: r.error,
    originalEdited: !!r.original_edited,
    translationEdited: !!r.translation_edited,
    overlap: !!r.overlap,
    sttLatencyMs: r.stt_latency_ms,
    translationLatencyMs: r.translation_latency_ms,
    updatedAt: r.updated_at,
  };
}

export interface NewMeeting {
  ownerId: string;
  title: string;
  context?: string;
  glossary?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  sttProvider: string;
  translationProvider: string;
  diarizationMode: DiarizationMode;
  storeAudio?: boolean;
  isDemo?: boolean;
}

export interface NewSegment {
  meetingId: string;
  chunkId: string | null;
  subIndex: number;
  speakerId: string | null;
  sourceId: string;
  startOffsetMs: number;
  endOffsetMs: number;
  startedAt: string;
  status: SegmentStatus;
  originalText?: string;
  translatedText?: string;
  language?: string | null;
  overlap?: boolean;
}

export type SegmentPatch = Partial<
  Pick<
    Segment,
    | 'speakerId'
    | 'originalText'
    | 'translatedText'
    | 'status'
    | 'error'
    | 'language'
    | 'originalEdited'
    | 'translationEdited'
    | 'overlap'
    | 'sttLatencyMs'
    | 'translationLatencyMs'
    | 'startOffsetMs'
    | 'endOffsetMs'
    | 'startedAt'
  >
>;

const SEGMENT_COLUMNS: Record<keyof SegmentPatch, string> = {
  speakerId: 'speaker_id',
  originalText: 'original_text',
  translatedText: 'translated_text',
  status: 'status',
  error: 'error',
  language: 'language',
  originalEdited: 'original_edited',
  translationEdited: 'translation_edited',
  overlap: 'overlap',
  sttLatencyMs: 'stt_latency_ms',
  translationLatencyMs: 'translation_latency_ms',
  startOffsetMs: 'start_offset_ms',
  endOffsetMs: 'end_offset_ms',
  startedAt: 'started_at',
};

/** Lớp truy cập dữ liệu cho Meeting – Speaker – TranscriptSegment – AudioChunk. */
export class TranscriptRepository {
  constructor(private readonly db: Db) {}

  // ---------- Meetings ----------
  createMeeting(m: NewMeeting): Meeting {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO meetings (id, owner_id, title, context, glossary, source_language, target_language, status,
          stt_provider, translation_provider, diarization_mode, store_audio, is_demo, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.ownerId,
        m.title,
        m.context ?? '',
        m.glossary ?? '',
        m.sourceLanguage ?? 'auto',
        m.targetLanguage ?? 'vi',
        m.sttProvider,
        m.translationProvider,
        m.diarizationMode,
        m.storeAudio ? 1 : 0,
        m.isDemo ? 1 : 0,
        t,
        t,
        t,
      );
    return this.getMeeting(id)!;
  }

  getMeeting(id: string): Meeting | null {
    const r = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined;
    return r ? toMeeting(r) : null;
  }

  getMeetingOwner(id: string): string | null {
    const r = this.db.prepare('SELECT owner_id FROM meetings WHERE id = ?').get(id) as Row | undefined;
    return r?.owner_id ?? null;
  }

  listMeetings(ownerId: string, search?: string): Meeting[] {
    const base = `SELECT m.*, (SELECT COUNT(*) FROM transcript_segments s WHERE s.meeting_id = m.id) AS segment_count
                  FROM meetings m WHERE m.owner_id = ?`;
    if (search?.trim()) {
      const q = `%${search.trim().replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      return (
        this.db
          .prepare(
            `${base} AND (m.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM transcript_segments s WHERE s.meeting_id = m.id
               AND (s.original_text LIKE ? ESCAPE '\\' OR s.translated_text LIKE ? ESCAPE '\\'))) ORDER BY m.started_at DESC LIMIT 200`,
          )
          .all(ownerId, q, q, q) as Row[]
      ).map(toMeeting);
    }
    return (this.db.prepare(`${base} ORDER BY m.started_at DESC LIMIT 200`).all(ownerId) as Row[]).map(toMeeting);
  }

  updateMeeting(
    id: string,
    patch: Partial<Pick<Meeting, 'title' | 'context' | 'glossary' | 'sourceLanguage' | 'status' | 'endedAt'>>,
  ): Meeting {
    const map: Record<string, string> = {
      title: 'title',
      context: 'context',
      glossary: 'glossary',
      sourceLanguage: 'source_language',
      status: 'status',
      endedAt: 'ended_at',
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(v);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      vals.push(now(), id);
      this.db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.getMeeting(id)!;
  }

  setMeetingStatus(id: string, status: MeetingStatus): Meeting {
    return this.updateMeeting(id, { status, endedAt: status === 'ended' ? now() : undefined });
  }

  deleteMeeting(id: string): void {
    this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }

  getSummary(id: string): MeetingSummary | null {
    const r = this.db.prepare('SELECT summary_json FROM meetings WHERE id = ?').get(id) as Row | undefined;
    return r?.summary_json ? (JSON.parse(r.summary_json) as MeetingSummary) : null;
  }

  saveSummary(id: string, summary: MeetingSummary): void {
    this.db.prepare('UPDATE meetings SET summary_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(summary), now(), id);
  }

  /** Các cuộc họp kết thúc trước mốc thời gian (phục vụ chính sách lưu trữ). */
  listMeetingsEndedBefore(iso: string): string[] {
    return (this.db.prepare("SELECT id FROM meetings WHERE status = 'ended' AND ended_at < ?").all(iso) as Row[]).map((r) => r.id);
  }

  // ---------- Speakers ----------
  listSpeakers(meetingId: string): Speaker[] {
    return (this.db.prepare('SELECT * FROM speakers WHERE meeting_id = ? ORDER BY created_at, label').all(meetingId) as Row[]).map(
      toSpeaker,
    );
  }

  getSpeaker(id: string): Speaker | null {
    const r = this.db.prepare('SELECT * FROM speakers WHERE id = ?').get(id) as Row | undefined;
    return r ? toSpeaker(r) : null;
  }

  findSpeakerBySource(meetingId: string, sourceId: string): Speaker | null {
    const r = this.db.prepare('SELECT * FROM speakers WHERE meeting_id = ? AND source_id = ?').get(meetingId, sourceId) as Row | undefined;
    return r ? toSpeaker(r) : null;
  }

  /** Tạo người nói mới với nhãn kế tiếp (A, B, C...) theo thứ tự phát hiện. */
  createSpeaker(meetingId: string, opts: { sourceId?: string; displayName?: string | null } = {}): Speaker {
    return transaction(this.db, () => {
      const count = (this.db.prepare('SELECT COUNT(*) AS c FROM speakers WHERE meeting_id = ?').get(meetingId) as Row).c as number;
      const id = crypto.randomUUID();
      this.db
        .prepare('INSERT INTO speakers (id, meeting_id, label, display_name, color_index, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, meetingId, speakerLabelForIndex(count), opts.displayName ?? null, count, opts.sourceId ?? null, now());
      return this.getSpeaker(id)!;
    });
  }

  renameSpeaker(id: string, displayName: string | null): Speaker {
    this.db.prepare('UPDATE speakers SET display_name = ? WHERE id = ?').run(displayName?.trim() || null, id);
    return this.getSpeaker(id)!;
  }

  /** Gộp người nói `fromId` vào `intoId`: chuyển toàn bộ lượt phát biểu rồi xóa `fromId`. */
  mergeSpeakers(meetingId: string, fromId: string, intoId: string): number {
    return transaction(this.db, () => {
      const res = this.db
        .prepare('UPDATE transcript_segments SET speaker_id = ?, updated_at = ? WHERE meeting_id = ? AND speaker_id = ?')
        .run(intoId, now(), meetingId, fromId);
      this.db.prepare('DELETE FROM speakers WHERE id = ? AND meeting_id = ?').run(fromId, meetingId);
      return Number(res.changes);
    });
  }

  // ---------- Audio chunks ----------
  /** Trả về false nếu chunk đã tồn tại (gửi lại sau khi mất kết nối) – không xử lý lần hai. */
  insertChunk(c: { id: string; meetingId: string; sourceId: string; startOffsetMs: number; durationMs: number }): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO audio_chunks (id, meeting_id, source_id, start_offset_ms, duration_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(c.id, c.meetingId, c.sourceId, c.startOffsetMs, c.durationMs, now());
    return Number(res.changes) > 0;
  }

  getChunkMeeting(chunkId: string): string | null {
    const r = this.db.prepare('SELECT meeting_id FROM audio_chunks WHERE id = ?').get(chunkId) as Row | undefined;
    return r?.meeting_id ?? null;
  }

  updateChunk(id: string, patch: { status?: string; error?: string | null; audioPath?: string | null }): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status));
    if (patch.error !== undefined) (sets.push('error = ?'), vals.push(patch.error));
    if (patch.audioPath !== undefined) (sets.push('audio_path = ?'), vals.push(patch.audioPath));
    if (!sets.length) return;
    this.db.prepare(`UPDATE audio_chunks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  listChunkAudioPaths(meetingId: string): string[] {
    return (this.db.prepare('SELECT audio_path FROM audio_chunks WHERE meeting_id = ? AND audio_path IS NOT NULL').all(meetingId) as Row[]).map(
      (r) => r.audio_path,
    );
  }

  // ---------- Segments ----------
  createSegment(s: NewSegment): Segment {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO transcript_segments (id, meeting_id, chunk_id, sub_index, speaker_id, source_id, start_offset_ms, end_offset_ms,
          started_at, language, original_text, translated_text, status, overlap, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        s.meetingId,
        s.chunkId,
        s.subIndex,
        s.speakerId,
        s.sourceId,
        Math.round(s.startOffsetMs),
        Math.round(s.endOffsetMs),
        s.startedAt,
        s.language ?? null,
        s.originalText ?? '',
        s.translatedText ?? '',
        s.status,
        s.overlap ? 1 : 0,
        t,
        t,
      );
    return this.getSegment(id)!;
  }

  getSegment(id: string): Segment | null {
    const r = this.db.prepare('SELECT * FROM transcript_segments WHERE id = ?').get(id) as Row | undefined;
    return r ? toSegment(r) : null;
  }

  updateSegment(id: string, patch: SegmentPatch): Segment {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch) as Array<[keyof SegmentPatch, any]>) {
      if (v === undefined) continue;
      sets.push(`${SEGMENT_COLUMNS[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? Math.round(v) : v);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      vals.push(now(), id);
      this.db.prepare(`UPDATE transcript_segments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.getSegment(id)!;
  }

  deleteSegment(id: string): void {
    this.db.prepare('DELETE FROM transcript_segments WHERE id = ?').run(id);
  }

  listSegments(meetingId: string): Segment[] {
    return (
      this.db
        .prepare('SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_offset_ms, sub_index, created_at')
        .all(meetingId) as Row[]
    ).map(toSegment);
  }

  /** N lượt đã hoàn tất ngay trước thời điểm cho trước – làm ngữ cảnh dịch (không gửi lại toàn bộ transcript). */
  contextBefore(meetingId: string, beforeOffsetMs: number, excludeId: string, limit: number): Segment[] {
    if (limit <= 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM transcript_segments WHERE meeting_id = ? AND id != ? AND status = 'final' AND start_offset_ms <= ?
           ORDER BY start_offset_ms DESC, sub_index DESC LIMIT ?`,
        )
        .all(meetingId, excludeId, beforeOffsetMs, limit) as Row[]
    )
      .map(toSegment)
      .reverse();
  }

  segmentsByStatus(meetingId: string, statuses: SegmentStatus[]): Segment[] {
    const q = statuses.map(() => '?').join(',');
    return (
      this.db.prepare(`SELECT * FROM transcript_segments WHERE meeting_id = ? AND status IN (${q})`).all(meetingId, ...statuses) as Row[]
    ).map(toSegment);
  }

  /**
   * Phục hồi sau khi máy chủ khởi động lại: các đoạn đang xử lý dở được đánh dấu lỗi để người dùng
   * thấy rõ và có thể thử lại (đoạn đã có văn bản gốc có thể dịch lại).
   */
  recoverInterruptedWork(): number {
    const t = now();
    const res = this.db
      .prepare(
        `UPDATE transcript_segments SET status = 'error', error = 'Máy chủ khởi động lại khi đang xử lý đoạn này', updated_at = ?
         WHERE status IN ('transcribing','translating')`,
      )
      .run(t);
    this.db.prepare(`UPDATE audio_chunks SET status = 'error', error = 'interrupted' WHERE status IN ('queued','processing')`).run();
    return Number(res.changes);
  }
}
