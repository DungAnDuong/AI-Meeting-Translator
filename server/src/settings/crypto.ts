import crypto from 'node:crypto';

/** AES-256-GCM. Định dạng: v1:<iv b64>:<tag b64>:<ciphertext b64> */
export function encryptJson(key: Buffer, value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptJson<T>(key: Buffer, payload: string): T {
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1') throw new Error('Định dạng dữ liệu mã hóa không hỗ trợ');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}

/** Che API key: chỉ hiển thị vài ký tự đầu/cuối. */
export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 10) return '••••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
