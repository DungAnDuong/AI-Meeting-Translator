import OpenAI from 'openai';
import type { CompletionRequest, ITranslationProvider, TranslationRequest } from '../ai-provider-manager/types';
import { buildTranslationSystemPrompt, buildTranslationUserPrompt, cleanTranslation } from './prompt';

/**
 * Dịch qua Chat Completions. Dùng cho OpenAI và cho Local LLM tương thích API OpenAI
 * (Ollama /v1, LM Studio, vLLM, llama.cpp server...).
 */
export class OpenAICompatibleTranslator implements ITranslationProvider {
  private readonly client: OpenAI;
  readonly model: string;

  constructor(
    readonly id: 'openai' | 'local',
    opts: { apiKey: string | null; baseUrl: string; model: string; temperature?: number | null },
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey || 'local-no-key', baseURL: opts.baseUrl, maxRetries: 0 });
    this.model = opts.model;
    this.temperature = opts.temperature ?? null;
  }
  private readonly temperature: number | null;

  async translate(req: TranslationRequest): Promise<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        ...(this.temperature !== null ? { temperature: this.temperature } : {}),
        messages: [
          { role: 'system', content: buildTranslationSystemPrompt(req) },
          { role: 'user', content: buildTranslationUserPrompt(req) },
        ],
      },
      { signal: req.signal, maxRetries: 0 },
    );
    let text = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        req.onPartial?.(cleanTranslation(text));
      }
    }
    return cleanTranslation(text);
  }

  async complete(req: CompletionRequest): Promise<string> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        ...(this.temperature !== null ? { temperature: this.temperature } : {}),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      { signal: req.signal, maxRetries: 0 },
    );
    return res.choices[0]?.message?.content ?? '';
  }
}
