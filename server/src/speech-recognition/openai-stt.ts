import OpenAI, { toFile } from 'openai';
import type { Stream } from 'openai/core/streaming';
import type { TranscriptionDiarized, TranscriptionStreamEvent, TranscriptionVerbose } from 'openai/resources/audio/transcriptions';
import { ProviderError } from '../ai-provider-manager/errors';
import type { ITranscriptionProvider, TranscriptionCapabilities, TranscriptionRequest, TranscriptionResult } from '../ai-provider-manager/types';
import { normalizeLanguage } from './language';

interface ModelInfo extends TranscriptionCapabilities {
  prompt: boolean;
  keywords: boolean;
}

/**
 * Khả năng thực tế của từng model STT của OpenAI (theo tài liệu API). Không giả định model nào cũng
 * hỗ trợ streaming/diarization. Model lạ được xử lý theo chế độ an toàn nhất (json, không streaming).
 */
export const OPENAI_STT_MODELS: Record<string, ModelInfo> = {
  'gpt-transcribe': { streaming: true, diarization: false, languageDetection: true, prompt: false, keywords: true },
  'gpt-4o-transcribe': { streaming: true, diarization: false, languageDetection: false, prompt: true, keywords: false },
  'gpt-4o-mini-transcribe': { streaming: true, diarization: false, languageDetection: false, prompt: true, keywords: false },
  'gpt-4o-mini-transcribe-2025-12-15': { streaming: true, diarization: false, languageDetection: false, prompt: true, keywords: false },
  'whisper-1': { streaming: false, diarization: false, languageDetection: true, prompt: true, keywords: false },
  'gpt-4o-transcribe-diarize': { streaming: false, diarization: true, languageDetection: false, prompt: false, keywords: false },
};

export const OPENAI_DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';

const FALLBACK_INFO: ModelInfo = { streaming: false, diarization: false, languageDetection: false, prompt: false, keywords: false };

export class OpenAITranscriptionProvider implements ITranscriptionProvider {
  readonly id = 'openai';
  readonly capabilities: TranscriptionCapabilities;
  private readonly info: ModelInfo;
  private readonly client: OpenAI;

  constructor(
    opts: { apiKey: string; baseUrl: string; model: string; keywords?: string[] },
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, maxRetries: 0 });
    this.model = opts.model;
    this.info = OPENAI_STT_MODELS[opts.model] ?? FALLBACK_INFO;
    this.capabilities = { streaming: this.info.streaming, diarization: this.info.diarization, languageDetection: this.info.languageDetection };
    this.keywords = opts.keywords ?? [];
  }
  readonly model: string;
  private readonly keywords: string[];

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const file = await toFile(req.wav, 'chunk.wav', { type: 'audio/wav' });
    const language = req.language && req.language !== 'auto' ? req.language : undefined;
    const reqOpts = { signal: req.signal, maxRetries: 0 };

    if (this.info.diarization) {
      const params: Record<string, unknown> = {
        file,
        model: this.model,
        response_format: 'diarized_json',
        chunking_strategy: 'auto',
        ...(language ? { language } : {}),
      };
      if (req.knownSpeakers?.length) {
        params.known_speaker_names = req.knownSpeakers.map((k) => k.name);
        params.known_speaker_references = req.knownSpeakers.map((k) => k.dataUrl);
      }
      const res = (await this.client.audio.transcriptions.create(params as any, reqOpts)) as unknown as TranscriptionDiarized;
      return {
        text: res.text ?? '',
        language: language ?? null,
        pieces: (res.segments ?? []).map((s) => ({
          speakerTag: s.speaker,
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          text: s.text,
        })),
      };
    }

    const base: Record<string, unknown> = { file, model: this.model };
    if (language) {
      if (this.model === 'gpt-transcribe') base.languages = [language];
      else base.language = language;
    }
    if (this.info.prompt && req.prompt) base.prompt = req.prompt.slice(-800);
    if (this.info.keywords && this.keywords.length) base.keywords = this.keywords.slice(0, 50);

    if (this.info.streaming) {
      const stream = (await this.client.audio.transcriptions.create(
        { ...(base as any), response_format: 'json', stream: true },
        reqOpts,
      )) as unknown as Stream<TranscriptionStreamEvent>;
      let text = '';
      let detected: string | null = null;
      for await (const ev of stream) {
        if (ev.type === 'transcript.text.delta') {
          text += ev.delta;
          req.onPartial?.(text);
        } else if (ev.type === 'transcript.text.done') {
          text = ev.text;
          detected = normalizeLanguage(ev.languages?.[0]?.code);
        }
      }
      return { text: text.trim(), language: language ?? detected };
    }

    if (this.model === 'whisper-1') {
      const res = (await this.client.audio.transcriptions.create(
        { ...(base as any), response_format: 'verbose_json' },
        reqOpts,
      )) as unknown as TranscriptionVerbose;
      return { text: res.text.trim(), language: language ?? normalizeLanguage(res.language) };
    }

    const res = await this.client.audio.transcriptions.create({ ...(base as any), response_format: 'json' }, reqOpts);
    return { text: (res.text ?? '').trim(), language: language ?? normalizeLanguage(res.languages?.[0]?.code) };
  }
}

/**
 * STT chạy local qua máy chủ tương thích API OpenAI (faster-whisper-server/Speaches, LocalAI, vLLM...).
 * Dùng verbose_json để lấy ngôn ngữ; nếu máy chủ không hỗ trợ thì lùi về json.
 */
export class LocalOpenAICompatibleSttProvider implements ITranscriptionProvider {
  readonly id = 'local';
  readonly capabilities: TranscriptionCapabilities = { streaming: false, diarization: false, languageDetection: true };
  private readonly client: OpenAI;
  private verboseSupported = true;

  constructor(opts: { baseUrl: string; model: string; apiKey: string | null }) {
    this.client = new OpenAI({ apiKey: opts.apiKey || 'local-no-key', baseURL: opts.baseUrl, maxRetries: 0 });
    this.model = opts.model;
  }
  readonly model: string;

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const file = await toFile(req.wav, 'chunk.wav', { type: 'audio/wav' });
    const language = req.language && req.language !== 'auto' ? req.language : undefined;
    const params: Record<string, unknown> = { file, model: this.model, ...(language ? { language } : {}) };
    if (req.prompt) params.prompt = req.prompt.slice(-500);
    if (this.verboseSupported) {
      try {
        const res = (await this.client.audio.transcriptions.create(
          { ...(params as any), response_format: 'verbose_json' },
          { signal: req.signal, maxRetries: 0 },
        )) as { text: string; language?: string };
        return { text: (res.text ?? '').trim(), language: language ?? normalizeLanguage(res.language) };
      } catch (err) {
        const status = (err as any)?.status;
        if (status !== 400 && status !== 422) throw err;
        this.verboseSupported = false;
      }
    }
    const res = (await this.client.audio.transcriptions.create(
      { ...(params as any), response_format: 'json' },
      { signal: req.signal, maxRetries: 0 },
    )) as { text: string };
    return { text: (res.text ?? '').trim(), language: language ?? null };
  }
}

/** STT qua máy chủ whisper.cpp (`whisper-server`), endpoint POST /inference. */
export class WhisperCppSttProvider implements ITranscriptionProvider {
  readonly id = 'local';
  readonly capabilities: TranscriptionCapabilities = { streaming: false, diarization: false, languageDetection: true };
  readonly model: string;

  constructor(private readonly opts: { baseUrl: string; model: string; apiKey: string | null }) {
    this.model = opts.model || 'whisper.cpp';
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.wav)], { type: 'audio/wav' }), 'chunk.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('language', req.language && req.language !== 'auto' ? req.language : 'auto');
    if (req.prompt) form.append('prompt', req.prompt.slice(-500));
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/inference';
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: req.signal,
      headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(body.slice(0, 300) || `HTTP ${res.status}`), { status: res.status });
    }
    const data = (await res.json()) as { text?: string; language?: string; error?: string };
    if (data.error) throw new ProviderError('bad_request', `whisper.cpp: ${data.error}`, { provider: 'local', retryable: false });
    return { text: (data.text ?? '').trim(), language: req.language !== 'auto' ? req.language : normalizeLanguage(data.language) };
  }
}
