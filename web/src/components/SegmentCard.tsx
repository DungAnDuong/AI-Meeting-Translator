import { memo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, Loader2, Pencil, RotateCcw, Users } from 'lucide-react';
import type { Segment, Speaker } from '@amt/shared';
import { formatClock, languageName, speakerDisplayName } from '@amt/shared';
import { api, errorText } from '../lib/api';
import { useMeetingStore } from '../store/meeting-store';

export type ViewMode = 'stacked' | 'columns' | 'vi';

interface Props {
  segment: Segment;
  speaker: Speaker | null;
  speakers: Speaker[];
  continued: boolean;
  view: ViewMode;
  showOriginal: boolean;
  query: string;
  readOnlyStatus?: boolean;
  onRetry: (id: string) => void;
}

/** Bỏ dấu tiếng Việt để tìm kiếm không phân biệt dấu. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function highlight(text: string, query: string): ReactNode {
  const q = fold(query.trim());
  if (!q) return text;
  const f = fold(text);
  const parts: ReactNode[] = [];
  let i = 0;
  let idx = f.indexOf(q);
  while (idx >= 0) {
    parts.push(text.slice(i, idx), <mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = f.indexOf(q, i);
  }
  parts.push(text.slice(i));
  return parts;
}

function StatusBadge({ s }: { s: Segment }) {
  if (s.status === 'final')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-ok" title="Đã xác nhận và lưu">
        <CheckCircle2 className="size-3.5" aria-hidden /> Đã xác nhận
      </span>
    );
  if (s.status === 'error')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
        <AlertTriangle className="size-3.5" aria-hidden /> Lỗi
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warn" title="Nội dung tạm thời, có thể thay đổi">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {s.status === 'transcribing' ? 'Đang nhận dạng…' : 'Đang dịch…'} (tạm thời)
    </span>
  );
}

export const SegmentCard = memo(function SegmentCard({ segment: s, speaker, speakers, continued, view, showOriginal, query, onRetry }: Props) {
  const [editing, setEditing] = useState(false);
  const [orig, setOrig] = useState(s.originalText);
  const [vi, setVi] = useState(s.translatedText);
  const [spk, setSpk] = useState<string>(s.speakerId ?? '');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toast = useMeetingStore((st) => st.toast);
  const upsertSegment = useMeetingStore((st) => st.upsertSegment);

  const tentative = s.status === 'transcribing' || s.status === 'translating' || s.interim;
  const name = speakerDisplayName(speaker);
  const time = formatClock(s.startedAt);
  const colorClass = speaker ? `spk-${speaker.colorIndex % 8}` : 'spk-unknown';

  const startEdit = () => {
    setOrig(s.originalText);
    setVi(s.translatedText);
    setSpk(s.speakerId ?? '');
    setEditing(true);
  };

  const save = async (retranslate: boolean) => {
    setSaving(true);
    try {
      const r = await api<{ segment: Segment }>('PATCH', `/api/meetings/${s.meetingId}/segments/${s.id}`, {
        originalText: orig !== s.originalText ? orig : undefined,
        translatedText: !retranslate && vi !== s.translatedText ? vi : undefined,
        speakerId: spk !== (s.speakerId ?? '') ? spk || null : undefined,
        retranslate,
      });
      upsertSegment(r.segment);
      setEditing(false);
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    const text = `[${time}] ${name}\nOriginal: ${s.originalText}\nTiếng Việt: ${s.translatedText}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ kind: 'error', message: 'Không sao chép được (trình duyệt chặn quyền clipboard)' });
    }
  };

  const original = s.originalText ? (
    <p className={`transcript-text text-muted ${view === 'vi' ? 'text-[0.9em]' : ''} ${s.interim && s.status === 'transcribing' ? 'italic' : ''}`} lang={s.language ?? undefined}>
      {view !== 'vi' && <span className="sr-only">Câu gốc: </span>}
      {highlight(s.originalText, query)}
    </p>
  ) : s.status === 'transcribing' ? (
    <p className="transcript-text text-muted italic">Đang nhận dạng giọng nói…</p>
  ) : null;

  const translated = s.translatedText ? (
    <p className={`transcript-text font-medium ${tentative ? 'opacity-80' : ''}`} lang="vi">
      {highlight(s.translatedText, query)}
    </p>
  ) : s.status === 'translating' ? (
    <p className="transcript-text text-muted italic">Đang dịch…</p>
  ) : s.status === 'error' && !s.translatedText && s.originalText ? (
    <p className="transcript-text text-muted italic">Chưa có bản dịch</p>
  ) : null;

  return (
    <article
      className={`${colorClass} group relative rounded-xl border bg-surface px-3 py-2.5 sm:px-4 ${
        tentative ? 'border-dashed border-warn/60' : s.status === 'error' ? 'border-danger/50' : 'border-border'
      } ${continued ? 'mt-1' : 'mt-3'}`}
      style={{ borderLeft: '4px solid var(--spk)' }}
      aria-label={`${name}, ${time}`}
    >
      <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {!continued || editing ? (
          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--spk)' }}>
            <span className="inline-flex size-6 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: 'var(--spk)' }} aria-hidden>
              {speaker ? speaker.label : '?'}
            </span>
            {name}
          </span>
        ) : (
          <span className="sr-only">{name}</span>
        )}
        <time className="text-sm text-muted tabular-nums" dateTime={s.startedAt}>
          {time}
        </time>
        <StatusBadge s={s} />
        {s.overlap && (
          <span className="inline-flex items-center gap-1 rounded bg-warn-soft px-1.5 text-xs text-warn" title="Có nhiều người nói cùng lúc">
            <Users className="size-3" aria-hidden /> Nói chồng
          </span>
        )}
        {(s.originalEdited || s.translationEdited) && <span className="rounded bg-surface-2 px-1.5 text-xs text-muted">Đã chỉnh sửa</span>}
        {s.language && s.language !== 'en' && s.language !== 'vi' && <span className="text-xs text-muted">{languageName(s.language)}</span>}
        <div className="ml-auto flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <button className="btn btn-ghost btn-icon h-8 min-h-8 w-8" onClick={() => void copy()} title="Sao chép lượt phát biểu" aria-label="Sao chép lượt phát biểu">
            {copied ? <Check className="size-4 text-ok" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </button>
          {!editing && !tentative && (
            <button className="btn btn-ghost btn-icon h-8 min-h-8 w-8" onClick={startEdit} title="Chỉnh sửa" aria-label="Chỉnh sửa lượt phát biểu">
              <Pencil className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </header>

      {editing ? (
        <div className="space-y-2">
          <label className="label" htmlFor={`o-${s.id}`}>
            Văn bản gốc
          </label>
          <textarea id={`o-${s.id}`} className="input" rows={2} value={orig} onChange={(e) => setOrig(e.target.value)} />
          <label className="label" htmlFor={`v-${s.id}`}>
            Tiếng Việt
          </label>
          <textarea id={`v-${s.id}`} className="input" rows={2} value={vi} onChange={(e) => setVi(e.target.value)} />
          <label className="label" htmlFor={`s-${s.id}`}>
            Người nói
          </label>
          <select id={`s-${s.id}`} className="input" value={spk} onChange={(e) => setSpk(e.target.value)}>
            <option value="" disabled={!!s.speakerId}>
              Không xác định
            </option>
            {speakers.map((x) => (
              <option key={x.id} value={x.id}>
                {speakerDisplayName(x)}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn btn-primary" onClick={() => void save(false)} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} Lưu
            </button>
            {orig !== s.originalText && (
              <button className="btn" onClick={() => void save(true)} disabled={saving} title="Lưu văn bản gốc và dịch lại bằng AI">
                Lưu & dịch lại
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>
              Hủy
            </button>
          </div>
        </div>
      ) : view === 'columns' ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div>{showOriginal && original}</div>
          <div>{translated}</div>
        </div>
      ) : view === 'vi' ? (
        <div>
          {translated ?? original}
          {s.originalText && translated && (
            <>
              <button className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />} Câu gốc
              </button>
              {(expanded || (query && fold(s.originalText).includes(fold(query)))) && original}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          {showOriginal && original}
          {translated}
        </div>
      )}

      {s.status === 'error' && !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-2.5 py-1.5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden />
          <span className="flex-1">{s.error}</span>
          <button className="btn h-8 min-h-8" onClick={() => onRetry(s.id)}>
            <RotateCcw className="size-3.5" aria-hidden /> Thử lại
          </button>
          {s.originalText && (
            <button className="btn btn-ghost h-8 min-h-8" onClick={startEdit}>
              Tự nhập bản dịch
            </button>
          )}
        </div>
      )}
    </article>
  );
});
