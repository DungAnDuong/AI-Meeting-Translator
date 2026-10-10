import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FlaskConical, Loader2, Mic, PlayCircle } from 'lucide-react';
import type { Meeting, ProviderPublicConfig } from '@amt/shared';
import { formatClock, formatDateVi, INPUT_LANGUAGES } from '@amt/shared';
import { AppShell } from '../components/AppShell';
import { Field, Notice } from '../components/ui';
import { api, errorText } from '../lib/api';
import { providerSummary } from '../lib/providers';

function defaultTitle() {
  const d = new Date();
  return `Cuộc họp ${formatDateVi(d)} ${formatClock(d).slice(0, 5)}`;
}

export function HomePage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState(defaultTitle);
  const [sourceLanguage, setSourceLanguage] = useState(() => localStorageGet('amt-lang') ?? 'auto');
  const [context, setContext] = useState('');
  const [storeAudio, setStoreAudio] = useState(false);
  const [busy, setBusy] = useState<'real' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [settings, setSettings] = useState<ProviderPublicConfig | null>(null);

  useEffect(() => {
    api<{ meetings: Meeting[] }>('GET', '/api/meetings').then((r) => setRecent(r.meetings.slice(0, 6)), () => {});
    api<{ settings: ProviderPublicConfig }>('GET', '/api/settings').then((r) => setSettings(r.settings), () => {});
  }, []);

  const create = async (demo: boolean) => {
    setBusy(demo ? 'demo' : 'real');
    setError(null);
    try {
      localStorageSet('amt-lang', sourceLanguage);
      const r = await api<{ meeting: Meeting }>('POST', '/api/meetings', {
        title: demo ? 'Họp dự án tủ điện' : title.trim() || defaultTitle(),
        sourceLanguage,
        context,
        storeAudio,
        demo,
      });
      navigate(`/meetings/${r.meeting.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create(false);
  };

  const summary = settings ? providerSummary(settings) : null;
  const active = recent.filter((m) => m.status !== 'ended');

  return (
    <AppShell>
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <form onSubmit={onSubmit} className="card space-y-4 p-4 sm:p-5">
          <h1 className="text-xl font-bold">Cuộc họp mới</h1>
          <Field label="Tên cuộc họp" htmlFor="title">
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ngôn ngữ đầu vào" htmlFor="lang">
              <select id="lang" className="input" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)}>
                {INPUT_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                    {l.code !== 'auto' ? ` (${l.english})` : ' (Auto Detect)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ngôn ngữ đầu ra">
              <input className="input" value="Tiếng Việt" disabled />
            </Field>
          </div>
          <Field
            label="Ngữ cảnh cuộc họp (không bắt buộc)"
            htmlFor="ctx"
            hint="Mô tả lĩnh vực, dự án, chủ đề hoặc tên riêng thường gặp – giúp AI dịch đúng thuật ngữ."
          >
            <textarea
              id="ctx"
              className="input"
              rows={3}
              maxLength={4000}
              placeholder="VD: Họp thiết kế tủ điện nhà máy ABC, PLC Siemens S7-1500, bản vẽ E-xxx…"
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={storeAudio} onChange={(e) => setStoreAudio(e.target.checked)} />
            <span>
              Lưu file âm thanh gốc trên máy chủ
              <span className="block text-muted">Mặc định tắt: âm thanh chỉ được giữ tạm trong bộ nhớ khi xử lý rồi xóa.</span>
            </span>
          </label>
          {summary && (
            <Notice kind={summary.ready ? 'info' : 'warn'}>
              <div>
                Speech-to-Text: <b>{summary.stt}</b> · Dịch: <b>{summary.translation}</b> · Phân biệt người nói: <b>{summary.diarization}</b>
              </div>
              {!summary.ready && (
                <div className="mt-1">
                  {summary.problem}{' '}
                  <Link to="/settings" className="font-semibold text-accent underline">
                    Mở Cài đặt AI
                  </Link>
                </div>
              )}
            </Notice>
          )}
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn btn-primary btn-lg flex-1" disabled={!!busy}>
              {busy === 'real' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Mic className="size-5" aria-hidden />}
              Tạo cuộc họp
            </button>
            <button type="button" className="btn btn-lg" onClick={() => void create(true)} disabled={!!busy} title="Phát lại transcript mẫu, không cần API Key">
              {busy === 'demo' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <FlaskConical className="size-5" aria-hidden />}
              Thử chế độ Demo
            </button>
          </div>
          <p className="text-xs text-muted">
            Chế độ Demo phát lại một transcript mẫu (được gắn nhãn [DEMO]) để làm quen giao diện – không thu âm và không gọi dịch vụ AI.
          </p>
        </form>

        <section className="space-y-4">
          {active.length > 0 && (
            <div className="card p-4">
              <h2 className="mb-2 font-semibold">Đang diễn ra</h2>
              <ul className="space-y-1">
                {active.map((m) => (
                  <li key={m.id}>
                    <Link to={`/meetings/${m.id}`} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-2">
                      <PlayCircle className="size-4 text-accent" aria-hidden />
                      <span className="flex-1 truncate">{m.title}</span>
                      <span className="text-xs text-muted">{m.status === 'paused' ? 'Tạm dừng' : 'Đang mở'}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Gần đây</h2>
              <Link to="/history" className="text-sm font-medium text-accent">
                Xem tất cả
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="text-sm text-muted">Chưa có cuộc họp nào.</p>
            ) : (
              <ul className="space-y-1">
                {recent.map((m) => (
                  <li key={m.id}>
                    <Link to={`/meetings/${m.id}`} className="block rounded-lg px-2 py-2 hover:bg-surface-2">
                      <div className="truncate font-medium">{m.title}</div>
                      <div className="text-xs text-muted">
                        {formatDateVi(m.startedAt)} {formatClock(m.startedAt).slice(0, 5)} · {m.segmentCount ?? 0} lượt phát biểu
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* bỏ qua */
  }
}
