import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Bot,
  CircleStop,
  Cloud,
  CloudOff,
  Download,
  FileText,
  FlaskConical,
  Gauge,
  History,
  Languages,
  Loader2,
  Mic,
  MicOff,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Type,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { Meeting, ProviderPublicConfig } from '@amt/shared';
import { formatDuration, INPUT_LANGUAGES, languageName } from '@amt/shared';
import { listAudioInputs, supportsTabAudio } from '../audio/audio-capture';
import { TranscriptView } from '../components/TranscriptView';
import type { ViewMode } from '../components/SegmentCard';
import { ContextPanel, ExportModal, SpeakersPanel, SummaryPanel, TechPanel } from '../components/MeetingPanels';
import { Drawer, Modal, Notice } from '../components/ui';
import { useMeetingSession, type SourceChoice } from '../hooks/useMeetingSession';
import { api, errorText } from '../lib/api';
import { dataDestinations } from '../lib/providers';
import { derivePipelineStatus, useMeetingStore, type PipelineStatus } from '../store/meeting-store';

// ---------- tùy chọn hiển thị lưu theo trình duyệt ----------
function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, JSON.stringify(nv));
      } catch {
        /* bỏ qua */
      }
    },
    [key],
  );
  return [v, set];
}

const STATUS_META: Record<PipelineStatus, { label: string; icon: typeof Mic; cls: string }> = {
  waiting: { label: 'Đang chờ', icon: Pause, cls: 'bg-surface-2 text-muted' },
  listening: { label: 'Đang nghe', icon: Mic, cls: 'bg-ok-soft text-ok' },
  recognizing: { label: 'Đang nhận dạng giọng nói', icon: Loader2, cls: 'bg-accent-soft text-accent' },
  translating: { label: 'Đang dịch', icon: Languages, cls: 'bg-accent-soft text-accent' },
  disconnected: { label: 'Mất kết nối', icon: WifiOff, cls: 'bg-danger-soft text-danger' },
  paused: { label: 'Đã tạm dừng', icon: Pause, cls: 'bg-warn-soft text-warn' },
  ended: { label: 'Đã kết thúc', icon: CircleStop, cls: 'bg-surface-2 text-muted' },
};

function StatusPill() {
  const meeting = useMeetingStore((s) => s.meeting);
  const connection = useMeetingStore((s) => s.connection);
  const capture = useMeetingStore((s) => s.capture);
  const stats = useMeetingStore((s) => s.stats);
  const segments = useMeetingStore((s) => s.segments);
  const status = derivePipelineStatus({ meeting, connection, capture, stats, segments });
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ${m.cls}`} role="status" aria-live="polite">
      <Icon className={`size-4 ${status === 'recognizing' ? 'animate-spin' : status === 'listening' ? 'pulse' : ''}`} aria-hidden />
      {m.label}
    </span>
  );
}

function LevelMeter() {
  const level = useMeetingStore((s) => s.level);
  const capture = useMeetingStore((s) => s.capture);
  const muted = useMeetingStore((s) => s.muted);
  const pct = capture === 'capturing' && !muted ? Math.min(100, Math.round(Math.sqrt(level / 0.25) * 100)) : 0;
  return (
    <div className="flex items-center gap-1.5" title="Âm lượng đầu vào">
      <span className="sr-only">Âm lượng đầu vào {pct}%</span>
      <div className="h-2 w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div className={`h-full rounded-full transition-[width] duration-100 ${pct > 85 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Timer({ meeting }: { meeting: Meeting }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (meeting.endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [meeting.endedAt]);
  const ms = (meeting.endedAt ? Date.parse(meeting.endedAt) : now) - Date.parse(meeting.startedAt);
  return (
    <span className="font-mono text-sm tabular-nums" title="Thời gian cuộc họp">
      {formatDuration(ms)}
    </span>
  );
}

function MicIndicator() {
  const capture = useMeetingStore((s) => s.capture);
  const muted = useMeetingStore((s) => s.muted);
  const sources = useMeetingStore((s) => s.sources);
  const recording = capture === 'capturing' && !muted;
  const label = capture === 'capturing' ? (muted ? 'Micro đã tắt' : `Đang thu âm (${sources.length} nguồn)`) : capture === 'paused' ? 'Tạm dừng thu' : 'Không thu âm';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${recording ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted'}`} title={label}>
      {recording ? <span className="pulse size-2 rounded-full bg-danger" aria-hidden /> : <MicOff className="size-3.5" aria-hidden />}
      <span className="hidden sm:inline">{recording ? 'Đang thu' : capture === 'paused' ? 'Tạm dừng' : muted ? 'Tắt micro' : 'Không thu'}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </span>
  );
}

function AiIndicator() {
  const stats = useMeetingStore((s) => s.stats);
  const st = stats?.aiStatus ?? 'unknown';
  const meta = {
    ok: { t: 'AI: hoạt động', cls: 'bg-ok-soft text-ok', I: Cloud },
    degraded: { t: 'AI: gián đoạn', cls: 'bg-warn-soft text-warn', I: AlertTriangle },
    down: { t: 'AI: lỗi', cls: 'bg-danger-soft text-danger', I: CloudOff },
    unknown: { t: 'AI: chưa dùng', cls: 'bg-surface-2 text-muted', I: Bot },
  }[st];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`} title={stats?.aiStatusMessage ?? meta.t}>
      <meta.I className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{meta.t}</span>
      <span className="sr-only sm:hidden">{meta.t}</span>
    </span>
  );
}

function TitleEditor({ meeting }: { meeting: Meeting }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const { set, toast } = useMeetingStore.getState();
  useEffect(() => setTitle(meeting.title), [meeting.title]);
  const save = async () => {
    setEditing(false);
    if (!title.trim() || title === meeting.title) return setTitle(meeting.title);
    try {
      const r = await api<{ meeting: Meeting }>('PATCH', `/api/meetings/${meeting.id}`, { title });
      set({ meeting: r.meeting });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    }
  };
  return editing ? (
    <input
      className="input h-8 min-h-8 max-w-xs"
      autoFocus
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => e.key === 'Enter' && void save()}
      aria-label="Tên cuộc họp"
    />
  ) : (
    <button className="min-w-0 truncate text-left font-semibold hover:underline" onClick={() => setEditing(true)} title="Bấm để đổi tên cuộc họp">
      {meeting.title}
    </button>
  );
}

type SidePanel = 'speakers' | 'context' | 'tech' | 'controls' | null;

export function MeetingPage() {
  const { id = '' } = useParams();
  const session = useMeetingSession(id);
  const meeting = useMeetingStore((s) => s.meeting);
  const capture = useMeetingStore((s) => s.capture);
  const muted = useMeetingStore((s) => s.muted);
  const connection = useMeetingStore((s) => s.connection);
  const pendingUploads = useMeetingStore((s) => s.pendingUploads);
  const endPending = useMeetingStore((s) => s.endPending);
  const sources = useMeetingStore((s) => s.sources);
  const segmentCount = useMeetingStore((s) => s.order.length);
  const toast = useMeetingStore((s) => s.toast);

  const [view, setView] = usePref<ViewMode>('amt-view', 'stacked');
  const [showOriginal, setShowOriginal] = usePref('amt-show-original', true);
  const [fontSize, setFontSize] = usePref('amt-font', 17);
  const [sourceKey, setSourceKey] = usePref('amt-source', 'mic:');
  const [privacyAck, setPrivacyAck] = usePref('amt-privacy-ack', false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript');
  const [panel, setPanel] = useState<SidePanel>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [tabGuideOpen, setTabGuideOpen] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [settings, setSettings] = useState<ProviderPublicConfig | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--transcript-size', `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    void listAudioInputs().then(setDevices).catch(() => {});
    api<{ settings: ProviderPublicConfig }>('GET', '/api/settings').then((r) => setSettings(r.settings), () => {});
  }, [capture]);

  useEffect(() => {
    if (meeting) document.title = `${meeting.title} · AI Meeting Translator`;
    return () => void (document.title = 'AI Meeting Translator');
  }, [meeting?.title]);

  // Khi cuộc họp vừa kết thúc
  useEffect(() => {
    if (meeting?.status === 'ended' && ending) {
      setEnding(false);
      toast({ kind: 'success', message: 'Đã kết thúc cuộc họp. Bạn có thể xem lại, tạo báo cáo và xuất biên bản.' });
    }
  }, [meeting?.status, ending, toast]);

  const choice: SourceChoice = useMemo(() => {
    const [kind, deviceId] = sourceKey.split(':');
    if (kind === 'tab') return { kind: 'tab' };
    if (kind === 'mic+tab') return { kind: 'mic+tab', deviceId: deviceId || undefined };
    return { kind: 'mic', deviceId: deviceId || undefined };
  }, [sourceKey]);

  if (!meeting) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Loader2 className="size-5 animate-spin" aria-hidden /> Đang tải cuộc họp…
      </div>
    );
  }

  const ended = meeting.status === 'ended';
  const isDemo = meeting.isDemo;
  const paused = capture === 'paused' || (meeting.status === 'paused' && capture !== 'capturing');

  const beginCapture = async () => {
    setPrivacyOpen(false);
    setTabGuideOpen(false);
    if (isDemo) return session.startDemo();
    await session.start(choice);
  };

  const onStart = () => {
    if (isDemo) return session.startDemo();
    if (!privacyAck) return setPrivacyOpen(true);
    if (choice.kind !== 'mic') return setTabGuideOpen(true);
    void beginCapture();
  };

  const onResume = () => {
    if (isDemo) {
      session.startDemo();
      return;
    }
    if (!session.resume()) onStart();
  };

  const onEnd = async () => {
    setConfirmEnd(false);
    setEnding(true);
    if (isDemo) {
      void session.confirmEnd('abort');
      return;
    }
    const r = await session.requestEnd();
    if (r.unsent > 0) setUnsent(r.unsent);
  };

  const sourceHint =
    choice.kind === 'mic'
      ? 'Chỉ thu âm thanh quanh thiết bị này. Với cuộc họp online, giọng người khác chỉ thu được nếu phát ra loa – nên chọn "Âm thanh tab".'
      : 'Chọn đúng tab cuộc họp và bật "Chia sẻ âm thanh tab". Nên đeo tai nghe nếu thu cả micro để tránh trùng tiếng.';

  const sourceSelect = (
    <select className="input" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} disabled={capture !== 'idle' || isDemo} aria-label="Nguồn âm thanh">
      <option value="mic:">Micro của thiết bị (mặc định)</option>
      {devices
        .filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d, i) => (
          <option key={d.deviceId} value={`mic:${d.deviceId}`}>
            {d.label || `Thiết bị đầu vào ${i + 1}`}
          </option>
        ))}
      {supportsTabAudio() && <option value="tab:">Âm thanh tab / hệ thống (họp online)</option>}
      {supportsTabAudio() && <option value="mic+tab:">Micro + âm thanh tab</option>}
    </select>
  );

  const languageSelect = (
    <select
      className="input"
      value={meeting.sourceLanguage}
      disabled={isDemo || ended}
      aria-label="Ngôn ngữ đầu vào"
      onChange={async (e) => {
        try {
          const r = await api<{ meeting: Meeting }>('PATCH', `/api/meetings/${meeting.id}`, { sourceLanguage: e.target.value });
          useMeetingStore.getState().set({ meeting: r.meeting });
        } catch (err) {
          toast({ kind: 'error', message: errorText(err) });
        }
      }}
    >
      {INPUT_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.code === 'auto' ? 'Tự động nhận dạng' : `${l.name} (${l.english})`}
        </option>
      ))}
    </select>
  );

  // Nút điều khiển chính – dùng chung cho desktop và thanh dưới điện thoại
  const mainButtons = (big: boolean) => {
    const cls = big ? 'btn-lg flex-1' : '';
    if (ended) return null;
    return (
      <>
        {capture === 'idle' || capture === 'starting' ? (
          <button className={`btn btn-primary ${cls}`} onClick={onStart} disabled={capture === 'starting' || connection !== 'open'}>
            {capture === 'starting' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : isDemo ? <FlaskConical className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
            {segmentCount > 0 && !isDemo ? 'Tiếp tục thu âm' : isDemo ? 'Chạy demo' : 'Bắt đầu phiên dịch'}
          </button>
        ) : paused ? (
          <button className={`btn btn-primary ${cls}`} onClick={onResume}>
            <Play className="size-5" aria-hidden /> Tiếp tục
          </button>
        ) : (
          <button className={`btn ${cls}`} onClick={() => void session.pause()} disabled={capture === 'stopping'}>
            <Pause className="size-5" aria-hidden /> Tạm dừng
          </button>
        )}
        {capture === 'capturing' && !isDemo && sources.some((s) => s.kind === 'mic') && (
          <button className={`btn ${big ? 'btn-lg' : ''} ${muted ? 'border-danger text-danger' : ''}`} onClick={session.toggleMute} aria-pressed={muted} title={muted ? 'Bật micro' : 'Tắt micro'}>
            {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
            <span className={big ? 'sr-only' : ''}>{muted ? 'Bật micro' : 'Tắt micro'}</span>
          </button>
        )}
        <button className={`btn btn-danger ${big ? 'btn-lg' : ''}`} onClick={() => setConfirmEnd(true)} disabled={ending}>
          {ending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Square className="size-5" aria-hidden />}
          <span className={big ? 'sr-only sm:not-sr-only' : ''}>Kết thúc</span>
        </button>
      </>
    );
  };

  const sidebar = (p: Exclude<SidePanel, null | 'controls'>) =>
    p === 'speakers' ? <SpeakersPanel meetingId={meeting.id} /> : p === 'context' ? <ContextPanel meeting={meeting} /> : <TechPanel rttMs={session.metrics().rttMs} />;

  return (
    <div className="flex h-dvh flex-col">
      {/* ---------------- Thanh tiêu đề ---------------- */}
      <header className="z-20 border-b border-border bg-surface">
        <div className="flex items-center gap-2 px-2 py-2 sm:px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 font-bold" title="AI Meeting Translator – Trang chủ">
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Languages className="size-5" aria-hidden />
            </span>
            <span className="hidden lg:inline">AI Meeting Translator</span>
          </Link>
          <span className="hidden text-border lg:inline" aria-hidden>
            |
          </span>
          {isDemo && <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-xs font-bold text-warn">DEMO</span>}
          <div className="min-w-0 flex-1">
            <TitleEditor meeting={meeting} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <MicIndicator />
            <AiIndicator />
            <Timer meeting={meeting} />
            <Link to="/history" className="btn btn-ghost btn-icon" title="Lịch sử cuộc họp" aria-label="Lịch sử cuộc họp">
              <History className="size-5" aria-hidden />
            </Link>
            <Link to="/settings" className="btn btn-ghost btn-icon" title="Cài đặt" aria-label="Cài đặt">
              <Settings className="size-5" aria-hidden />
            </Link>
          </div>
        </div>
        {isDemo && (
          <div className="border-t border-warn/40 bg-warn-soft px-3 py-1 text-center text-xs font-medium text-warn">
            CHẾ ĐỘ DEMO – đang phát lại transcript mẫu, không phải phiên dịch thực tế. Không thu âm và không gọi dịch vụ AI.
          </div>
        )}

        {/* ---------------- Khu điều khiển (desktop/tablet) ---------------- */}
        {!ended && (
          <div className="hidden flex-wrap items-center gap-2 border-t border-border px-4 py-2 md:flex">
            <div className="w-52">{languageSelect}</div>
            <span className="text-sm text-muted">→ Tiếng Việt</span>
            <div className="w-64">{sourceSelect}</div>
            <div className="flex items-center gap-2">{mainButtons(false)}</div>
            <button className="btn" onClick={() => setExportOpen(true)}>
              <Download className="size-4" aria-hidden /> Xuất biên bản
            </button>
            <div className="ml-auto flex items-center gap-3">
              <LevelMeter />
              <StatusPill />
            </div>
          </div>
        )}
        {/* Trạng thái gọn trên điện thoại */}
        {!ended && (
          <div className="flex items-center gap-2 border-t border-border px-2 py-1.5 md:hidden">
            <StatusPill />
            <LevelMeter />
            <span className="ml-auto truncate text-xs text-muted">{languageName(meeting.sourceLanguage)} → Tiếng Việt</span>
          </div>
        )}
        {pendingUploads > 0 && (
          <div className="border-t border-warn/40 bg-warn-soft px-3 py-1 text-center text-xs font-medium text-warn" role="status">
            {pendingUploads} đoạn âm thanh đang chờ đồng bộ{connection !== 'open' ? ' – sẽ tự gửi lại khi có kết nối' : '…'}
          </div>
        )}
      </header>

      {/* ---------------- Thanh công cụ hiển thị ---------------- */}
      <div className="flex items-center gap-1 border-b border-border bg-surface px-2 py-1.5 sm:px-4">
        <div className="flex shrink-0 rounded-lg bg-surface-2 p-0.5" role="tablist">
          <button role="tab" aria-selected={tab === 'transcript'} className={`rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap sm:px-3 ${tab === 'transcript' ? 'bg-surface shadow-sm' : 'text-muted'}`} onClick={() => setTab('transcript')}>
            Bản dịch
          </button>
          <button role="tab" aria-selected={tab === 'summary'} className={`rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap sm:px-3 ${tab === 'summary' ? 'bg-surface shadow-sm' : 'text-muted'}`} onClick={() => setTab('summary')}>
            Biên bản AI
          </button>
        </div>
        {tab === 'transcript' && (
          <>
            <div className="ml-1 hidden rounded-lg bg-surface-2 p-0.5 sm:flex" role="group" aria-label="Chế độ hiển thị">
              {(
                [
                  ['stacked', 'Song ngữ'],
                  ['columns', 'Hai cột'],
                  ['vi', 'Chỉ tiếng Việt'],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  className={`rounded-md px-2.5 py-1.5 text-sm ${view === v ? 'bg-surface font-medium shadow-sm' : 'text-muted'} ${v === 'columns' ? 'hidden lg:block' : ''}`}
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {l}
                </button>
              ))}
            </div>
            <button
              className="btn btn-ghost h-9 min-h-9 sm:hidden"
              onClick={() => setView(view === 'vi' ? 'stacked' : 'vi')}
              aria-pressed={view === 'vi'}
              title="Chuyển giữa song ngữ và chỉ tiếng Việt"
            >
              {view === 'vi' ? 'Chỉ TV' : 'Song ngữ'}
            </button>
            {view !== 'vi' && (
              <label className="ml-1 hidden items-center gap-1.5 text-sm text-muted sm:flex">
                <input type="checkbox" className="size-4" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} />
                Hiện câu gốc
              </label>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {tab === 'transcript' &&
            (searchOpen ? (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
                <input className="input h-9 min-h-9 w-40 pl-8 sm:w-64" autoFocus placeholder="Tìm trong cuộc họp…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Tìm kiếm nội dung" />
                <button className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted" onClick={() => (setQuery(''), setSearchOpen(false))} aria-label="Đóng tìm kiếm">
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-icon h-9 min-h-9" onClick={() => setSearchOpen(true)} title="Tìm kiếm" aria-label="Tìm kiếm">
                <Search className="size-4" aria-hidden />
              </button>
            ))}
          <button className="btn btn-ghost btn-icon hidden h-9 min-h-9 sm:inline-flex" onClick={() => setFontSize(Math.max(14, fontSize - 1))} title="Chữ nhỏ hơn" aria-label="Chữ nhỏ hơn">
            <Type className="size-3.5" aria-hidden />
          </button>
          <button className="btn btn-ghost btn-icon hidden h-9 min-h-9 sm:inline-flex" onClick={() => setFontSize(Math.min(26, fontSize + 1))} title="Chữ lớn hơn" aria-label="Chữ lớn hơn">
            <Type className="size-5" aria-hidden />
          </button>
          <button className="btn btn-ghost btn-icon h-9 min-h-9 xl:hidden" onClick={() => setPanel('speakers')} title="Người nói" aria-label="Người nói">
            <Users className="size-4" aria-hidden />
          </button>
          <button className="btn btn-ghost btn-icon hidden h-9 min-h-9 md:inline-flex xl:hidden" onClick={() => setPanel('tech')} title="Thông tin kỹ thuật" aria-label="Thông tin kỹ thuật">
            <Gauge className="size-4" aria-hidden />
          </button>
          {ended && (
            <button className="btn h-9 min-h-9" onClick={() => setExportOpen(true)}>
              <Download className="size-4" aria-hidden /> <span className="hidden sm:inline">Xuất biên bản</span>
            </button>
          )}
        </div>
      </div>

      {/* ---------------- Nội dung ---------------- */}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {tab === 'transcript' ? (
            <>
              {!ended && meeting.status !== 'ended' && capture === 'idle' && segmentCount > 0 && !isDemo && (
                <div className="px-2 pt-2 sm:px-4">
                  <Notice kind="info">Cuộc họp vẫn đang mở. Bấm “Tiếp tục thu âm” để ghi tiếp – nội dung trước đó đã được lưu.</Notice>
                </div>
              )}
              <TranscriptView
                view={view}
                showOriginal={showOriginal}
                query={query}
                onRetry={session.retry}
                emptyHint={
                  ended ? (
                    'Cuộc họp không có nội dung.'
                  ) : (
                    <div className="max-w-sm space-y-2">
                      <Mic className="mx-auto size-10 text-accent" aria-hidden />
                      <p className="font-medium text-fg">{isDemo ? 'Bấm "Chạy demo" để xem transcript mẫu.' : 'Chọn nguồn âm thanh và bấm "Bắt đầu phiên dịch".'}</p>
                      {!isDemo && <p className="text-sm">{sourceHint}</p>}
                    </div>
                  )
                }
              />
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SummaryPanel meeting={meeting} />
            </div>
          )}
        </main>
        {/* Sidebar trên màn hình rộng */}
        <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface xl:flex">
          <SidebarTabs meeting={meeting} render={sidebar} />
        </aside>
      </div>

      {/* ---------------- Thanh điều khiển dưới (điện thoại) ---------------- */}
      {!ended && (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          {mainButtons(true)}
          <button className="btn btn-lg btn-icon w-12" onClick={() => setPanel('controls')} aria-label="Tùy chọn khác">
            <MoreHorizontal className="size-5" aria-hidden />
          </button>
        </div>
      )}

      {/* ---------------- Drawers & modals ---------------- */}
      <Drawer open={panel === 'controls'} onClose={() => setPanel(null)} title="Tùy chọn">
        <div className="space-y-4">
          <div>
            <span className="label">Ngôn ngữ đầu vào</span>
            {languageSelect}
          </div>
          <div>
            <span className="label">Nguồn âm thanh</span>
            {sourceSelect}
            <p className="mt-1 text-xs text-muted">{sourceHint}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} /> Hiện câu gốc (chế độ song ngữ)
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm">Cỡ chữ</span>
            <button className="btn" onClick={() => setFontSize(Math.max(14, fontSize - 1))} aria-label="Chữ nhỏ hơn">
              A−
            </button>
            <button className="btn" onClick={() => setFontSize(Math.min(26, fontSize + 1))} aria-label="Chữ lớn hơn">
              A+
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn" onClick={() => (setPanel(null), setExportOpen(true))}>
              <Download className="size-4" aria-hidden /> Xuất biên bản
            </button>
            <button className="btn" onClick={() => setPanel('speakers')}>
              <Users className="size-4" aria-hidden /> Người nói
            </button>
            <button className="btn" onClick={() => setPanel('context')}>
              <FileText className="size-4" aria-hidden /> Ngữ cảnh
            </button>
            <button className="btn" onClick={() => setPanel('tech')}>
              <SlidersHorizontal className="size-4" aria-hidden /> Kỹ thuật
            </button>
          </div>
        </div>
      </Drawer>
      <Drawer open={panel === 'speakers'} onClose={() => setPanel(null)} title="Người nói">
        <SpeakersPanel meetingId={meeting.id} />
      </Drawer>
      <Drawer open={panel === 'context'} onClose={() => setPanel(null)} title="Ngữ cảnh cuộc họp">
        <ContextPanel meeting={meeting} />
      </Drawer>
      <Drawer open={panel === 'tech'} onClose={() => setPanel(null)} title="Thông tin kỹ thuật">
        <TechPanel rttMs={session.metrics().rttMs} />
      </Drawer>

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} meeting={meeting} />

      <Modal
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        title="Trước khi bắt đầu thu âm"
        footer={
          <>
            <button className="btn" onClick={() => setPrivacyOpen(false)}>
              Hủy
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setPrivacyAck(true);
                if (choice.kind !== 'mic') {
                  setPrivacyOpen(false);
                  setTabGuideOpen(true);
                } else void beginCapture();
              }}
            >
              <Mic className="size-4" aria-hidden /> Đồng ý và bắt đầu
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>Ứng dụng sẽ xin quyền truy cập micro/âm thanh và chỉ thu khi bạn bấm Bắt đầu. Trạng thái thu âm luôn hiển thị ở thanh tiêu đề; bạn có thể tạm dừng hoặc tắt micro bất cứ lúc nào.</p>
          <p className="font-medium">Dữ liệu sẽ được gửi tới nhà cung cấp AI đã cấu hình:</p>
          <ul className="list-disc pl-5">
            {settings ? dataDestinations(settings).map((d) => <li key={d}>{d}</li>) : <li>Đang tải cấu hình…</li>}
          </ul>
          <p className="text-muted">
            {meeting.storeAudio ? 'Cuộc họp này có bật lưu file âm thanh gốc trên máy chủ.' : 'Âm thanh gốc không được lưu sau khi xử lý.'} Transcript và bản dịch được lưu trên máy chủ ứng dụng
            và có thể xóa trong Lịch sử. Hãy thông báo cho người tham dự rằng cuộc họp đang được ghi và phiên dịch.
          </p>
        </div>
      </Modal>

      <Modal
        open={tabGuideOpen}
        onClose={() => setTabGuideOpen(false)}
        title="Thu âm thanh cuộc họp online"
        footer={
          <>
            <button className="btn" onClick={() => (setSourceKey('mic:'), setTabGuideOpen(false))}>
              Dùng micro thay thế
            </button>
            <button className="btn btn-primary" onClick={() => void beginCapture()}>
              Chọn tab cuộc họp
            </button>
          </>
        }
      >
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Mở cuộc họp (Google Meet, Microsoft Teams, Zoom…) bằng trình duyệt trong một tab khác.</li>
          <li>
            Trong hộp thoại chia sẻ, chọn thẻ <b>Tab</b> → chọn đúng tab cuộc họp.
          </li>
          <li>
            Bật <b>“Chia sẻ âm thanh tab” / “Share tab audio”</b> rồi bấm Chia sẻ.
          </li>
        </ol>
        <div className="mt-3">
          <Notice kind="warn">
            Ứng dụng web không thể tự lấy âm thanh từ ứng dụng Zoom/Teams cài trên máy. Trên Windows có thể chọn “Toàn màn hình” + “Chia sẻ âm thanh hệ thống”. macOS/Safari và điện thoại thường
            không hỗ trợ – hãy dùng micro.
          </Notice>
        </div>
      </Modal>

      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="Kết thúc cuộc họp?"
        footer={
          <>
            <button className="btn" onClick={() => setConfirmEnd(false)}>
              Tiếp tục họp
            </button>
            <button className="btn btn-danger" onClick={() => void onEnd()}>
              <Square className="size-4" aria-hidden /> Kết thúc
            </button>
          </>
        }
      >
        <p className="text-sm">Thu âm sẽ dừng. Phần đang nói dở sẽ được gửi đi xử lý. Sau khi kết thúc, bạn có thể xem lại, chỉnh sửa, tạo báo cáo và xuất biên bản.</p>
      </Modal>

      <Modal
        open={unsent > 0}
        onClose={() => setUnsent(0)}
        title="Còn âm thanh chưa gửi được"
        footer={
          <>
            <button
              className="btn"
              onClick={async () => {
                setUnsent(0);
                const r = await session.requestEnd();
                if (r.unsent > 0) setUnsent(r.unsent);
              }}
            >
              Chờ thêm
            </button>
            <button className="btn btn-danger" onClick={() => (setUnsent(0), void session.confirmEnd('drain'))}>
              Kết thúc, bỏ qua {unsent} đoạn
            </button>
          </>
        }
      >
        <p className="text-sm">
          {unsent} đoạn âm thanh chưa tới được máy chủ ({connection === 'open' ? 'mạng chậm' : 'đang mất kết nối'}). Nếu kết thúc bây giờ, các đoạn này sẽ không được nhận dạng.
        </p>
      </Modal>

      <Modal
        open={endPending !== null && !ended}
        onClose={() => (useMeetingStore.getState().set({ endPending: null }), setEnding(false))}
        title="Còn nội dung đang xử lý"
        footer={
          <>
            <button className="btn btn-danger" onClick={() => (useMeetingStore.getState().set({ endPending: null }), void session.confirmEnd('abort'))}>
              Kết thúc ngay (hủy {endPending})
            </button>
            <button className="btn btn-primary" onClick={() => (useMeetingStore.getState().set({ endPending: null }), void session.confirmEnd('drain'))}>
              Chờ xử lý xong (khuyến nghị)
            </button>
          </>
        }
      >
        <p className="text-sm">
          Còn <b>{endPending}</b> đoạn đang được nhận dạng hoặc dịch. Chờ xử lý xong để biên bản đầy đủ, hoặc kết thúc ngay – các đoạn chưa xong sẽ được đánh dấu “Đã hủy”.
        </p>
      </Modal>
    </div>
  );
}

function SidebarTabs({ meeting, render }: { meeting: Meeting; render: (p: 'speakers' | 'context' | 'tech') => React.ReactNode }) {
  const [t, setT] = useState<'speakers' | 'context' | 'tech'>('speakers');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-border" role="tablist">
        {(
          [
            ['speakers', 'Người nói'],
            ['context', 'Ngữ cảnh'],
            ['tech', 'Kỹ thuật'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={t === k} className={`flex-1 py-2.5 text-sm font-medium ${t === k ? 'border-b-2 border-accent text-fg' : 'text-muted'}`} onClick={() => setT(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4" key={meeting.id}>
        {render(t)}
      </div>
    </div>
  );
}
