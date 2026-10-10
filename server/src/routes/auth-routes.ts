import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, type AppContext } from '../app';
import { AuthError } from '../authentication/auth-service';

const credentials = z.object({ email: z.string().max(200), password: z.string().min(1).max(200) });

/** Giới hạn đơn giản số lần đăng nhập theo IP (chống dò mật khẩu). */
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooManyAttempts(ip: string): boolean {
  const nowT = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < nowT) {
    attempts.set(ip, { count: 1, resetAt: nowT + 15 * 60_000 });
    return false;
  }
  a.count++;
  return a.count > 20;
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const setCookie = (reply: any, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.isProduction,
      path: '/',
      expires: expiresAt,
    });

  app.get('/api/auth/me', async (req) => ({
    user: req.user,
    registrationOpen: ctx.auth.registrationOpen(),
  }));

  app.post('/api/auth/register', async (req, reply) => {
    const body = credentials.extend({ displayName: z.string().max(100).default('') }).parse(req.body);
    try {
      const user = await ctx.auth.register(body.email, body.password, body.displayName);
      const s = ctx.auth.createSession(user.id);
      setCookie(reply, s.token, s.expiresAt);
      return { user };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (tooManyAttempts(req.ip)) return reply.code(429).send({ error: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' });
    const body = credentials.parse(req.body);
    try {
      const user = await ctx.auth.login(body.email, body.password);
      const s = ctx.auth.createSession(user.id);
      setCookie(reply, s.token, s.expiresAt);
      return { user };
    } catch (err) {
      if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) ctx.auth.destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
