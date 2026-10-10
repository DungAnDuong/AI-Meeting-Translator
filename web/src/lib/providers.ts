import type { ProviderPublicConfig } from '@amt/shared';

export const DIARIZATION_LABELS: Record<string, string> = {
  openai: 'OpenAI (theo giọng nói)',
  'per-source': 'Theo nguồn âm thanh',
  none: 'Không phân biệt',
};

/** Tóm tắt cấu hình đang dùng và vấn đề còn thiếu (để hiển thị trước khi bắt đầu). */
export function providerSummary(s: ProviderPublicConfig): { stt: string; translation: string; diarization: string; ready: boolean; problem?: string } {
  const p = s.pipeline;
  const stt = p.sttProvider === 'openai' ? `OpenAI ${p.diarizationMode === 'openai' ? 'gpt-4o-transcribe-diarize' : s.openai.sttModel}` : `Local (${s.local.sttModel || s.local.sttApiStyle})`;
  const translation =
    p.translationProvider === 'openai' ? `OpenAI ${s.openai.translationModel}` : p.translationProvider === 'anthropic' ? `Claude ${s.anthropic.model}` : `Local (${s.local.llmModel})`;
  const needOpenAI = p.sttProvider === 'openai' || p.translationProvider === 'openai';
  const needClaude = p.translationProvider === 'anthropic';
  let problem: string | undefined;
  if (needOpenAI && !s.openai.apiKeySource) problem = 'Chưa nhập OpenAI API Key.';
  else if (needClaude && !s.anthropic.apiKeySource) problem = 'Chưa nhập Anthropic API Key.';
  return { stt, translation, diarization: DIARIZATION_LABELS[p.diarizationMode], ready: !problem, problem };
}

/** Nơi dữ liệu được gửi tới – hiển thị trong thông báo quyền riêng tư. */
export function dataDestinations(s: ProviderPublicConfig): string[] {
  const out: string[] = [];
  const p = s.pipeline;
  out.push(p.sttProvider === 'openai' ? `Âm thanh → OpenAI (${s.openai.baseUrl})` : `Âm thanh → máy chủ Local STT (${s.local.sttBaseUrl})`);
  out.push(
    p.translationProvider === 'openai'
      ? `Văn bản → OpenAI (${s.openai.baseUrl})`
      : p.translationProvider === 'anthropic'
        ? 'Văn bản → Anthropic Claude (api.anthropic.com)'
        : `Văn bản → máy chủ Local LLM (${s.local.llmBaseUrl})`,
  );
  return out;
}
