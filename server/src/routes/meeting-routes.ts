import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Meeting, MeetingSummary } from '@amt/shared';
import { INPUT_LANGUAGES } from '@amt/shared';
import { requireUser, type AppContext } from '../app';
import { classifyError } from '../ai-provider-manager/errors';
import { createTranslationProvider, describeProviders } from '../ai-provider-manager/registry';
import { buildExport, buildSummaryExport, contentDisposition, type ExportFormat } from '../export-manager/exporters';
import { generateSummary } from '../meeting-summary/summary';
import { deleteMeetingData } from '../meeting-session/retention';
import { DEMO_SUMMARY } from '../meeting-session/demo-summary';

const languageCodes = INPUT_LANGUAGES.map((l) => l.code) as [string, ...string[]];

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceLanguage: z.enum(languageCodes).default('auto'),
  context: z.string().max(4000).default(''),
  glossary: z.string().max(20_000).default(''),
  storeAudio: z.boolean().default(false),
  demo: z.boolean().default(false),
});

const timeZone = z
  .string()
  .max(64)
  .optional()
  .refine((tz) => {
    if (!tz) return true;
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  });

export async function registerMeetingRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Kiểm tra quyền truy cập: chỉ chủ sở hữu mới thấy cuộc họp (404 để không lộ sự tồn tại). */
  const owned = (req: FastifyRequest, reply: FastifyReply): Meeting | null => {
    const user = requireUser(req, reply);
    if (!user) return null;
    const id = (req.params as { id: string }).id;
    if (ctx.repo.getMeetingOwner(id) !== user.id) {
      reply.code(404).send({ error: 'Không tìm thấy cuộc họp' });
      return null;
    }
    return ctx.sessions.peek(id)?.meeting ?? ctx.repo.getMeeting(id);
  };

  app.get('/api/meetings', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { q } = z.object({ q: z.string().max(200).optional() }).parse(req.query);
    return { meetings: ctx.repo.listMeetings(user.id, q) };
  });

  app.post('/api/meetings', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = createSchema.parse(req.body);
    const settings = ctx.settings.resolve(user.id);
    const providers = body.demo ? { stt: 'demo', translation: 'demo' } : describeProviders(settings);
    const meeting = ctx.repo.createMeeting({
      ownerId: user.id,
      title: body.demo && !body.title.startsWith('[DEMO]') ? `[DEMO] ${body.title}` : body.title,
      context: body.context,
      glossary: body.glossary,
      sourceLanguage: body.sourceLanguage,
      sttProvider: providers.stt,
      translationProvider: providers.translation,
      diarizationMode: body.demo ? 'none' : settings.pipeline.diarizationMode,
      storeAudio: body.storeAudio && !body.demo,
      isDemo: body.demo,
    });
    return reply.code(201).send({ meeting });
  });

  app.get('/api/meetings/:id', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    return {
      meeting,
      speakers: ctx.repo.listSpeakers(meeting.id),
      segments: ctx.repo.listSegments(meeting.id),
      summary: ctx.repo.getSummary(meeting.id),
    };
  });

  app.patch('/api/meetings/:id', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const body = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        context: z.string().max(4000).optional(),
        glossary: z.string().max(20_000).optional(),
        sourceLanguage: z.enum(languageCodes).optional(),
      })
      .parse(req.body);
    const updated = ctx.repo.updateMeeting(meeting.id, body);
    const session = ctx.sessions.peek(meeting.id);
    if (session) {
      session.meeting = updated;
      session.broadcast({ type: 'meeting', meeting: updated });
    }
    return { meeting: updated };
  });

  app.delete('/api/meetings/:id', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const session = ctx.sessions.peek(meeting.id);
    if (session && !session.isEnded) await session.end('abort');
    deleteMeetingData(ctx, meeting.id);
    return { ok: true };
  });

  /** Kết thúc qua REST (khi không còn kết nối WebSocket). */
  app.post('/api/meetings/:id/end', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { mode } = z.object({ mode: z.enum(['drain', 'abort']).default('drain') }).parse(req.body ?? {});
    const session = ctx.sessions.get(meeting.id);
    if (session) await session.end(mode);
    return { meeting: ctx.repo.getMeeting(meeting.id) };
  });

  // ---------------- Người nói ----------------
  app.patch('/api/meetings/:id/speakers/:speakerId', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { speakerId } = req.params as { speakerId: string };
    const { displayName } = z.object({ displayName: z.string().max(100).nullable() }).parse(req.body);
    const sp = ctx.repo.getSpeaker(speakerId);
    if (!sp || sp.meetingId !== meeting.id) return reply.code(404).send({ error: 'Không tìm thấy người nói' });
    // Tên được lưu ở bảng speakers → mọi lượt phát biểu liên quan tự hiển thị tên mới.
    const speaker = ctx.repo.renameSpeaker(speakerId, displayName);
    ctx.sessions.peek(meeting.id)?.broadcast({ type: 'speaker', speaker });
    return { speaker };
  });

  app.post('/api/meetings/:id/speakers/merge', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { fromId, intoId } = z.object({ fromId: z.string(), intoId: z.string() }).parse(req.body);
    const from = ctx.repo.getSpeaker(fromId);
    const into = ctx.repo.getSpeaker(intoId);
    if (!from || !into || from.meetingId !== meeting.id || into.meetingId !== meeting.id || fromId === intoId) {
      return reply.code(400).send({ error: 'Người nói không hợp lệ' });
    }
    const moved = ctx.repo.mergeSpeakers(meeting.id, fromId, intoId);
    return { moved, speakers: ctx.repo.listSpeakers(meeting.id), segments: ctx.repo.listSegments(meeting.id) };
  });

  // ---------------- Lượt phát biểu ----------------
  app.patch('/api/meetings/:id/segments/:segmentId', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { segmentId } = req.params as { segmentId: string };
    const body = z
      .object({
        originalText: z.string().max(10_000).optional(),
        translatedText: z.string().max(10_000).optional(),
        speakerId: z.string().nullable().optional(),
        retranslate: z.boolean().default(false),
      })
      .parse(req.body);
    const seg = ctx.repo.getSegment(segmentId);
    if (!seg || seg.meetingId !== meeting.id) return reply.code(404).send({ error: 'Không tìm thấy lượt phát biểu' });
    if (body.speakerId) {
      const sp = ctx.repo.getSpeaker(body.speakerId);
      if (!sp || sp.meetingId !== meeting.id) return reply.code(400).send({ error: 'Người nói không hợp lệ' });
    }
    let updated = ctx.repo.updateSegment(segmentId, {
      originalText: body.originalText,
      originalEdited: body.originalText !== undefined && body.originalText !== seg.originalText ? true : undefined,
      translatedText: body.translatedText,
      translationEdited: body.translatedText !== undefined && body.translatedText !== seg.translatedText ? true : undefined,
      speakerId: body.speakerId,
      // Sửa tay một đoạn lỗi → coi như đã xác nhận
      status: seg.status === 'error' && body.translatedText?.trim() ? 'final' : undefined,
      error: seg.status === 'error' && body.translatedText?.trim() ? null : undefined,
    });
    const session = ctx.sessions.get(meeting.id);
    session?.emitSegment(updated);
    if (body.retranslate && updated.originalText.trim() && !meeting.isDemo) {
      session?.retranslate(segmentId);
      updated = ctx.repo.getSegment(segmentId)!;
    }
    return { segment: updated };
  });

  app.post('/api/meetings/:id/segments/:segmentId/retry', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { segmentId } = req.params as { segmentId: string };
    const seg = ctx.repo.getSegment(segmentId);
    if (!seg || seg.meetingId !== meeting.id) return reply.code(404).send({ error: 'Không tìm thấy lượt phát biểu' });
    ctx.sessions.get(meeting.id)?.retrySegment(segmentId);
    return { ok: true };
  });

  // ---------------- Xuất file ----------------
  app.get('/api/meetings/:id/export', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const q = z
      .object({
        format: z.enum(['txt', 'md', 'docx', 'srt', 'json']).default('txt'),
        mode: z.enum(['both', 'vi']).default('both'),
        tz: timeZone,
        summary: z.enum(['0', '1']).default('0'),
      })
      .parse(req.query);
    const file = await buildExport(q.format as ExportFormat, {
      meeting,
      speakers: ctx.repo.listSpeakers(meeting.id),
      segments: ctx.repo.listSegments(meeting.id),
      summary: ctx.repo.getSummary(meeting.id),
      mode: q.mode,
      timeZone: q.tz,
      includeSummary: q.summary === '1',
    });
    reply.header('Content-Type', file.contentType);
    reply.header('Content-Disposition', contentDisposition(file.fileName));
    reply.header('Cache-Control', 'no-store');
    return reply.send(file.body);
  });

  // ---------------- Tóm tắt / biên bản ----------------
  app.post('/api/meetings/:id/summary', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const user = req.user!;
    const { tz } = z.object({ tz: timeZone }).parse(req.body ?? {});
    let summary: MeetingSummary;
    if (meeting.isDemo) {
      summary = { ...DEMO_SUMMARY, generatedAt: new Date().toISOString() };
    } else {
      const settings = ctx.settings.resolve(user.id);
      try {
        const provider = createTranslationProvider(settings);
        summary = await generateSummary(meeting, ctx.repo.listSegments(meeting.id), ctx.repo.listSpeakers(meeting.id), provider, {
          timeoutMs: settings.pipeline.requestTimeoutMs,
          retries: settings.pipeline.maxRetries,
          signal: AbortSignal.timeout(10 * 60_000),
          timeZone: tz,
        });
      } catch (err) {
        if (err instanceof Error && /chưa có nội dung|JSON/.test(err.message)) return reply.code(422).send({ error: err.message });
        const pe = classifyError(err, settings.pipeline.translationProvider);
        return reply.code(502).send({ error: pe.message, hint: pe.hint });
      }
    }
    ctx.repo.saveSummary(meeting.id, summary);
    return { summary };
  });

  app.put('/api/meetings/:id/summary', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { editedMarkdown } = z.object({ editedMarkdown: z.string().max(200_000).nullable() }).parse(req.body);
    const current = ctx.repo.getSummary(meeting.id);
    if (!current) return reply.code(404).send({ error: 'Chưa có báo cáo để chỉnh sửa' });
    const summary = { ...current, editedMarkdown: editedMarkdown?.trim() ? editedMarkdown : null };
    ctx.repo.saveSummary(meeting.id, summary);
    return { summary };
  });

  app.get('/api/meetings/:id/summary/export', async (req, reply) => {
    const meeting = owned(req, reply);
    if (!meeting) return;
    const { format } = z.object({ format: z.enum(['md', 'txt', 'docx']).default('md') }).parse(req.query);
    const summary = ctx.repo.getSummary(meeting.id);
    if (!summary) return reply.code(404).send({ error: 'Chưa có báo cáo' });
    const file = await buildSummaryExport(meeting, summary, format);
    reply.header('Content-Type', file.contentType);
    reply.header('Content-Disposition', contentDisposition(file.fileName));
    reply.header('Cache-Control', 'no-store');
    return reply.send(file.body);
  });
}
