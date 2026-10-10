import fs from 'node:fs';
import path from 'node:path';
import type { AudioChunkHeader, Meeting, PipelineStats, Segment, ServerMessage, Speaker } from '@amt/shared';
import { detectLanguageByScript, speakerDisplayName } from '@amt/shared';
import { ProviderError, classifyError } from '../ai-provider-manager/errors';
import { Limiter, throttle, withRetry } from '../ai-provider-manager/retry';
import type { ISpeakerDiarizationProvider, ITranscriptionProvider, ITranslationProvider } from '../ai-provider-manager/types';
import { pcmRms, pcmToWav } from '../audio/wav';
import type { ResolvedSettings } from '../settings/settings-service';
import type { TranscriptRepository } from '../transcript-manager/repository';

export interface SessionClient {
  id: string;
  userId: string;
  send(msg: ServerMessage): void;
}

export interface ProviderBundle {
  stt: ITranscriptionProvider;
  translator: ITranslationProvider;
  diarizer: ISpeakerDiarizationProvider;
  settings: ResolvedSettings;
}

export type ProviderFactory = (meeting: Meeting, onSpeaker: (s: Speaker) => void) => ProviderBundle;

export interface SessionDeps {
  repo: TranscriptRepository;
  createProviders: ProviderFactory;
  resolveSettings: () => ResolvedSettings;
  audioDir: string;
  log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
  onDisposed?: (meetingId: string) => void;
}

/** Câu "ảo giác" phổ biến của Whisper khi gặp đoạn gần như im lặng. */
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so much|for watching))?[.!]?$/i,
  /^(bye|you)[.!]?$/i,
  /subtitles? by|amara\.org|please subscribe/i,
];

const MIN_CHUNK_MS = 250;
const MAX_CHUNK_MS = 60_000;
const MAX_RETAINED_FAILED_CHUNKS = 50;

interface RetainedChunk {
  header: AudioChunkHeader;
  pcm: Int16Array;
  startOffsetMs: number;
  placeholderId: string;
}

/**
 * Một phiên họp đang hoạt động trên máy chủ. Mỗi cuộc họp có một phiên độc lập
 * (hàng đợi, giới hạn đồng thời, bộ đếm độ trễ, kết nối WebSocket riêng).
 */
export class MeetingSession {
  meeting: Meeting;
  readonly clients = new Set<SessionClient>();
  private abort = new AbortController();
  private sttLimiter: Limiter;
  private trLimiter: Limiter;
  private pendingTranslations = 0;
  private readonly retained = new Map<string, RetainedChunk>();
  private bundle: ProviderBundle | null = null;
  private bundleError: ProviderError | null = null;
  private ending = false;
  private idleWaiters: Array<() => void> = [];
  private sttLatencies: number[] = [];
  private trLatencies: number[] = [];
  private stats: PipelineStats = {
    queuedChunks: 0,
    processingChunks: 0,
    pendingTranslations: 0,
    errors: 0,
    avgSttLatencyMs: null,
    avgTranslationLatencyMs: null,
    lastSttLatencyMs: null,
    lastTranslationLatencyMs: null,
    aiStatus: 'unknown',
    aiStatusMessage: null,
  };
  private demoRunning = false;
  private disposeTimer: NodeJS.Timeout | null = null;

  constructor(
    meeting: Meeting,
    private readonly deps: SessionDeps,
  ) {
    this.meeting = meeting;
    this.sttLimiter = new Limiter(1);
    this.trLimiter = new Limiter(1);
    this.reloadProviders();
  }

  // ------------------------------------------------------------------ providers
  /** Tạo lại provider theo cấu hình hiện tại (khi người dùng đổi Cài đặt AI). */
  reloadProviders(): void {
    if (this.meeting.isDemo) return;
    try {
      this.bundle = this.deps.createProviders(this.meeting, (s) => this.broadcast({ type: 'speaker', speaker: s }));
      this.bundleError = null;
      const p = this.bundle.settings.pipeline;
      // Diarization OpenAI cần xử lý tuần tự để nhãn người nói nhất quán giữa các đoạn.
      this.sttLimiter.concurrency = this.meeting.diarizationMode === 'openai' ? 1 : p.sttConcurrency;
      this.trLimiter.concurrency = p.translationConcurrency;
    } catch (err) {
      this.bundle = null;
      this.bundleError = classifyError(err, 'config');
      this.setAiStatus('down', this.bundleError.message);
    }
  }

  // ------------------------------------------------------------------ clients
  attach(client: SessionClient, serverNow = Date.now()): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.clients.add(client);
    client.send({
      type: 'snapshot',
      meeting: this.meeting,
      speakers: this.deps.repo.listSpeakers(this.meeting.id),
      segments: this.deps.repo.listSegments(this.meeting.id),
      serverNow,
      stats: this.snapshotStats(),
    });
    if (this.bundleError) client.send({ type: 'error', code: this.bundleError.code, message: this.bundleError.message, hint: this.bundleError.hint });
  }

  detach(client: SessionClient): void {
    this.clients.delete(client);
    this.scheduleDisposeIfIdle();
  }

  broadcast(msg: ServerMessage): void {
    for (const c of this.clients) {
      try {
        c.send(msg);
      } catch {
        /* client đã đóng */
      }
    }
  }

  private send(client: SessionClient | undefined, msg: ServerMessage) {
    if (client) client.send(msg);
    else this.broadcast(msg);
  }

  // ------------------------------------------------------------------ state
  get pendingWork(): number {
    return this.sttLimiter.running + this.sttLimiter.pending + this.pendingTranslations;
  }

  get isEnded(): boolean {
    return this.meeting.status === 'ended';
  }

  pause(): void {
    if (this.isEnded) return;
    this.meeting = this.deps.repo.setMeetingStatus(this.meeting.id, 'paused');
    this.broadcast({ type: 'meeting', meeting: this.meeting });
  }

  resume(): void {
    if (this.isEnded) return;
    this.meeting = this.deps.repo.setMeetingStatus(this.meeting.id, 'active');
    this.broadcast({ type: 'meeting', meeting: this.meeting });
  }

  /**
   * Kết thúc cuộc họp.
   *  - ask: nếu còn đoạn chưa xử lý → báo client để người dùng chọn.
   *  - drain: ngừng nhận âm thanh mới, chờ xử lý xong các đoạn còn lại rồi kết thúc.
   *  - abort: hủy các yêu cầu AI đang chạy, đánh dấu rõ các đoạn bị hủy rồi kết thúc.
   */
  async end(mode: 'ask' | 'drain' | 'abort', requester?: SessionClient): Promise<'pending' | 'ended'> {
    if (this.isEnded) {
      this.send(requester, { type: 'ended', meeting: this.meeting });
      return 'ended';
    }
    if (mode === 'ask' && this.pendingWork > 0) {
      this.send(requester, { type: 'end_pending', pending: this.pendingWork });
      return 'pending';
    }
    this.ending = true;
    if (mode === 'abort') {
      this.abort.abort();
      for (const seg of this.deps.repo.segmentsByStatus(this.meeting.id, ['transcribing', 'translating'])) {
        this.emitSegment(this.deps.repo.updateSegment(seg.id, { status: 'error', error: 'Đã hủy do kết thúc cuộc họp trước khi xử lý xong' }));
      }
    }
    await this.waitIdle();
    this.retained.clear();
    this.meeting = this.deps.repo.setMeetingStatus(this.meeting.id, 'ended');
    this.broadcast({ type: 'ended', meeting: this.meeting });
    this.dispose();
    return 'ended';
  }

  private waitIdle(): Promise<void> {
    if (this.pendingWork === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private checkIdle() {
    this.pushStats();
    if (this.pendingWork === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((fn) => fn());
      this.scheduleDisposeIfIdle();
    }
  }

  private scheduleDisposeIfIdle() {
    if (this.clients.size || this.pendingWork || this.demoRunning || this.disposeTimer) return;
    // Giải phóng bộ nhớ khi không còn ai kết nối; cuộc họp vẫn còn trong DB và mở lại được.
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      if (!this.clients.size && !this.pendingWork && !this.demoRunning) this.dispose();
    }, 10 * 60_000);
    this.disposeTimer.unref?.();
  }

  /** Máy chủ đang tắt: hủy mọi yêu cầu AI đang chạy (đoạn dở dang sẽ được đánh dấu khi khởi động lại). */
  shutdown() {
    this.ending = true;
    this.abort.abort();
    if (this.statsTimer) clearTimeout(this.statsTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.clients.clear();
  }

  dispose() {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.deps.onDisposed?.(this.meeting.id);
  }

  // ------------------------------------------------------------------ audio
  /** Nhận một đoạn âm thanh. Đoạn đã nhận trước đó (gửi lại sau khi rớt mạng) chỉ được xác nhận, không xử lý lại. */
  handleChunk(header: AudioChunkHeader, pcm: Int16Array, client?: SessionClient): void {
    if (this.isEnded || this.ending) {
      this.send(client, { type: 'error', code: 'meeting_ended', message: 'Cuộc họp đã kết thúc, không nhận thêm âm thanh' });
      return;
    }
    if (this.meeting.isDemo) {
      this.send(client, { type: 'error', code: 'demo', message: 'Cuộc họp demo không xử lý âm thanh thật. Hãy tạo cuộc họp thường.' });
      return;
    }
    if (typeof header.chunkId !== 'string' || !/^[0-9a-f-]{36}$/i.test(header.chunkId)) {
      this.send(client, { type: 'error', code: 'bad_chunk', message: 'Mã đoạn âm thanh không hợp lệ' });
      return;
    }
    const durationMs = Math.round((pcm.length / header.sampleRate) * 1000);
    if (durationMs < MIN_CHUNK_MS || durationMs > MAX_CHUNK_MS) {
      this.send(client, { type: 'chunk_ack', chunkId: header.chunkId, duplicate: false });
      return;
    }
    const startOffsetMs = Math.max(0, header.capturedAt - Date.parse(this.meeting.startedAt));
    const sourceId = String(header.sourceId ?? 'unknown').slice(0, 120);
    const inserted = this.deps.repo.insertChunk({ id: header.chunkId, meetingId: this.meeting.id, sourceId, startOffsetMs, durationMs });
    if (!inserted) {
      this.send(client, { type: 'chunk_ack', chunkId: header.chunkId, duplicate: true });
      return;
    }
    const placeholder = this.deps.repo.createSegment({
      meetingId: this.meeting.id,
      chunkId: header.chunkId,
      subIndex: 0,
      speakerId: null,
      sourceId,
      startOffsetMs,
      endOffsetMs: startOffsetMs + durationMs,
      startedAt: new Date(Date.parse(this.meeting.startedAt) + startOffsetMs).toISOString(),
      status: 'transcribing',
    });
    this.emitSegment(placeholder);
    this.send(client, { type: 'chunk_ack', chunkId: header.chunkId, duplicate: false });

    if (this.meeting.storeAudio) this.storeAudio(header.chunkId, pcm, header.sampleRate);
    this.retained.set(header.chunkId, { header: { ...header, sourceId }, pcm, startOffsetMs, placeholderId: placeholder.id });
    this.enqueueChunk(header.chunkId);
  }

  private storeAudio(chunkId: string, pcm: Int16Array, sampleRate: number) {
    try {
      const dir = path.join(this.deps.audioDir, this.meeting.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${chunkId}.wav`);
      fs.writeFileSync(file, pcmToWav(pcm, sampleRate));
      this.deps.repo.updateChunk(chunkId, { audioPath: file });
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'Không lưu được file âm thanh');
    }
  }

  private enqueueChunk(chunkId: string) {
    this.pushStats();
    void this.sttLimiter
      .run(() => this.processChunk(chunkId))
      .catch((err) => this.deps.log.error({ err: (err as Error).message }, 'processChunk lỗi ngoài dự kiến'))
      .finally(() => this.checkIdle());
  }

  private async processChunk(chunkId: string): Promise<void> {
    const item = this.retained.get(chunkId);
    if (!item) return;
    const signal = this.abort.signal;
    if (signal.aborted) return;
    const repo = this.deps.repo;
    this.pushStats();

    if (!this.bundle) {
      const e = this.bundleError ?? new ProviderError('config', 'Chưa cấu hình nhà cung cấp AI', { provider: 'config', retryable: false });
      this.failChunk(item, e);
      return;
    }
    const { stt, diarizer, settings } = this.bundle;
    repo.updateChunk(chunkId, { status: 'processing' });

    const input = {
      meetingId: this.meeting.id,
      chunkId,
      sourceId: item.header.sourceId,
      sourceLabel: item.header.sourceLabel ?? '',
      pcm: item.pcm,
      sampleRate: item.header.sampleRate,
      durationMs: Math.round((item.pcm.length / item.header.sampleRate) * 1000),
    };
    const previous = repo.contextBefore(this.meeting.id, item.startOffsetMs, item.placeholderId, 1)[0];
    const partial = throttle((text: string) => {
      const seg = repo.getSegment(item.placeholderId);
      if (seg) this.broadcast({ type: 'segment', segment: { ...seg, originalText: text, interim: true } });
    }, 120);

    const t0 = Date.now();
    let result;
    try {
      const extra = await diarizer.prepare(input);
      const wav = pcmToWav(item.pcm, item.header.sampleRate);
      result = await withRetry(
        (sig) =>
          stt.transcribe({
            wav,
            durationMs: input.durationMs,
            language: this.meeting.sourceLanguage,
            prompt: previous?.originalText,
            signal: sig,
            onPartial: partial,
            ...extra,
          }),
        {
          provider: stt.id,
          retries: settings.pipeline.maxRetries,
          timeoutMs: settings.pipeline.requestTimeoutMs,
          signal,
          onRetry: (n, e) => this.setAiStatus('degraded', `${e.message} – đang thử lại (${n})`),
        },
      );
    } catch (err) {
      partial.cancel();
      const pe = classifyError(err, stt.id);
      if (pe.code !== 'aborted') this.failChunk(item, pe);
      return;
    }
    partial.cancel();
    const sttLatency = Date.now() - t0;
    this.recordLatency('stt', sttLatency);
    this.setAiStatus('ok', null);

    const text = result.text.trim();
    if (!text || (input.durationMs < 3000 && HALLUCINATIONS.some((r) => r.test(text)) && pcmRms(item.pcm) < 0.02)) {
      // Không có lời nói → bỏ đoạn tạm, không tạo bản ghi rỗng.
      repo.deleteSegment(item.placeholderId);
      repo.updateChunk(chunkId, { status: 'empty' });
      this.broadcast({ type: 'segment_removed', segmentId: item.placeholderId });
      this.retained.delete(chunkId);
      return;
    }

    const assignments = (await diarizer.assign(input, result)).filter((a) => a.text.trim());
    if (!assignments.length) {
      repo.deleteSegment(item.placeholderId);
      repo.updateChunk(chunkId, { status: 'empty' });
      this.broadcast({ type: 'segment_removed', segmentId: item.placeholderId });
      this.retained.delete(chunkId);
      return;
    }

    const baseIso = Date.parse(this.meeting.startedAt);
    const created: Segment[] = [];
    assignments.forEach((a, i) => {
      const startOffsetMs = item.startOffsetMs + a.startMs;
      const language =
        result.language ?? (this.meeting.sourceLanguage !== 'auto' ? this.meeting.sourceLanguage : detectLanguageByScript(a.text));
      const fields = {
        speakerId: a.speakerId,
        originalText: a.text,
        language,
        overlap: a.overlap,
        startOffsetMs,
        endOffsetMs: item.startOffsetMs + a.endMs,
        startedAt: new Date(baseIso + startOffsetMs).toISOString(),
        sttLatencyMs: sttLatency,
        status: 'translating' as const,
        error: null,
      };
      // Đoạn đầu tiên cập nhật bản ghi tạm (cùng ID) → không tạo bản ghi trùng lặp.
      const seg =
        i === 0
          ? repo.updateSegment(item.placeholderId, fields)
          : repo.updateSegment(
              repo.createSegment({
                meetingId: this.meeting.id,
                chunkId,
                subIndex: i,
                speakerId: a.speakerId,
                sourceId: item.header.sourceId,
                startOffsetMs,
                endOffsetMs: fields.endOffsetMs,
                startedAt: fields.startedAt,
                status: 'translating',
              }).id,
              fields,
            );
      created.push(seg);
      this.emitSegment(seg);
    });
    repo.updateChunk(chunkId, { status: 'done' });
    this.retained.delete(chunkId);
    for (const seg of created) this.enqueueTranslation(seg.id);
  }

  private failChunk(item: RetainedChunk, pe: ProviderError) {
    this.stats.errors++;
    this.deps.repo.updateChunk(item.header.chunkId, { status: 'error', error: pe.code });
    const seg = this.deps.repo.updateSegment(item.placeholderId, { status: 'error', error: `Nhận dạng thất bại: ${pe.message}` });
    this.emitSegment(seg);
    this.reportError(pe, seg.id);
    // Giữ lại âm thanh (giới hạn số lượng) để người dùng bấm "Thử lại".
    if (this.retained.size > MAX_RETAINED_FAILED_CHUNKS) {
      const oldest = this.retained.keys().next().value;
      if (oldest) this.retained.delete(oldest);
    }
  }

  // ------------------------------------------------------------------ translation
  private enqueueTranslation(segmentId: string) {
    this.pendingTranslations++;
    this.pushStats();
    void this.trLimiter
      .run(() => this.translateSegment(segmentId))
      .catch((err) => this.deps.log.error({ err: (err as Error).message }, 'translateSegment lỗi ngoài dự kiến'))
      .finally(() => {
        this.pendingTranslations--;
        this.checkIdle();
      });
  }

  private async translateSegment(segmentId: string): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return;
    const repo = this.deps.repo;
    let seg = repo.getSegment(segmentId);
    if (!seg || !seg.originalText.trim()) return;

    // Văn bản đã là ngôn ngữ đích → không cần gọi AI.
    if (seg.language === this.meeting.targetLanguage) {
      this.emitSegment(repo.updateSegment(seg.id, { translatedText: seg.originalText, status: 'final', error: null, translationLatencyMs: 0 }));
      return;
    }
    if (!this.bundle) {
      const e = this.bundleError ?? new ProviderError('config', 'Chưa cấu hình nhà cung cấp dịch', { provider: 'config', retryable: false });
      this.emitSegment(repo.updateSegment(seg.id, { status: 'error', error: `Dịch thất bại: ${e.message}` }));
      this.reportError(e, seg.id);
      return;
    }
    const { translator, settings } = this.bundle;
    if (seg.status !== 'translating') seg = repo.updateSegment(seg.id, { status: 'translating', error: null });
    this.emitSegment(seg);

    const speakerName = (id: string | null) => speakerDisplayName(id ? repo.getSpeaker(id) : null);
    const context = repo
      .contextBefore(this.meeting.id, seg.startOffsetMs, seg.id, settings.pipeline.contextSegments)
      .map((c) => ({ speaker: speakerName(c.speakerId), original: c.originalText, translated: c.translatedText }));
    const base = seg;
    const partial = throttle((text: string) => this.broadcast({ type: 'segment', segment: { ...base, translatedText: text, interim: true } }), 120);

    const t0 = Date.now();
    try {
      const translated = await withRetry(
        (sig) =>
          translator.translate({
            text: base.originalText,
            sourceLanguage: base.language,
            targetLanguage: this.meeting.targetLanguage,
            speaker: speakerName(base.speakerId),
            context,
            meetingContext: this.meeting.context,
            glossary: [settings.pipeline.glossary, this.meeting.glossary].filter((g) => g.trim()).join('\n'),
            signal: sig,
            onPartial: partial,
          }),
        {
          provider: translator.id,
          retries: settings.pipeline.maxRetries,
          timeoutMs: settings.pipeline.requestTimeoutMs,
          signal,
          onRetry: (n, e) => this.setAiStatus('degraded', `${e.message} – đang thử lại (${n})`),
        },
      );
      partial.cancel();
      const latency = Date.now() - t0;
      this.recordLatency('translation', latency);
      this.setAiStatus('ok', null);
      // Người dùng có thể đã sửa tay bản dịch trong lúc chờ → không ghi đè.
      const current = repo.getSegment(seg.id);
      if (!current) return;
      this.emitSegment(
        repo.updateSegment(seg.id, {
          translatedText: current.translationEdited ? current.translatedText : translated,
          status: 'final',
          error: null,
          translationLatencyMs: latency,
        }),
      );
    } catch (err) {
      partial.cancel();
      const pe = classifyError(err, translator.id);
      if (pe.code === 'aborted') return;
      this.stats.errors++;
      this.emitSegment(repo.updateSegment(seg.id, { status: 'error', error: `Dịch thất bại: ${pe.message}` }));
      this.reportError(pe, seg.id);
    }
  }

  /** Thử lại một lượt lỗi: dịch lại nếu đã có văn bản gốc, hoặc nhận dạng lại nếu còn giữ âm thanh. */
  retrySegment(segmentId: string, client?: SessionClient): void {
    const seg = this.deps.repo.getSegment(segmentId);
    if (!seg || seg.meetingId !== this.meeting.id) return;
    if (this.isEnded && !seg.originalText.trim()) {
      this.send(client, { type: 'error', code: 'retry', message: 'Cuộc họp đã kết thúc, không thể nhận dạng lại âm thanh' });
      return;
    }
    if (seg.originalText.trim()) {
      this.retranslate(segmentId);
      return;
    }
    const chunk = seg.chunkId ? this.retained.get(seg.chunkId) : undefined;
    if (!chunk) {
      this.send(client, {
        type: 'error',
        code: 'retry',
        message: 'Không còn dữ liệu âm thanh của đoạn này để nhận dạng lại',
        hint: 'Âm thanh chỉ được giữ tạm trong bộ nhớ trong phiên họp (trừ khi bật lưu âm thanh).',
      });
      return;
    }
    this.emitSegment(this.deps.repo.updateSegment(segmentId, { status: 'transcribing', error: null }));
    this.enqueueChunk(chunk.header.chunkId);
  }

  /** Dịch lại một lượt (sau khi người dùng sửa văn bản gốc). */
  retranslate(segmentId: string): void {
    if (this.meeting.isDemo) return;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.deps.repo.updateSegment(segmentId, { translationEdited: false });
    this.enqueueTranslation(segmentId);
  }

  // ------------------------------------------------------------------ helpers
  emitSegment(seg: Segment) {
    this.broadcast({ type: 'segment', segment: seg });
  }

  private reportError(pe: ProviderError, segmentId?: string) {
    if (['auth', 'quota', 'config', 'unsupported'].includes(pe.code)) this.setAiStatus('down', pe.message);
    else this.setAiStatus('degraded', pe.message);
    this.broadcast({ type: 'error', code: pe.code, message: pe.message, hint: pe.hint, segmentId });
    this.deps.log.warn({ meetingId: this.meeting.id, code: pe.code, provider: pe.provider }, 'Lỗi nhà cung cấp AI');
  }

  private setAiStatus(status: PipelineStats['aiStatus'], message: string | null) {
    if (this.stats.aiStatus === status && this.stats.aiStatusMessage === message) return;
    this.stats.aiStatus = status;
    this.stats.aiStatusMessage = message;
    this.pushStats();
  }

  private recordLatency(kind: 'stt' | 'translation', ms: number) {
    const arr = kind === 'stt' ? this.sttLatencies : this.trLatencies;
    arr.push(ms);
    if (arr.length > 20) arr.shift();
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    if (kind === 'stt') (this.stats.lastSttLatencyMs = ms), (this.stats.avgSttLatencyMs = avg);
    else (this.stats.lastTranslationLatencyMs = ms), (this.stats.avgTranslationLatencyMs = avg);
  }

  snapshotStats(): PipelineStats {
    return {
      ...this.stats,
      queuedChunks: this.sttLimiter.pending,
      processingChunks: this.sttLimiter.running,
      pendingTranslations: this.pendingTranslations,
    };
  }

  private statsTimer: NodeJS.Timeout | null = null;
  private pushStats() {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.broadcast({ type: 'stats', stats: this.snapshotStats() });
    }, 100);
    this.statsTimer.unref?.();
  }

  // ------------------------------------------------------------------ demo
  get signal() {
    return this.abort.signal;
  }

  setDemoRunning(v: boolean) {
    this.demoRunning = v;
    if (!v) this.scheduleDisposeIfIdle();
  }
  get isDemoRunning() {
    return this.demoRunning;
  }
  get isEnding() {
    return this.ending;
  }
}
