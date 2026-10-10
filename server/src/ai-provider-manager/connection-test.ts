import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { ConnectionTestResult } from '@amt/shared';
import type { ResolvedSettings } from '../settings/settings-service';
import { pcmToWav } from '../audio/wav';
import { classifyError, ProviderError } from './errors';
import { createTranscriptionProvider, createTranslationProvider } from './registry';

export type TestTarget = 'openai' | 'anthropic' | 'local-stt' | 'local-llm' | 'pipeline';

const TIMEOUT = 15_000;

async function timed(target: string, provider: string, fn: (signal: AbortSignal) => Promise<string>): Promise<ConnectionTestResult> {
  const t0 = Date.now();
  try {
    const message = await fn(AbortSignal.timeout(TIMEOUT));
    return { ok: true, target, message, latencyMs: Date.now() - t0 };
  } catch (err) {
    const pe = classifyError(err, provider);
    const message = pe.code === 'aborted' ? 'Hết thời gian chờ (15 giây)' : pe.message;
    return { ok: false, target, message, hint: pe.hint, latencyMs: Date.now() - t0 };
  }
}

/** 1 giây tín hiệu gần như im lặng – kiểm tra model có nhận âm thanh không (chi phí rất nhỏ). */
function testWav(): Buffer {
  const pcm = new Int16Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 30);
  return pcmToWav(pcm, 16000);
}

export async function runConnectionTest(target: TestTarget, s: ResolvedSettings): Promise<ConnectionTestResult[]> {
  switch (target) {
    case 'openai': {
      if (!s.secrets.openaiApiKey) return [{ ok: false, target: 'OpenAI', message: 'Chưa nhập API Key', hint: 'Nhập API Key rồi lưu.' }];
      const client = new OpenAI({ apiKey: s.secrets.openaiApiKey, baseURL: s.openai.baseUrl, maxRetries: 0 });
      const models = [...new Set([s.openai.sttModel, s.openai.translationModel, ...(s.pipeline.diarizationMode === 'openai' ? ['gpt-4o-transcribe-diarize'] : [])])];
      const results: ConnectionTestResult[] = [];
      for (const m of models) {
        results.push(
          await timed(`OpenAI · ${m}`, 'openai', async (signal) => {
            await client.models.retrieve(m, { signal });
            return 'API Key hợp lệ, model khả dụng';
          }),
        );
      }
      return results;
    }
    case 'anthropic': {
      if (!s.secrets.anthropicApiKey) return [{ ok: false, target: 'Anthropic', message: 'Chưa nhập API Key', hint: 'Nhập API Key rồi lưu.' }];
      const client = new Anthropic({ apiKey: s.secrets.anthropicApiKey, maxRetries: 0 });
      return [
        await timed(`Anthropic · ${s.anthropic.model}`, 'anthropic', async (signal) => {
          const m = await client.models.retrieve(s.anthropic.model, {}, { signal });
          return `API Key hợp lệ, model khả dụng (${m.display_name})`;
        }),
      ];
    }
    case 'local-llm': {
      const client = new OpenAI({ apiKey: s.secrets.localApiKey || 'local-no-key', baseURL: s.local.llmBaseUrl, maxRetries: 0 });
      return [
        await timed(`Local LLM · ${s.local.llmBaseUrl}`, 'local', async (signal) => {
          const list = await client.models.list({ signal });
          const ids = list.data.map((m) => m.id);
          if (!ids.includes(s.local.llmModel)) {
            throw new ProviderError('unsupported', `Máy chủ không có model "${s.local.llmModel}". Có sẵn: ${ids.slice(0, 8).join(', ') || '(trống)'}`, {
              provider: 'local',
              retryable: false,
              hint: `Tải model trước khi dùng, ví dụ với Ollama: "ollama pull ${s.local.llmModel}".`,
            });
          }
          return `Kết nối được, model "${s.local.llmModel}" đã sẵn sàng`;
        }),
      ];
    }
    case 'local-stt': {
      return [
        await timed(`Local STT · ${s.local.sttBaseUrl}`, 'local', async (signal) => {
          const provider = createTranscriptionProvider({ ...s, pipeline: { ...s.pipeline, sttProvider: 'local' } }, 'none', '');
          await provider.transcribe({ wav: testWav(), durationMs: 1000, language: 'en', signal });
          return 'Máy chủ STT nhận và xử lý được âm thanh';
        }),
      ];
    }
    case 'pipeline': {
      // Kiểm tra chức năng thật của cấu hình đang chọn: gửi 1 giây âm thanh và dịch một câu ngắn.
      const results: ConnectionTestResult[] = [];
      results.push(
        await timed(`Speech-to-Text (${s.pipeline.sttProvider})`, s.pipeline.sttProvider, async (signal) => {
          const p = createTranscriptionProvider(s, s.pipeline.diarizationMode, '');
          await p.transcribe({ wav: testWav(), durationMs: 1000, language: 'en', signal });
          return `Model ${p.model} nhận dạng được âm thanh`;
        }),
      );
      results.push(
        await timed(`Dịch thuật (${s.pipeline.translationProvider})`, s.pipeline.translationProvider, async (signal) => {
          const p = createTranslationProvider(s);
          const out = await p.translate({
            text: 'We need to finish the cable tray layout before Friday.',
            sourceLanguage: 'en',
            targetLanguage: 'vi',
            speaker: 'Speaker A',
            context: [],
            meetingContext: '',
            glossary: s.pipeline.glossary,
            signal,
          });
          if (!out.trim()) throw new Error('Model trả về kết quả rỗng');
          return `Dịch thử: "${out.slice(0, 120)}"`;
        }),
      );
      return results;
    }
  }
}
