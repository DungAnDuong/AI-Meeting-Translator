import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ProviderError } from '../ai-provider-manager/errors';
import type { CompletionRequest, ITranslationProvider, TranslationRequest } from '../ai-provider-manager/types';
import { buildTranslationSystemPrompt, buildTranslationUserPrompt, cleanTranslation } from './prompt';

/** Các model hỗ trợ fallbacks: "default" (dự phòng phía server khi model từ chối). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
/** Model cũ không nhận tham số effort. */
const NO_EFFORT = /claude-3|haiku-4-5|sonnet-4-5|sonnet-4-0|opus-4-0|opus-4-1|sonnet-4-2025|opus-4-2025/;

/**
 * Claude dùng làm bộ máy dịch / xử lý văn bản. Claude API không cung cấp thu âm, STT hay
 * phân biệt người nói – các phần đó do provider khác đảm nhiệm.
 */
export class AnthropicTranslator implements ITranslationProvider {
  readonly id = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    private readonly opts: { apiKey: string; model: string; effort: 'low' | 'medium' | 'high'; useFallbacks: boolean; baseUrl?: string },
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}) });
    this.model = opts.model;
  }

  private params(system: string, user: string, maxTokens: number, effort: 'low' | 'medium' | 'high'): BetaMessageStreamParams {
    const useFallbacks = this.opts.useFallbacks && FALLBACK_MODELS.has(this.model);
    return {
      model: this.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      ...(NO_EFFORT.test(this.model) ? {} : { output_config: { effort } }),
      ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
  }

  private async run(params: BetaMessageStreamParams, signal: AbortSignal, onText?: (t: string) => void): Promise<string> {
    const stream = this.client.beta.messages.stream(params, { signal, maxRetries: 0 });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText?.(text);
      }
    }
    const final: BetaMessage = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      throw new ProviderError('refused', 'Claude từ chối xử lý nội dung này', {
        provider: 'anthropic',
        retryable: false,
        hint: 'Bạn có thể tự nhập bản dịch cho lượt phát biểu này.',
      });
    }
    // Nếu có chuyển sang model dự phòng giữa chừng, chỉ lấy văn bản sau khối fallback cuối cùng.
    const blocks = final.content as Array<{ type: string; text?: string }>;
    const lastFallback = blocks.map((b) => b.type).lastIndexOf('fallback');
    return blocks
      .slice(lastFallback + 1)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  async translate(req: TranslationRequest): Promise<string> {
    const params = this.params(buildTranslationSystemPrompt(req), buildTranslationUserPrompt(req), 2048, this.opts.effort);
    const text = await this.run(params, req.signal, (t) => req.onPartial?.(cleanTranslation(t)));
    return cleanTranslation(text);
  }

  async complete(req: CompletionRequest): Promise<string> {
    // Tóm tắt cuộc họp cần suy luận kỹ hơn dịch từng câu → effort tối thiểu "medium".
    const effort = this.opts.effort === 'high' ? 'high' : 'medium';
    return this.run(this.params(req.system, req.user, req.maxTokens, effort), req.signal);
  }
}
