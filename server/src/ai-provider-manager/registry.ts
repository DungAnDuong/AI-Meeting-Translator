import type { DiarizationMode, Speaker } from '@amt/shared';
import type { ResolvedSettings } from '../settings/settings-service';
import { LocalOpenAICompatibleSttProvider, OPENAI_DIARIZE_MODEL, OpenAITranscriptionProvider, WhisperCppSttProvider } from '../speech-recognition/openai-stt';
import { AnthropicTranslator } from '../translation-engine/anthropic-translator';
import { OpenAICompatibleTranslator } from '../translation-engine/openai-translator';
import { NoDiarization, OpenAIReferenceDiarization, PerSourceDiarization } from '../speaker-diarization/diarizers';
import type { TranscriptRepository } from '../transcript-manager/repository';
import { ProviderError } from './errors';
import type { ISpeakerDiarizationProvider, ITranscriptionProvider, ITranslationProvider } from './types';

function missingKey(provider: string, name: string): ProviderError {
  return new ProviderError('config', `Chưa cấu hình API Key cho ${name}`, {
    provider,
    retryable: false,
    hint: `Mở Cài đặt AI → ${name}, nhập API Key rồi bấm "Kiểm tra kết nối".`,
  });
}

/** Lấy danh sách thuật ngữ nguồn từ glossary ("term = bản dịch") làm từ khóa gợi ý cho STT. */
export function glossaryKeywords(glossary: string): string[] {
  return glossary
    .split('\n')
    .map((l) => l.split('=')[0]?.trim())
    .filter((t): t is string => !!t && t.length <= 60);
}

export function createTranscriptionProvider(s: ResolvedSettings, mode: DiarizationMode, glossary: string): ITranscriptionProvider {
  if (s.pipeline.sttProvider === 'openai') {
    if (!s.secrets.openaiApiKey) throw missingKey('openai', 'OpenAI');
    return new OpenAITranscriptionProvider({
      apiKey: s.secrets.openaiApiKey,
      baseUrl: s.openai.baseUrl,
      // Diarization của OpenAI chỉ có ở model chuyên dụng
      model: mode === 'openai' ? OPENAI_DIARIZE_MODEL : s.openai.sttModel,
      keywords: glossaryKeywords(glossary),
    });
  }
  if (mode === 'openai') {
    throw new ProviderError('config', 'Local STT không hỗ trợ phân biệt người nói kiểu OpenAI', {
      provider: 'local',
      retryable: false,
      hint: 'Chọn chế độ phân biệt người nói "Theo nguồn âm thanh" hoặc "Không phân biệt".',
    });
  }
  if (!s.local.sttModel && s.local.sttApiStyle === 'openai') {
    throw new ProviderError('config', 'Chưa cấu hình tên model Local Speech-to-Text', { provider: 'local', retryable: false });
  }
  const opts = { baseUrl: s.local.sttBaseUrl, model: s.local.sttModel, apiKey: s.secrets.localApiKey };
  return s.local.sttApiStyle === 'whisper.cpp' ? new WhisperCppSttProvider(opts) : new LocalOpenAICompatibleSttProvider(opts);
}

export function createTranslationProvider(s: ResolvedSettings): ITranslationProvider {
  switch (s.pipeline.translationProvider) {
    case 'openai':
      if (!s.secrets.openaiApiKey) throw missingKey('openai', 'OpenAI');
      return new OpenAICompatibleTranslator('openai', {
        apiKey: s.secrets.openaiApiKey,
        baseUrl: s.openai.baseUrl,
        model: s.openai.translationModel,
        temperature: s.openai.temperature,
      });
    case 'anthropic':
      if (!s.secrets.anthropicApiKey) throw missingKey('anthropic', 'Anthropic Claude');
      return new AnthropicTranslator({
        apiKey: s.secrets.anthropicApiKey,
        model: s.anthropic.model,
        effort: s.anthropic.effort,
        useFallbacks: s.anthropic.useFallbacks,
      });
    case 'local':
      return new OpenAICompatibleTranslator('local', { apiKey: s.secrets.localApiKey, baseUrl: s.local.llmBaseUrl, model: s.local.llmModel });
  }
}

export function createDiarizer(mode: DiarizationMode, repo: TranscriptRepository, onSpeaker: (s: Speaker) => void): ISpeakerDiarizationProvider {
  switch (mode) {
    case 'openai':
      return new OpenAIReferenceDiarization(repo, onSpeaker);
    case 'per-source':
      return new PerSourceDiarization(repo, onSpeaker);
    default:
      return new NoDiarization();
  }
}

export function describeProviders(s: ResolvedSettings): { stt: string; translation: string } {
  const stt =
    s.pipeline.sttProvider === 'openai'
      ? `openai:${s.pipeline.diarizationMode === 'openai' ? OPENAI_DIARIZE_MODEL : s.openai.sttModel}`
      : `local:${s.local.sttModel || s.local.sttApiStyle}`;
  const translation =
    s.pipeline.translationProvider === 'openai'
      ? `openai:${s.openai.translationModel}`
      : s.pipeline.translationProvider === 'anthropic'
        ? `anthropic:${s.anthropic.model}`
        : `local:${s.local.llmModel}`;
  return { stt, translation };
}
