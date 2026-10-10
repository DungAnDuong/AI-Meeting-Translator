import fs from 'node:fs';
import { ZodError } from 'zod';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { User } from '@amt/shared';
import type { AppConfig } from './config';
import { openDatabase, type Db } from './database/db';
import { AuthService } from './authentication/auth-service';
import { SettingsService } from './settings/settings-service';
import { TranscriptRepository } from './transcript-manager/repository';
import { SessionManager, type SessionManagerDeps } from './meeting-session/session-manager';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerMeetingRoutes } from './routes/meeting-routes';
import { registerSettingsRoutes } from './routes/settings-routes';
import { registerWebSocket } from './routes/ws-routes';
import { startRetentionJob } from './meeting-session/retention';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export const SESSION_COOKIE = 'amt_session';

export interface AppContext {
  config: AppConfig;
  db: Db;
  auth: AuthService;
  settings: SettingsService;
  repo: TranscriptRepository;
  sessions: SessionManager;
}

export interface BuildOptions {
  db?: Db;
  providerFactory?: SessionManagerDeps['providerFactory'];
  logger?: boolean;
}

export async function buildApp(config: AppConfig, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            // Không ghi log cookie / header xác thực / API key
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-api-key"]'],
          },
    bodyLimit: 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  const db = opts.db ?? openDatabase(config.dbFile);
  const repo = new TranscriptRepository(db);
  const recovered = repo.recoverInterruptedWork();
  if (recovered) app.log.warn({ recovered }, 'Đánh dấu các đoạn bị gián đoạn do máy chủ khởi động lại');

  const ctx: AppContext = {
    config,
    db,
    auth: new AuthService(db, { allowRegistration: config.allowRegistration, sessionTtlDays: config.sessionTtlDays }),
    settings: new SettingsService(db, config.secretKey, { openaiApiKey: config.envOpenAIKey, anthropicApiKey: config.envAnthropicKey }),
    repo,
    sessions: null as unknown as SessionManager,
  };
  ctx.sessions = new SessionManager({
    repo,
    settings: ctx.settings,
    audioDir: config.audioDir,
    log: {
      info: (o, m) => app.log.info(o, m),
      warn: (o, m) => app.log.warn(o, m),
      error: (o, m) => app.log.error(o, m),
    },
    providerFactory: opts.providerFactory,
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    // Không có màn hình đăng nhập: thiếu cookie phiên thì dùng tài khoản local mặc định.
    req.user = ctx.auth.userForToken(req.cookies[SESSION_COOKIE]) ?? ctx.auth.defaultUser();
  });

  // Chống CSRF: yêu cầu thay đổi dữ liệu và WebSocket phải đến từ cùng origin (hoặc ALLOWED_ORIGINS).
  app.addHook('onRequest', async (req, reply) => {
    const isWs = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (!isWs && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return; // client không phải trình duyệt
    if (!isAllowedOrigin(origin, req, config.allowedOrigins)) {
      return reply.code(403).send({ error: 'Origin không được phép' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self), display-capture=(self), camera=()');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dữ liệu không hợp lệ', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: err.message, url: req.url }, 'Lỗi máy chủ');
    reply.code(status).send({ error: status >= 500 ? 'Lỗi máy chủ, vui lòng thử lại' : err.message });
  });

  app.get('/api/health', async () => ({ ok: true, sessions: ctx.sessions.size }));

  await registerAuthRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerMeetingRoutes(app, ctx);
  await registerWebSocket(app, ctx);

  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      reply.code(404).send({ error: 'Không tìm thấy' });
    });
  }

  const stopRetention = startRetentionJob(ctx, app.log);
  app.addHook('onClose', async () => {
    stopRetention();
    ctx.sessions.shutdownAll();
    if (!opts.db) db.close();
  });

  return { app, ctx };
}

function isAllowedOrigin(origin: string, req: FastifyRequest, allowed: string[]): boolean {
  if (allowed.includes(origin)) return true;
  try {
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): User | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Bạn cần đăng nhập' });
    return null;
  }
  return req.user;
}
