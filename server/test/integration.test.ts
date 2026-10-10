import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Segment, ServerMessage } from '@amt/shared';
import { encodeAudioPacket } from '@amt/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/database/db';
import { makeSpeechPcm, startMockAiServer } from './helpers/mock-ai-server';

let mock: Awaited<ReturnType<typeof startMockAiServer>>;
let base: string;
let close: () => Promise<void>;
let ctxRef: Awaited<ReturnType<typeof buildApp>>['ctx'];

beforeAll(async () => {
  mock = await startMockAiServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amt-test-'));
  process.env.ALLOW_REGISTRATION = 'true';
  const config = loadConfig({ dataDir, secretKey: crypto.randomBytes(32), webDistDir: path.join(dataDir, 'none') });
  const { app, ctx } = await buildApp(config, { db: openDatabase(':memory:'), logger: false });
  ctxRef = ctx;
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = async () => {
    await app.close();
    await mock.close();
  };
});
afterAll(async () => close());
beforeEach(() => {
  mock.state.mode = 'ok';
  mock.state.failOnly = null;
  mock.state.requests = [];
});

class Client {
  cookie = '';
  async req(method: string, url: string, body?: unknown): Promise<{ status: number; headers: Headers; json: any; raw: Buffer | null }> {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: this.cookie, origin: base },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, json: ct.includes('json') ? await res.json() : null, raw: ct.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  }
}

async function newUser(email: string) {
  const c = new Client();
  const r = await c.req('POST', '/api/auth/register', { email, password: 'password123', displayName: email });
  expect(r.status).toBe(200);
  return c;
}

/** Kết nối WebSocket và thu thập tin nhắn server gửi về. */
async function connect(c: Client, meetingId: string) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: c.cookie, origin: base } });
  const messages: ServerMessage[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    messages.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  });
  await new Promise((r) => ws.once('open', r));
  const waitFor = <T extends ServerMessage>(pred: (m: ServerMessage) => boolean, timeout = 8000) =>
    new Promise<T>((resolve, reject) => {
      const found = messages.find(pred);
      if (found) return resolve(found as T);
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m as T)) });
    });
  ws.send(JSON.stringify({ type: 'hello', meetingId, clientId: 'test' }));
  const snapshot = await waitFor<Extract<ServerMessage, { type: 'snapshot' }>>((m) => m.type === 'snapshot');
  const sendChunk = (chunkId: string, ms = 2000) =>
    ws.send(
      encodeAudioPacket(
        { type: 'chunk', chunkId, sourceId: 'test:mic', sourceLabel: 'Micro', sampleRate: 16000, capturedAt: snapshot.serverNow + 1000, durationMs: ms },
        makeSpeechPcm(ms),
      ),
    );
  return { ws, messages, waitFor, snapshot, sendChunk };
}

async function configureLocal(c: Client) {
  const r = await c.req('PUT', '/api/settings', {
    local: { sttBaseUrl: `${mock.url}/v1`, sttApiStyle: 'openai', sttModel: 'test-stt', llmBaseUrl: `${mock.url}/v1`, llmModel: 'test-llm' },
    pipeline: { sttProvider: 'local', translationProvider: 'local', diarizationMode: 'per-source', maxRetries: 0, requestTimeoutMs: 5000 },
  });
  expect(r.status).toBe(200);
}

describe('Authentication & access control', () => {
  it('uses the default local account when not logged in', async () => {
    const r = await new Client().req('GET', '/api/auth/me');
    expect(r.status).toBe(200);
    expect(r.json.user?.id).toBe(ctxRef.auth.defaultUser().id);
    expect((await new Client().req('GET', '/api/meetings')).status).toBe(200);
  });

  it('another user cannot read, export or join someone else’s meeting', async () => {
    const owner = await newUser('owner@test.vn');
    const other = await newUser('other@test.vn');
    const { json } = await owner.req('POST', '/api/meetings', { title: 'Bí mật' });
    const id = json.meeting.id;
    expect((await other.req('GET', `/api/meetings/${id}`)).status).toBe(404);
    expect((await other.req('GET', `/api/meetings/${id}/export?format=txt`)).status).toBe(404);
    expect((await other.req('DELETE', `/api/meetings/${id}`)).status).toBe(404);
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: other.cookie, origin: base } });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', meetingId: id, clientId: 'x' }));
    const msg = await new Promise<ServerMessage>((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    expect(msg).toMatchObject({ type: 'error', code: 'not_found' });
    ws.close();
  });

  it('rejects cross-origin state-changing requests', async () => {
    const c = await newUser('csrf@test.vn');
    const res = await fetch(base + '/api/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: c.cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('API key protection', () => {
  it('stores keys encrypted and only returns a masked value', async () => {
    const c = await newUser('keys@test.vn');
    const key = 'sk-proj-SECRET1234567890abcdef';
    const r = await c.req('PUT', '/api/settings', { openai: { apiKey: key } });
    expect(JSON.stringify(r.json)).not.toContain(key);
    expect(r.json.settings.openai.apiKey).toBe('sk-p••••cdef');
    expect(r.json.settings.openai.apiKeySource).toBe('user');
    const row = ctxRef.db.prepare('SELECT settings_json, secrets_enc FROM user_settings').all() as any[];
    expect(JSON.stringify(row)).not.toContain(key);
  });

  it('rejects an impossible combination (OpenAI diarization with local STT)', async () => {
    const c = await newUser('combo@test.vn');
    const r = await c.req('PUT', '/api/settings', { pipeline: { sttProvider: 'local', diarizationMode: 'openai' } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('Speech-to-Text là OpenAI');
  });

  it('connection test reports a wrong key with a clear message', async () => {
    const c = await newUser('wrongkey@test.vn');
    await c.req('PUT', '/api/settings', { openai: { apiKey: 'sk-wrong-key-123456', baseUrl: `${mock.url}/v1` } });
    mock.state.mode = 'auth';
    const r = await c.req('POST', '/api/settings/test', { target: 'openai' });
    expect(r.json.results[0].ok).toBe(false);
    expect(r.json.results[0].message).toContain('API Key không hợp lệ');
  });

  it('connection test to local LLM detects a missing model', async () => {
    const c = await newUser('local@test.vn');
    await c.req('PUT', '/api/settings', { local: { llmBaseUrl: `${mock.url}/v1`, llmModel: 'not-pulled' } });
    const r = await c.req('POST', '/api/settings/test', { target: 'local-llm' });
    expect(r.json.results[0].ok).toBe(false);
    expect(r.json.results[0].message).toContain('not-pulled');
  });
});

describe('Real-time pipeline end-to-end (audio → STT → speaker → translation → storage)', () => {
  it('transcribes, translates, stores and de-duplicates a re-sent chunk', async () => {
    const c = await newUser('e2e@test.vn');
    await configureLocal(c);
    const { json } = await c.req('POST', '/api/meetings', { title: 'Họp E2E', sourceLanguage: 'auto' });
    const id = json.meeting.id;
    const conn = await connect(c, id);

    const chunkId = crypto.randomUUID();
    conn.sendChunk(chunkId);
    await conn.waitFor((m) => m.type === 'chunk_ack' && m.chunkId === chunkId);
    const transcribing = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'transcribing');
    const final = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'final');
    expect(final.segment.id).toBe(transcribing.segment.id); // cùng ID → không trùng lặp
    expect(final.segment.originalText).toBe(mock.state.transcript);
    expect(final.segment.translatedText).toBe(mock.state.translation);
    expect(final.segment.language).toBe('en');
    expect(final.segment.speakerId).not.toBeNull();
    expect(conn.messages.some((m) => m.type === 'speaker' && m.speaker.label === 'A')).toBe(true);
    // Văn bản dịch tạm thời đã được stream trước khi xác nhận
    expect(conn.messages.some((m) => m.type === 'segment' && m.segment.interim && m.segment.translatedText)).toBe(true);

    // Gửi lại cùng chunk (giả lập mất mạng rồi gửi lại) → chỉ xác nhận, không xử lý lại
    const sttCalls = mock.state.requests.filter((r) => r.path === '/v1/audio/transcriptions').length;
    conn.sendChunk(chunkId);
    const dup = await conn.waitFor((m) => m.type === 'chunk_ack' && m.duplicate);
    expect(dup).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.state.requests.filter((r) => r.path === '/v1/audio/transcriptions').length).toBe(sttCalls);

    const saved = await c.req('GET', `/api/meetings/${id}`);
    expect(saved.json.segments).toHaveLength(1);
    expect(saved.json.segments[0].status).toBe('final');

    // Đổi tên người nói → áp dụng cho mọi lượt liên quan & bản xuất
    const spk = saved.json.speakers[0];
    await c.req('PATCH', `/api/meetings/${id}/speakers/${spk.id}`, { displayName: 'Chị Lan' });
    const txt = await c.req('GET', `/api/meetings/${id}/export?format=txt&tz=Asia/Ho_Chi_Minh`);
    const text = txt.raw!.toString('utf8');
    expect(text).toContain('Chị Lan');
    expect(text).toContain(`Vietnamese: ${mock.state.translation}`);
    expect(txt.headers.get('content-disposition')).toContain('Hop_E2E_');

    // Sửa văn bản nhận dạng sai
    const edit = await c.req('PATCH', `/api/meetings/${id}/segments/${final.segment.id}`, { translatedText: 'Bản dịch đã sửa' });
    expect(edit.json.segment.translationEdited).toBe(true);
    conn.ws.close();
  });

  it('reports STT failure (local AI unreachable) as an error segment with guidance', async () => {
    const c = await newUser('down@test.vn');
    await configureLocal(c);
    await c.req('PUT', '/api/settings', { local: { sttBaseUrl: 'http://127.0.0.1:1/v1' } });
    const { json } = await c.req('POST', '/api/meetings', { title: 'Down' });
    const conn = await connect(c, json.meeting.id);
    conn.sendChunk(crypto.randomUUID());
    const err = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'error');
    expect(err.segment.error).toContain('Không kết nối được tới Local AI');
    const e = await conn.waitFor<Extract<ServerMessage, { type: 'error' }>>((m) => m.type === 'error');
    expect(e.hint).toContain('Local AI');
    // Khắc phục rồi bấm Thử lại → nhận dạng lại từ âm thanh đã giữ tạm
    await c.req('PUT', '/api/settings', { local: { sttBaseUrl: `${mock.url}/v1` } });
    conn.ws.send(JSON.stringify({ type: 'retry_segment', segmentId: err.segment.id }));
    const ok = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'final' && m.segment.id === err.segment.id);
    expect(ok.segment.translatedText).toBe(mock.state.translation);
    conn.ws.close();
  });

  it('marks translation failures (quota exhausted) without losing the original text', async () => {
    const c = await newUser('quota@test.vn');
    await configureLocal(c);
    const { json } = await c.req('POST', '/api/meetings', { title: 'Quota' });
    const conn = await connect(c, json.meeting.id);
    // STT ok, nhưng dịch thất bại vì hết hạn mức
    mock.state.mode = 'quota';
    mock.state.failOnly = '/v1/chat/completions';
    conn.sendChunk(crypto.randomUUID());
    const err = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'error');
    expect(err.segment.originalText).toBe(mock.state.transcript);
    expect(err.segment.error).toContain('hết hạn mức');
    conn.ws.close();
  });

  it('asks before ending while audio is still being processed, then drains', async () => {
    const c = await newUser('end@test.vn');
    await configureLocal(c);
    const { json } = await c.req('POST', '/api/meetings', { title: 'End' });
    const conn = await connect(c, json.meeting.id);
    mock.state.mode = 'slow';
    mock.state.slowMs = 600;
    conn.sendChunk(crypto.randomUUID());
    await conn.waitFor((m) => m.type === 'chunk_ack');
    conn.ws.send(JSON.stringify({ type: 'end', mode: 'ask' }));
    const pending = await conn.waitFor<Extract<ServerMessage, { type: 'end_pending' }>>((m) => m.type === 'end_pending');
    expect(pending.pending).toBeGreaterThan(0);
    conn.ws.send(JSON.stringify({ type: 'end', mode: 'drain' }));
    const ended = await conn.waitFor<Extract<ServerMessage, { type: 'ended' }>>((m) => m.type === 'ended');
    expect(ended.meeting.status).toBe('ended');
    const saved = await c.req('GET', `/api/meetings/${json.meeting.id}`);
    expect(saved.json.segments.every((s: Segment) => s.status === 'final')).toBe(true);
    conn.ws.close();
  });

  it('abort mode cancels pending work and clearly marks it', async () => {
    const c = await newUser('abort@test.vn');
    await configureLocal(c);
    const { json } = await c.req('POST', '/api/meetings', { title: 'Abort' });
    const conn = await connect(c, json.meeting.id);
    mock.state.mode = 'slow';
    mock.state.slowMs = 3000;
    conn.sendChunk(crypto.randomUUID());
    await conn.waitFor((m) => m.type === 'chunk_ack');
    conn.ws.send(JSON.stringify({ type: 'end', mode: 'abort' }));
    await conn.waitFor((m) => m.type === 'ended');
    const saved = await c.req('GET', `/api/meetings/${json.meeting.id}`);
    expect(saved.json.segments[0].status).toBe('error');
    expect(saved.json.segments[0].error).toContain('Đã hủy');
    conn.ws.close();
  });
});

describe('Demo mode', () => {
  it('is clearly labelled and works without any API key', async () => {
    const c = await newUser('demo@test.vn');
    const { json } = await c.req('POST', '/api/meetings', { title: 'Thử giao diện', demo: true });
    expect(json.meeting.isDemo).toBe(true);
    expect(json.meeting.title.startsWith('[DEMO]')).toBe(true);
    const conn = await connect(c, json.meeting.id);
    conn.ws.send(JSON.stringify({ type: 'demo_start' }));
    const final = await conn.waitFor<{ type: 'segment'; segment: Segment }>((m) => m.type === 'segment' && m.segment.status === 'final', 10000);
    expect(final.segment.translatedText.length).toBeGreaterThan(5);
    // Âm thanh thật bị từ chối trong cuộc họp demo
    conn.sendChunk(crypto.randomUUID());
    await conn.waitFor((m) => m.type === 'error' && m.code === 'demo');
    conn.ws.send(JSON.stringify({ type: 'end', mode: 'abort' }));
    await conn.waitFor((m) => m.type === 'ended');
    const txt = await c.req('GET', `/api/meetings/${json.meeting.id}/export?format=txt`);
    expect(txt.raw!.toString('utf8')).toContain('[DEMO]');
    const sum = await c.req('POST', `/api/meetings/${json.meeting.id}/summary`, {});
    expect(sum.json.summary.provider).toBe('demo');
    conn.ws.close();
  });
});

describe('Meeting deletion', () => {
  it('deletes the meeting with its transcript', async () => {
    const c = await newUser('del@test.vn');
    const { json } = await c.req('POST', '/api/meetings', { title: 'Xóa' });
    expect((await c.req('DELETE', `/api/meetings/${json.meeting.id}`)).status).toBe(200);
    expect((await c.req('GET', `/api/meetings/${json.meeting.id}`)).status).toBe(404);
  });
});
