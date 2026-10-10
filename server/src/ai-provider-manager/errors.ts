import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export type ProviderErrorCode =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'unsupported'
  | 'bad_request'
  | 'server'
  | 'aborted'
  | 'refused'
  | 'config';

/** Lỗi đã chuẩn hóa từ mọi nhà cung cấp AI, kèm thông báo tiếng Việt và hướng dẫn khắc phục. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly opts: { provider: string; retryable: boolean; hint?: string; status?: number; retryAfterMs?: number } = {
      provider: 'unknown',
      retryable: false,
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable() {
    return this.opts.retryable;
  }
  get hint() {
    return this.opts.hint;
  }
  get provider() {
    return this.opts.provider;
  }
}

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic Claude', local: 'Local AI' };

function retryAfter(headers: unknown): number | undefined {
  try {
    const h = headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
    const v = typeof (h as any)?.get === 'function' ? (h as any).get('retry-after') : (h as any)?.['retry-after'];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 30_000) : undefined;
  } catch {
    return undefined;
  }
}

/** Chuyển lỗi bất kỳ (SDK, fetch, abort) thành ProviderError. Không đưa API key vào thông báo. */
export function classifyError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = PROVIDER_NAMES[provider] ?? provider;
  const mk = (code: ProviderErrorCode, msg: string, retryable: boolean, hint?: string, status?: number, ra?: number) =>
    new ProviderError(code, msg, { provider, retryable, hint, status, retryAfterMs: ra });

  // Hủy do người dùng dừng phiên (không phải timeout)
  if (err instanceof OpenAI.APIUserAbortError || err instanceof Anthropic.APIUserAbortError || (err as any)?.name === 'AbortError') {
    return mk('aborted', 'Yêu cầu đã bị hủy', false);
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionTimeoutError || (err as any)?.name === 'TimeoutError') {
    return mk('timeout', `${name} phản hồi quá thời gian chờ`, true, 'Kiểm tra kết nối mạng hoặc tăng "Thời gian chờ" trong Cài đặt.');
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof Anthropic.APIConnectionError) {
    return mk(
      'network',
      `Không kết nối được tới ${name}`,
      true,
      provider === 'local'
        ? 'Kiểm tra máy chủ Local AI đã chạy và địa chỉ/endpoint trong Cài đặt là đúng.'
        : 'Kiểm tra kết nối Internet, proxy/firewall hoặc Endpoint tùy chỉnh.',
    );
  }

  const status: number | undefined = (err as any)?.status;
  const apiCode: string | undefined = (err as any)?.code ?? (err as any)?.error?.code ?? (err as any)?.error?.error?.type;
  const rawMsg: string = String((err as any)?.error?.message ?? (err as any)?.error?.error?.message ?? (err as any)?.message ?? '');
  const lower = rawMsg.toLowerCase();
  const ra = retryAfter((err as any)?.headers);

  if (status === 401 || status === 403) {
    return mk('auth', `${name}: API Key không hợp lệ hoặc không có quyền (HTTP ${status})`, false, 'Kiểm tra lại API Key trong Cài đặt AI rồi bấm "Kiểm tra kết nối".', status);
  }
  if (apiCode === 'insufficient_quota' || lower.includes('credit balance') || lower.includes('quota') || lower.includes('billing')) {
    return mk('quota', `${name}: tài khoản đã hết hạn mức hoặc hết tín dụng`, false, 'Nạp thêm tín dụng/tăng hạn mức tại trang quản trị của nhà cung cấp, hoặc chuyển sang nhà cung cấp khác.', status);
  }
  if (status === 429) {
    return mk('rate_limit', `${name}: vượt giới hạn tốc độ yêu cầu`, true, 'Giảm "Số yêu cầu đồng thời" trong Cài đặt hoặc chờ một lát.', status, ra);
  }
  if (status === 404 || apiCode === 'model_not_found') {
    return mk('unsupported', `${name}: model hoặc endpoint không tồn tại / không được phép sử dụng`, false, 'Kiểm tra tên model và Endpoint trong Cài đặt.', status);
  }
  if (status === 400 || status === 422) {
    const unsupported = /not supported|unsupported|does not support|response_format|invalid model|not available/.test(lower);
    return mk(
      unsupported ? 'unsupported' : 'bad_request',
      unsupported ? `${name}: model không hỗ trợ tác vụ được yêu cầu (${truncate(rawMsg)})` : `${name}: yêu cầu không hợp lệ (${truncate(rawMsg)})`,
      false,
      unsupported ? 'Chọn model phù hợp với tác vụ (ví dụ STT: gpt-4o-transcribe; dịch: model chat).' : undefined,
      status,
    );
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) {
    return mk('server', `${name}: dịch vụ đang gặp lỗi (HTTP ${status})`, true, 'Thử lại sau ít phút.', status, ra);
  }
  if (err instanceof TypeError && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(String((err as any).cause ?? err.message))) {
    return mk('network', `Không kết nối được tới ${name}`, true, provider === 'local' ? 'Kiểm tra máy chủ Local AI đã chạy.' : 'Kiểm tra kết nối mạng.');
  }
  return mk('server', `${name}: lỗi không xác định (${truncate(rawMsg || String(err))})`, true, undefined, status);
}

function truncate(s: string, n = 180) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
