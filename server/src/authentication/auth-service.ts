import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { User } from '@amt/shared';
import type { Db } from '../database/db';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT_OPTS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly opts: { allowRegistration: boolean; sessionTtlDays: number },
  ) {}

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  }

  /** Tài khoản đầu tiên luôn được tạo; các tài khoản sau cần ALLOW_REGISTRATION=true. */
  registrationOpen(): boolean {
    return this.opts.allowRegistration || this.userCount() === 0;
  }

  async register(email: string, password: string, displayName: string): Promise<User> {
    if (!this.registrationOpen()) throw new AuthError('Máy chủ đã tắt đăng ký tài khoản mới. Liên hệ quản trị viên.', 403);
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AuthError('Email không hợp lệ');
    if (password.length < 8) throw new AuthError('Mật khẩu cần tối thiểu 8 ký tự');
    const exists = this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized);
    if (exists) throw new AuthError('Email đã được sử dụng', 409);
    const user: User = { id: crypto.randomUUID(), email: normalized, displayName: displayName.trim() || normalized.split('@')[0] };
    this.db
      .prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.displayName, await hashPassword(password), new Date().toISOString());
    return user;
  }

  async login(email: string, password: string): Promise<User> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as any;
    // Luôn chạy scrypt để không lộ thông tin email tồn tại qua thời gian phản hồi
    const ok = row ? await verifyPassword(password, row.password_hash) : (await hashPassword(password), false);
    if (!row || !ok) throw new AuthError('Email hoặc mật khẩu không đúng', 401);
    return { id: row.id, email: row.email, displayName: row.display_name };
  }

  private localUser: User | null = null;

  /**
   * Tài khoản dùng khi không đăng nhập (ứng dụng chạy không cần màn hình đăng nhập):
   * tài khoản tạo sớm nhất để giữ dữ liệu cũ, hoặc tạo mới tài khoản "local" nếu DB trống.
   */
  defaultUser(): User {
    if (this.localUser) return this.localUser;
    let row = this.db.prepare('SELECT id, email, display_name FROM users ORDER BY created_at ASC LIMIT 1').get() as any;
    if (!row) {
      row = { id: crypto.randomUUID(), email: 'local@localhost', display_name: 'Local' };
      this.db
        .prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(row.id, row.email, row.display_name, '!', new Date().toISOString());
    }
    this.localUser = { id: row.id, email: row.email, displayName: row.display_name };
    return this.localUser;
  }

  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.opts.sessionTtlDays * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, new Date().toISOString(), expiresAt.toISOString());
    return { token, expiresAt };
  }

  userForToken(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.email, u.display_name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as any;
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.destroySession(token);
      return null;
    }
    return { id: row.id, email: row.email, displayName: row.display_name };
  }

  destroySession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  }
}
