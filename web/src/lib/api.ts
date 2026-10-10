export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly hint?: string,
    public readonly details?: string[],
  ) {
    super(message);
  }
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Không kết nối được tới máy chủ', 0, 'Kiểm tra kết nối mạng.');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new CustomEvent('amt:unauthorized'));
    throw new ApiError(data?.error ?? `Lỗi ${res.status}`, res.status, data?.hint, data?.details);
  }
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return [err.message, ...(err.details ?? [])].join(' – ');
  return (err as Error)?.message ?? String(err);
}
