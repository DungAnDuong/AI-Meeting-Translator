import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Máy chủ HTTP CHỈ DÙNG TRONG KIỂM THỬ: mô phỏng giao thức (định dạng request/response) của
 * OpenAI /v1/audio/transcriptions, /v1/chat/completions, /v1/models và Anthropic /v1/messages
 * để kiểm tra các adapter thật mà không cần API key. Không được dùng trong ứng dụng.
 */
export type MockMode = 'ok' | 'auth' | 'quota' | 'rate_limit' | 'server_error' | 'slow' | 'model_not_found';

export interface MockState {
  mode: MockMode;
  transcript: string;
  translation: string;
  diarized: Array<{ speaker: string; start: number; end: number; text: string }>;
  requests: Array<{ path: string; model?: string; fields: Record<string, string>; body?: any }>;
  slowMs: number;
  /** Nếu đặt, lỗi mô phỏng chỉ áp dụng cho endpoint này. */
  failOnly: string | null;
  /** Nếu có: mỗi lần gọi STT lấy câu kế tiếp. */
  transcriptQueue: string[];
  /** Bảng tra bản dịch theo câu gốc (dùng trong kiểm thử trình duyệt). */
  translations: Record<string, string>;
}

export async function startMockAiServer(): Promise<{ url: string; state: MockState; close: () => Promise<void> }> {
  const state: MockState = {
    mode: 'ok',
    transcript: 'We need to finish the electrical design before Friday.',
    translation: 'Chúng ta cần hoàn thành thiết kế điện trước thứ Sáu.',
    diarized: [],
    requests: [],
    slowMs: 5000,
    failOnly: null,
    transcriptQueue: [],
    translations: {},
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const path = (req.url ?? '').split('?')[0];

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Lỗi mô phỏng
    const applies = !state.failOnly || state.failOnly === path;
    if (applies && (path !== '/v1/models' || state.mode === 'auth')) {
      if (state.mode === 'auth') return sendJson(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (state.mode === 'quota') return sendJson(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } });
      if (state.mode === 'rate_limit') return sendJson(429, { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } });
      if (state.mode === 'server_error') return sendJson(500, { error: { message: 'Internal error', type: 'server_error' } });
      if (state.mode === 'model_not_found') return sendJson(404, { error: { message: 'The model does not exist', code: 'model_not_found' } });
      if (state.mode === 'slow') await new Promise((r) => setTimeout(r, state.slowMs));
    }

    if (path === '/v1/models' && req.method === 'GET') {
      return sendJson(200, { object: 'list', data: [{ id: 'test-llm', object: 'model' }, { id: 'test-stt', object: 'model' }] });
    }

    if (path === '/v1/audio/transcriptions') {
      const text = raw.toString('latin1');
      const fields: Record<string, string> = {};
      for (const m of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2];
      state.requests.push({ path, model: fields.model, fields });
      if (!/RIFF/.test(text)) return sendJson(400, { error: { message: 'Invalid file format' } });
      if (state.transcriptQueue.length) state.transcript = state.transcriptQueue.shift()!;
      if (fields.response_format === 'diarized_json') {
        return sendJson(200, { task: 'transcribe', duration: 6, text: state.diarized.map((d) => d.text).join(' '), segments: state.diarized.map((d, i) => ({ id: `seg_${i}`, type: 'transcript.text.segment', ...d })) });
      }
      if (fields.stream === 'true') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const w of state.transcript.split(' ')) {
          res.write(`data: ${JSON.stringify({ type: 'transcript.text.delta', delta: w + ' ' })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'transcript.text.done', text: state.transcript })}\n\n`);
        return res.end();
      }
      if (fields.response_format === 'verbose_json') return sendJson(200, { text: state.transcript, language: 'english', duration: 3, segments: [] });
      return sendJson(200, { text: state.transcript });
    }

    if (path === '/v1/chat/completions') {
      const body = JSON.parse(raw.toString('utf8'));
      state.requests.push({ path, model: body.model, fields: {}, body });
      const userMsg: string = body.messages?.[1]?.content ?? '';
      const hit = Object.keys(state.translations).find((k) => userMsg.includes(`<utterance>\n${k}`));
      if (hit) state.translation = state.translations[hit];
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const w of state.translation.split(' ')) {
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { content: w + ' ' }, finish_reason: null }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return sendJson(200, { id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: state.translation }, finish_reason: 'stop' }] });
    }

    if (path === '/v1/messages') {
      const body = JSON.parse(raw.toString('utf8'));
      state.requests.push({ path, model: body.model, fields: { beta: String(req.headers['anthropic-beta'] ?? '') }, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const w of state.translation.split(' ')) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: w + ' ' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
      ev('message_stop', {});
      return res.end();
    }

    sendJson(404, { error: { message: 'not found' } });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

/** Tạo PCM 16 kHz có "tiếng" (sóng sin) dài ms mili-giây. */
export function makeSpeechPcm(ms: number, amplitude = 6000): Int16Array {
  const n = Math.round((ms / 1000) * 16000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * amplitude);
  return pcm;
}
