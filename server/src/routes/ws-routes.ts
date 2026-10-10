import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerMessage } from '@amt/shared';
import { decodeAudioPacket, PCM_SAMPLE_RATE } from '@amt/shared';
import type { AppContext } from '../app';
import { runDemo } from '../meeting-session/demo';
import type { MeetingSession, SessionClient } from '../meeting-session/session';

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), meetingId: z.string().max(64), clientId: z.string().max(64) }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('end'), mode: z.enum(['ask', 'drain', 'abort']) }),
  z.object({ type: z.literal('retry_segment'), segmentId: z.string().max(64) }),
  z.object({ type: z.literal('demo_start') }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);

/**
 * Kênh thời gian thực: client gửi âm thanh (nhị phân) + lệnh điều khiển (JSON);
 * server đẩy cập nhật transcript, người nói, trạng thái, thống kê độ trễ.
 */
export async function registerWebSocket(app: FastifyInstance, ctx: AppContext) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const user = req.user;
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    if (!user) {
      send({ type: 'error', code: 'auth', message: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' });
      socket.close(4401, 'unauthorized');
      return;
    }

    let session: MeetingSession | null = null;
    const client: SessionClient = { id: crypto.randomUUID(), userId: user.id, send };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (!session) return send({ type: 'error', code: 'no_session', message: 'Chưa tham gia cuộc họp' });
          const { header, pcm } = decodeAudioPacket(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          if (header.type !== 'chunk' || header.sampleRate !== PCM_SAMPLE_RATE) {
            return send({ type: 'error', code: 'bad_chunk', message: 'Định dạng âm thanh không hỗ trợ' });
          }
          session.handleChunk(header, pcm, client);
          return;
        }
        const msg = clientMessage.parse(JSON.parse(data.toString('utf8')));
        switch (msg.type) {
          case 'hello': {
            if (ctx.repo.getMeetingOwner(msg.meetingId) !== user.id) {
              send({ type: 'error', code: 'not_found', message: 'Không tìm thấy cuộc họp hoặc bạn không có quyền truy cập' });
              return;
            }
            session?.detach(client);
            session = ctx.sessions.get(msg.meetingId);
            session?.attach(client);
            return;
          }
          case 'ping':
            return send({ type: 'pong', t: msg.t, serverNow: Date.now() });
        }
        if (!session) return send({ type: 'error', code: 'no_session', message: 'Chưa tham gia cuộc họp' });
        switch (msg.type) {
          case 'pause':
            return session.pause();
          case 'resume':
            return session.resume();
          case 'end':
            void session.end(msg.mode, client);
            return;
          case 'retry_segment':
            return session.retrySegment(msg.segmentId, client);
          case 'demo_start':
            if (!session.meeting.isDemo) return send({ type: 'error', code: 'demo', message: 'Chỉ dùng cho cuộc họp demo' });
            if (session.meeting.status === 'paused') session.resume();
            runDemo(session, ctx.repo).catch((err) => req.log.warn({ err: (err as Error).message }, 'Demo dừng'));
            return;
        }
      } catch (err) {
        send({ type: 'error', code: 'bad_message', message: 'Tin nhắn không hợp lệ' });
        req.log.warn({ err: (err as Error).message }, 'WS message lỗi');
      }
    });

    socket.on('close', () => session?.detach(client));
  });
}
