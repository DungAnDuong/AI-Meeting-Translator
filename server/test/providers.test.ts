import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { classifyError, ProviderError } from '../src/ai-provider-manager/errors';
import { Limiter, withRetry } from '../src/ai-provider-manager/retry';
import { pcmToWav } from '../src/audio/wav';
import { LocalOpenAICompatibleSttProvider, OpenAITranscriptionProvider } from '../src/speech-recognition/openai-stt';
import { OpenAICompatibleTranslator } from '../src/translation-engine/openai-translator';
import { AnthropicTranslator } from '../src/translation-engine/anthropic-translator';
import { cleanTranslation, buildTranslationUserPrompt } from '../src/translation-engine/prompt';
import { makeSpeechPcm, startMockAiServer } from './helpers/mock-ai-server';

let mock: Awaited<ReturnType<typeof startMockAiServer>>;
beforeAll(async () => (mock = await startMockAiServer()));
afterAll(async () => mock.close());
beforeEach(() => {
  mock.state.mode = 'ok';
  mock.state.failOnly = null;
  mock.state.requests = [];
});

const wav = pcmToWav(makeSpeechPcm(1500), 16000);
const signal = () => AbortSignal.timeout(5000);

describe('OpenAI Speech-to-Text adapter', () => {
  it('streams partial text with gpt-4o-transcribe and sends language + prompt', async () => {
    const p = new OpenAITranscriptionProvider({ apiKey: 'sk-test', baseUrl: `${mock.url}/v1`, model: 'gpt-4o-transcribe' });
    const partials: string[] = [];
    const r = await p.transcribe({ wav, durationMs: 1500, language: 'en', prompt: 'previous text', signal: signal(), onPartial: (t) => partials.push(t) });
    expect(r.text).toBe(mock.state.transcript);
    expect(partials.length).toBeGreaterThan(3);
    const req = mock.state.requests[0];
    expect(req.model).toBe('gpt-4o-transcribe');
    expect(req.fields.stream).toBe('true');
    expect(req.fields.language).toBe('en');
    expect(req.fields.prompt).toBe('previous text');
  });

  it('omits language in auto-detect mode', async () => {
    const p = new OpenAITranscriptionProvider({ apiKey: 'sk-test', baseUrl: `${mock.url}/v1`, model: 'gpt-4o-mini-transcribe' });
    await p.transcribe({ wav, durationMs: 1500, language: 'auto', signal: signal() });
    expect(mock.state.requests[0].fields.language).toBeUndefined();
  });

  it('uses diarized_json and known speaker references for gpt-4o-transcribe-diarize', async () => {
    mock.state.diarized = [
      { speaker: 'spk_A', start: 0, end: 2.5, text: 'Hello team.' },
      { speaker: 'A', start: 2.6, end: 5.5, text: 'Hi, I am new here.' },
    ];
    const p = new OpenAITranscriptionProvider({ apiKey: 'sk-test', baseUrl: `${mock.url}/v1`, model: 'gpt-4o-transcribe-diarize' });
    expect(p.capabilities.diarization).toBe(true);
    const r = await p.transcribe({
      wav,
      durationMs: 6000,
      language: 'auto',
      knownSpeakers: [{ name: 'spk_A', dataUrl: 'data:audio/wav;base64,AAAA' }],
      signal: signal(),
    });
    expect(r.pieces).toEqual([
      { speakerTag: 'spk_A', startMs: 0, endMs: 2500, text: 'Hello team.' },
      { speakerTag: 'A', startMs: 2600, endMs: 5500, text: 'Hi, I am new here.' },
    ]);
    const req = mock.state.requests[0];
    expect(req.fields.response_format).toBe('diarized_json');
    expect(req.fields.chunking_strategy).toBe('auto');
    expect(req.fields['known_speaker_names[]']).toBe('spk_A');
  });

  it('local OpenAI-compatible STT returns ISO language from verbose_json', async () => {
    const p = new LocalOpenAICompatibleSttProvider({ baseUrl: `${mock.url}/v1`, model: 'test-stt', apiKey: null });
    const r = await p.transcribe({ wav, durationMs: 1500, language: 'auto', signal: signal() });
    expect(r.language).toBe('en');
    expect(mock.state.requests[0].fields.response_format).toBe('verbose_json');
  });
});

describe('Translation adapters', () => {
  const req = (onPartial?: (t: string) => void) => ({
    text: 'We need to finish the electrical design before Friday.',
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    speaker: 'Speaker A',
    context: [{ speaker: 'Speaker B', original: 'Hello', translated: 'Xin chào' }],
    meetingContext: 'Dự án tủ điện',
    glossary: 'cable tray = máng cáp',
    signal: signal(),
    onPartial,
  });

  it('OpenAI-compatible translator streams and returns cleaned Vietnamese', async () => {
    const t = new OpenAICompatibleTranslator('local', { apiKey: null, baseUrl: `${mock.url}/v1`, model: 'test-llm' });
    const partials: string[] = [];
    const out = await t.translate(req((p) => partials.push(p)));
    expect(out).toBe(mock.state.translation);
    expect(partials.length).toBeGreaterThan(1);
    const body = mock.state.requests[0].body;
    expect(body.messages[0].content).toContain('cable tray = máng cáp');
    expect(body.messages[0].content).toContain('Dự án tủ điện');
    expect(body.messages[1].content).toContain('[Speaker B] Hello  =>  Xin chào');
    expect(body.temperature).toBeUndefined();
  });

  it('Anthropic translator uses effort + server-side fallbacks for supported models', async () => {
    const t = new AnthropicTranslator({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', effort: 'low', useFallbacks: true, baseUrl: mock.url });
    const out = await t.translate(req());
    expect(out).toBe(mock.state.translation);
    const r = mock.state.requests[0];
    expect(r.body.output_config).toEqual({ effort: 'low' });
    expect(r.body.fallbacks).toBe('default');
    expect(r.fields.beta).toContain('server-side-fallback-2026-07-01');
    expect(r.body.thinking).toBeUndefined();
  });

  it('Anthropic translator omits fallbacks for models without support', async () => {
    const t = new AnthropicTranslator({ apiKey: 'sk-ant-test', model: 'claude-haiku-4-5', effort: 'low', useFallbacks: true, baseUrl: mock.url });
    await t.translate(req());
    const r = mock.state.requests[0];
    expect(r.body.fallbacks).toBeUndefined();
    expect(r.body.output_config).toBeUndefined();
  });

  it('builds a prompt that keeps context separate from the utterance', () => {
    const p = buildTranslationUserPrompt({ text: 'Send drawing E-201', context: [], sourceLanguage: null, speaker: 'Speaker A' });
    expect(p).toContain('<utterance>\nSend drawing E-201\n</utterance>');
    expect(p).toContain('the source language');
  });

  it('cleans quotes and labels from model output', () => {
    expect(cleanTranslation('"Xin chào"')).toBe('Xin chào');
    expect(cleanTranslation('Translation: Xin chào')).toBe('Xin chào');
  });
});

describe('Error classification', () => {
  const run = async () => {
    const t = new OpenAICompatibleTranslator('openai', { apiKey: 'sk-bad', baseUrl: `${mock.url}/v1`, model: 'test-llm' });
    try {
      await t.translate({ text: 'x', sourceLanguage: 'en', targetLanguage: 'vi', speaker: 'A', context: [], meetingContext: '', glossary: '', signal: signal() });
    } catch (e) {
      return classifyError(e, 'openai');
    }
    throw new Error('expected failure');
  };

  it('invalid API key → auth, not retryable', async () => {
    mock.state.mode = 'auth';
    const e = await run();
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('API Key');
    expect(e.message).not.toContain('sk-bad');
  });

  it('exhausted quota → quota, not retryable', async () => {
    mock.state.mode = 'quota';
    const e = await run();
    expect(e.code).toBe('quota');
    expect(e.retryable).toBe(false);
  });

  it('rate limit → retryable', async () => {
    mock.state.mode = 'rate_limit';
    expect((await run()).code).toBe('rate_limit');
  });

  it('unknown model → unsupported', async () => {
    mock.state.mode = 'model_not_found';
    expect((await run()).code).toBe('unsupported');
  });

  it('unreachable local server → network with local hint', async () => {
    const local = new OpenAICompatibleTranslator('local', { apiKey: null, baseUrl: 'http://127.0.0.1:1/v1', model: 'x' });
    try {
      await local.translate({ text: 'x', sourceLanguage: 'en', targetLanguage: 'vi', speaker: 'A', context: [], meetingContext: '', glossary: '', signal: signal() });
      throw new Error('expected failure');
    } catch (err) {
      const e = classifyError(err, 'local');
      expect(e.code).toBe('network');
      expect(e.hint).toContain('Local AI');
    }
  });

  it('classifies SDK error objects', () => {
    const err = OpenAI.APIError.generate(400, { error: { message: 'response_format is not supported for this model' } }, undefined, new Headers());
    expect(classifyError(err, 'openai').code).toBe('unsupported');
  });
});

describe('Retry / timeout / limiter', () => {
  it('retries retryable errors a bounded number of times', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError('server', 'boom', { provider: 'openai', retryable: true });
        },
        { provider: 'openai', retries: 2, timeoutMs: 1000, signal: new AbortController().signal, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError('auth', 'bad key', { provider: 'openai', retryable: false });
        },
        { provider: 'openai', retries: 5, timeoutMs: 1000, signal: new AbortController().signal, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });

  it('turns a hung request into a timeout error', async () => {
    const err: ProviderError = await withRetry<never>(
      (s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      { provider: 'openai', retries: 0, timeoutMs: 50, signal: new AbortController().signal },
    ).catch((e: ProviderError) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('timeout');
  });

  it('stops immediately when the session is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await withRetry(async () => 1, { provider: 'x', retries: 3, timeoutMs: 100, signal: ac.signal }).catch((e) => e);
    expect(err.code).toBe('aborted');
  });

  it('limits concurrency', async () => {
    const lim = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        lim.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
