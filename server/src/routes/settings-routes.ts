import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, type AppContext } from '../app';
import { runConnectionTest } from '../ai-provider-manager/connection-test';
import { OPENAI_STT_MODELS } from '../speech-recognition/openai-stt';
import { settingsPatchSchema, SettingsValidationError } from '../settings/settings-service';

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/settings', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return {
      settings: ctx.settings.getPublic(user.id),
      capabilities: { openaiSttModels: OPENAI_STT_MODELS },
    };
  });

  app.put('/api/settings', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Cấu hình không hợp lệ', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    try {
      const settings = ctx.settings.update(user.id, parsed.data);
      ctx.sessions.reloadForUser(user.id);
      return { settings };
    } catch (err) {
      if (err instanceof SettingsValidationError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/settings/test', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { target } = z.object({ target: z.enum(['openai', 'anthropic', 'local-stt', 'local-llm', 'pipeline']) }).parse(req.body);
    const results = await runConnectionTest(target, ctx.settings.resolve(user.id));
    return { results };
  });
}
