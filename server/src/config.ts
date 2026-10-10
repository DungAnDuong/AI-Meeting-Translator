import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : def;
}

export interface AppConfig {
  port: number;
  host: string;
  isProduction: boolean;
  dataDir: string;
  dbFile: string;
  audioDir: string;
  secretKey: Buffer; // 32 byte – mã hóa API key lưu trong DB
  allowRegistration: boolean;
  allowedOrigins: string[];
  sessionTtlDays: number;
  webDistDir: string;
  /** Khóa mặc định do quản trị máy chủ cấp qua biến môi trường (không bao giờ gửi về trình duyệt). */
  envOpenAIKey: string | null;
  envAnthropicKey: string | null;
  retentionDays: number; // 0 = giữ vô thời hạn
}

/**
 * Lấy khóa bí mật. Ưu tiên APP_SECRET; nếu không có (môi trường dev), tự tạo và lưu vào
 * data/secret.key với quyền chỉ đọc cho chủ sở hữu. Production bắt buộc đặt APP_SECRET.
 */
function loadSecret(dataDir: string, isProduction: boolean): Buffer {
  const raw = process.env.APP_SECRET?.trim();
  if (raw) {
    if (raw.length < 32) throw new Error('APP_SECRET phải dài tối thiểu 32 ký tự');
    return crypto.createHash('sha256').update(raw).digest();
  }
  if (isProduction) throw new Error('Thiếu APP_SECRET trong môi trường production');
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  console.warn(`[config] Chưa đặt APP_SECRET – đã tạo khóa dev tại ${file}`);
  return key;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const dataDir = overrides.dataDir ?? path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const audioDir = path.join(dataDir, 'audio');
  const cfg: AppConfig = {
    port: int(process.env.PORT, 8787),
    host: process.env.HOST ?? '0.0.0.0',
    isProduction,
    dataDir,
    dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'meetings.db'),
    audioDir,
    secretKey: overrides.secretKey ?? loadSecret(dataDir, isProduction),
    allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 14),
    webDistDir: path.resolve(process.env.WEB_DIST_DIR ?? path.join(process.cwd(), '..', 'web', 'dist')),
    envOpenAIKey: process.env.OPENAI_API_KEY?.trim() || null,
    envAnthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
    retentionDays: int(process.env.RETENTION_DAYS, 0),
    ...overrides,
  };
  return cfg;
}
