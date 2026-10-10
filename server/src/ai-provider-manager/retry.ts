import { classifyError, ProviderError } from './errors';

export interface RetryOptions {
  provider: string;
  retries: number;
  timeoutMs: number;
  signal: AbortSignal;
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: ProviderError) => void;
}

/**
 * Chạy fn với timeout cho từng lần thử và retry có giới hạn (không bao giờ vô hạn).
 * Hủy ngay khi `signal` (phiên họp dừng) bị abort.
 */
export async function withRetry<T>(fn: (signal: AbortSignal, attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, opts.retries + 1);
  let last: ProviderError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal.aborted) throw new ProviderError('aborted', 'Yêu cầu đã bị hủy', { provider: opts.provider, retryable: false });
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const combined = AbortSignal.any([opts.signal, timeout]);
    try {
      return await fn(combined, attempt);
    } catch (err) {
      let pe = classifyError(err, opts.provider);
      if (pe.code === 'aborted' && timeout.aborted && !opts.signal.aborted) {
        pe = new ProviderError('timeout', 'Hết thời gian chờ phản hồi từ dịch vụ AI', {
          provider: opts.provider,
          retryable: true,
          hint: 'Kiểm tra mạng hoặc tăng "Thời gian chờ" trong Cài đặt.',
        });
      }
      last = pe;
      if (!pe.retryable || attempt === maxAttempts || opts.signal.aborted) throw pe;
      opts.onRetry?.(attempt, pe);
      const base = opts.baseDelayMs ?? 500;
      const delay = pe.opts.retryAfterMs ?? Math.min(8000, base * 2 ** (attempt - 1)) + Math.random() * 200;
      await sleep(delay, opts.signal);
    }
  }
  throw last ?? new ProviderError('server', 'Lỗi không xác định', { provider: opts.provider, retryable: false });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** Giới hạn số tác vụ chạy đồng thời (theo khả năng của từng nhà cung cấp). */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(public concurrency: number) {}

  get pending() {
    return this.queue.length;
  }
  get running() {
    return this.active;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.next();
          });
      };
      if (this.active < this.concurrency) start();
      else this.queue.push(start);
    });
  }

  /** Bỏ các tác vụ chưa bắt đầu (khi kết thúc/hủy phiên). */
  clear(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    return n;
  }

  private next() {
    while (this.active < this.concurrency && this.queue.length) this.queue.shift()!();
  }
}

/** Gom các lần gọi liên tiếp, chỉ chạy tối đa 1 lần mỗi `ms` (dùng cho văn bản streaming tạm thời). */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let pendingArgs: A | null = null;
  const wrapped = (...args: A) => {
    const nowT = Date.now();
    pendingArgs = args;
    if (nowT - last >= ms) {
      last = nowT;
      pendingArgs = null;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pendingArgs) fn(...pendingArgs);
        pendingArgs = null;
      }, ms - (nowT - last));
    }
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };
  return wrapped;
}
