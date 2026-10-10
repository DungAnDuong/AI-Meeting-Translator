import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app';

/** Xóa toàn bộ dữ liệu một cuộc họp: transcript, người nói, file âm thanh (nếu có). */
export function deleteMeetingData(ctx: Pick<AppContext, 'repo' | 'config'>, meetingId: string): void {
  for (const p of ctx.repo.listChunkAudioPaths(meetingId)) fs.rmSync(p, { force: true });
  fs.rmSync(path.join(ctx.config.audioDir, meetingId), { recursive: true, force: true });
  ctx.repo.deleteMeeting(meetingId);
}

/** Chính sách lưu trữ: RETENTION_DAYS > 0 thì tự xóa cuộc họp đã kết thúc quá số ngày đó. */
export function startRetentionJob(ctx: AppContext, log: { info: (o: object, m?: string) => void }): () => void {
  const run = () => {
    ctx.auth.purgeExpiredSessions();
    if (ctx.config.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - ctx.config.retentionDays * 86_400_000).toISOString();
    const ids = ctx.repo.listMeetingsEndedBefore(cutoff);
    for (const id of ids) deleteMeetingData(ctx, id);
    if (ids.length) log.info({ deleted: ids.length }, 'Đã xóa cuộc họp quá hạn lưu trữ');
  };
  run();
  const timer = setInterval(run, 6 * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
