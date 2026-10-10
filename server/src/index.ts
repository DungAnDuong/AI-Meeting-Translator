import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp(config);

const shutdown = async (signal: string) => {
  app.log.info(`Nhận ${signal}, đang dừng máy chủ...`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
app.log.info(`AI Meeting Translator đang chạy tại http://localhost:${config.port}`);
