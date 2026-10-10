import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleDot, Loader2, Pause, Search, Trash2 } from 'lucide-react';
import type { Meeting } from '@amt/shared';
import { formatClock, formatDateVi, formatDuration, languageName } from '@amt/shared';
import { AppShell } from '../components/AppShell';
import { Modal, Notice } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useMeetingStore } from '../store/meeting-store';

export function HistoryPage() {
  const [q, setQ] = useState('');
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Meeting | null>(null);
  const toast = useMeetingStore((s) => s.toast);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ meetings: Meeting[] }>('GET', `/api/meetings${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`).then(
        (r) => (setMeetings(r.meetings), setError(null)),
        (e) => setError(errorText(e)),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const remove = async () => {
    if (!toDelete) return;
    try {
      await api('DELETE', `/api/meetings/${toDelete.id}`);
      setMeetings((m) => m?.filter((x) => x.id !== toDelete.id) ?? null);
      toast({ kind: 'success', message: 'Đã xóa cuộc họp và toàn bộ transcript' });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    }
    setToDelete(null);
  };

  return (
    <AppShell title="Lịch sử cuộc họp">
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          className="input pl-9"
          placeholder="Tìm theo tên cuộc họp hoặc nội dung phát biểu…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Tìm kiếm cuộc họp"
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {!meetings ? (
        <div className="flex items-center gap-2 text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Đang tải…
        </div>
      ) : meetings.length === 0 ? (
        <p className="text-muted">{q ? 'Không tìm thấy cuộc họp phù hợp.' : 'Chưa có cuộc họp nào.'}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {meetings.map((m) => (
            <li key={m.id} className="card flex flex-col p-4">
              <Link to={`/meetings/${m.id}`} className="flex-1">
                <div className="flex items-start gap-2">
                  <h2 className="flex-1 font-semibold">{m.title}</h2>
                  <StatusChip status={m.status} />
                </div>
                <dl className="mt-2 space-y-0.5 text-sm text-muted">
                  <div>
                    {formatDateVi(m.startedAt)} · {formatClock(m.startedAt).slice(0, 5)}
                    {m.endedAt && ` – ${formatClock(m.endedAt).slice(0, 5)} (${formatDuration(Date.parse(m.endedAt) - Date.parse(m.startedAt))})`}
                  </div>
                  <div>
                    {languageName(m.sourceLanguage)} → Tiếng Việt · {m.segmentCount ?? 0} lượt phát biểu
                  </div>
                  <div className="truncate">AI: {m.translationProvider}</div>
                </dl>
              </Link>
              <div className="mt-3 flex justify-end">
                <button className="btn btn-ghost text-danger" onClick={() => setToDelete(m)}>
                  <Trash2 className="size-4" aria-hidden /> Xóa
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Xóa cuộc họp?"
        footer={
          <>
            <button className="btn" onClick={() => setToDelete(null)}>
              Hủy
            </button>
            <button className="btn btn-danger" onClick={() => void remove()}>
              <Trash2 className="size-4" aria-hidden /> Xóa vĩnh viễn
            </button>
          </>
        }
      >
        <p>
          Cuộc họp <b>{toDelete?.title}</b> cùng toàn bộ transcript, bản dịch, tên người nói, báo cáo và file âm thanh (nếu có) sẽ bị xóa vĩnh viễn.
        </p>
      </Modal>
    </AppShell>
  );
}

function StatusChip({ status }: { status: Meeting['status'] }) {
  if (status === 'ended') return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">Đã kết thúc</span>;
  if (status === 'paused')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">
        <Pause className="size-3" aria-hidden /> Tạm dừng
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">
      <CircleDot className="size-3" aria-hidden /> Đang mở
    </span>
  );
}
