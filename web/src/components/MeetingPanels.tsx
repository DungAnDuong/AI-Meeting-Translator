import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, Merge, Save, Sparkles } from 'lucide-react';
import type { Meeting, MeetingSummary, Segment, Speaker } from '@amt/shared';
import { formatDuration, INPUT_LANGUAGES, speakerDisplayName } from '@amt/shared';
import { api, errorText } from '../lib/api';
import { useMeetingStore } from '../store/meeting-store';
import { Field, Modal, Notice } from './ui';

// ------------------------------------------------------------------ Người nói
export function SpeakersPanel({ meetingId }: { meetingId: string }) {
  const speakersMap = useMeetingStore((s) => s.speakers);
  const segments = useMeetingStore((s) => s.segments);
  const { upsertSpeaker, load, toast } = useMeetingStore.getState();
  const speakers = useMemo(() => Object.values(speakersMap).sort((a, b) => a.colorIndex - b.colorIndex), [speakersMap]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of Object.values(segments)) c[s.speakerId ?? '-'] = (c[s.speakerId ?? '-'] ?? 0) + 1;
    return c;
  }, [segments]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [merge, setMerge] = useState<{ from: Speaker; into: string } | null>(null);

  const rename = async (sp: Speaker) => {
    const displayName = (names[sp.id] ?? sp.displayName ?? '').trim();
    if (displayName === (sp.displayName ?? '')) return;
    try {
      const r = await api<{ speaker: Speaker }>('PATCH', `/api/meetings/${meetingId}/speakers/${sp.id}`, { displayName: displayName || null });
      upsertSpeaker(r.speaker);
      toast({ kind: 'success', message: `Đã cập nhật tên cho toàn bộ lượt phát biểu của Speaker ${sp.label}` });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    }
  };

  const doMerge = async () => {
    if (!merge?.into) return;
    try {
      const r = await api<{ speakers: Speaker[]; segments: Segment[] }>('POST', `/api/meetings/${meetingId}/speakers/merge`, { fromId: merge.from.id, intoId: merge.into });
      const meeting = useMeetingStore.getState().meeting!;
      load({ meeting, speakers: r.speakers, segments: r.segments });
      toast({ kind: 'success', message: 'Đã gộp người nói' });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    }
    setMerge(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Nhãn A, B, C… được gán theo thứ tự phát hiện. Đổi tên thật sẽ cập nhật mọi lượt phát biểu và bản xuất. Nếu hệ thống tách nhầm một người thành hai nhãn, hãy dùng “Gộp”.
      </p>
      {speakers.length === 0 && <p className="text-sm text-muted">Chưa phát hiện người nói nào.</p>}
      {speakers.map((sp) => (
        <div key={sp.id} className={`spk-${sp.colorIndex % 8} rounded-xl border border-border p-3`}>
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: 'var(--spk)' }} aria-hidden>
              {sp.label}
            </span>
            <span className="font-semibold">Speaker {sp.label}</span>
            <span className="ml-auto text-xs text-muted">{counts[sp.id] ?? 0} lượt</span>
          </div>
          <div className="flex gap-2">
            <input
              className="input"
              aria-label={`Tên thật của Speaker ${sp.label}`}
              placeholder="Nhập tên thật…"
              value={names[sp.id] ?? sp.displayName ?? ''}
              onChange={(e) => setNames({ ...names, [sp.id]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void rename(sp)}
              onBlur={() => void rename(sp)}
              maxLength={100}
            />
            {speakers.length > 1 && (
              <button className="btn" onClick={() => setMerge({ from: sp, into: '' })} title="Gộp vào người nói khác">
                <Merge className="size-4" aria-hidden />
                <span className="sr-only">Gộp</span>
              </button>
            )}
          </div>
        </div>
      ))}
      {(counts['-'] ?? 0) > 0 && <p className="text-sm text-muted">Không xác định: {counts['-']} lượt (có thể gán người nói trong phần Chỉnh sửa của từng lượt).</p>}
      <Modal
        open={!!merge}
        onClose={() => setMerge(null)}
        title={`Gộp ${merge ? speakerDisplayName(merge.from) : ''}`}
        footer={
          <>
            <button className="btn" onClick={() => setMerge(null)}>
              Hủy
            </button>
            <button className="btn btn-primary" disabled={!merge?.into} onClick={() => void doMerge()}>
              Gộp
            </button>
          </>
        }
      >
        <Field label="Chuyển toàn bộ lượt phát biểu sang">
          <select className="input" value={merge?.into ?? ''} onChange={(e) => merge && setMerge({ ...merge, into: e.target.value })}>
            <option value="">— Chọn người nói —</option>
            {speakers
              .filter((x) => x.id !== merge?.from.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {speakerDisplayName(x)}
                </option>
              ))}
          </select>
        </Field>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ Ngữ cảnh
export function ContextPanel({ meeting }: { meeting: Meeting }) {
  const [context, setContext] = useState(meeting.context);
  const [glossary, setGlossary] = useState(meeting.glossary);
  const [lang, setLang] = useState(meeting.sourceLanguage);
  const [saving, setSaving] = useState(false);
  const { set, toast } = useMeetingStore.getState();
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ meeting: Meeting }>('PATCH', `/api/meetings/${meeting.id}`, { context, glossary, sourceLanguage: lang });
      set({ meeting: r.meeting });
      toast({ kind: 'success', message: 'Đã lưu – áp dụng cho các câu tiếp theo' });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      <Field label="Ngôn ngữ đầu vào">
        <select className="input" value={lang} onChange={(e) => setLang(e.target.value)} disabled={meeting.isDemo}>
          {INPUT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Ngữ cảnh cuộc họp" hint="Lĩnh vực, dự án, chủ đề… giúp dịch chính xác hơn.">
        <textarea className="input" rows={4} value={context} onChange={(e) => setContext(e.target.value)} maxLength={4000} />
      </Field>
      <Field label="Thuật ngữ riêng của cuộc họp" hint='Mỗi dòng "thuật ngữ = cách dịch". Bổ sung cho danh sách chung trong Cài đặt.'>
        <textarea className="input font-mono text-sm" rows={5} value={glossary} onChange={(e) => setGlossary(e.target.value)} spellCheck={false} />
      </Field>
      <button className="btn btn-primary w-full" onClick={() => void save()} disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />} Lưu
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Kỹ thuật
export function TechPanel({ rttMs }: { rttMs: number | null }) {
  const stats = useMeetingStore((s) => s.stats);
  const connection = useMeetingStore((s) => s.connection);
  const pendingUploads = useMeetingStore((s) => s.pendingUploads);
  const uiLatencyMs = useMeetingStore((s) => s.uiLatencyMs);
  const count = useMeetingStore((s) => s.order.length);
  const meeting = useMeetingStore((s) => s.meeting);
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const rows: Array<[string, string]> = [
    ['Kết nối máy chủ', connection === 'open' ? `Đã kết nối${rttMs !== null ? ` (ping ${rttMs} ms)` : ''}` : connection === 'connecting' ? 'Đang kết nối…' : 'Mất kết nối'],
    ['Trạng thái AI', stats ? { ok: 'Hoạt động', degraded: 'Gián đoạn', down: 'Lỗi', unknown: 'Chưa sử dụng' }[stats.aiStatus] : '—'],
    ['Độ trễ nhận dạng (gần nhất / TB)', `${ms(stats?.lastSttLatencyMs)} / ${ms(stats?.avgSttLatencyMs)}`],
    ['Độ trễ dịch (gần nhất / TB)', `${ms(stats?.lastTranslationLatencyMs)} / ${ms(stats?.avgTranslationLatencyMs)}`],
    ['Độ trễ cập nhật giao diện', ms(uiLatencyMs)],
    ['Số lượt phát biểu', String(count)],
    ['Đoạn âm thanh chờ đồng bộ', String(pendingUploads)],
    ['Đang nhận dạng / chờ', stats ? `${stats.processingChunks} / ${stats.queuedChunks}` : '—'],
    ['Đang chờ dịch', String(stats?.pendingTranslations ?? 0)],
    ['Số lỗi xử lý', String(stats?.errors ?? 0)],
    ['Speech-to-Text', meeting?.sttProvider ?? '—'],
    ['Dịch thuật', meeting?.translationProvider ?? '—'],
  ];
  return (
    <div>
      <dl className="divide-y divide-border text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-2">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {stats?.aiStatusMessage && <Notice kind={stats.aiStatus === 'down' ? 'error' : 'warn'}>{stats.aiStatusMessage}</Notice>}
      <p className="mt-3 text-xs text-muted">
        Độ trễ thực tế phụ thuộc nguồn âm thanh, mạng, model và nhà cung cấp; không có cam kết độ trễ cố định. Văn bản xuất hiện sau khi người nói ngừng ~0,6 giây (cuối câu) hoặc tối đa ~14 giây với câu dài.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ Xuất file
export function ExportModal({ open, onClose, meeting }: { open: boolean; onClose: () => void; meeting: Meeting }) {
  const [format, setFormat] = useState<'txt' | 'md' | 'docx' | 'srt' | 'json'>('txt');
  const [mode, setMode] = useState<'both' | 'vi'>('both');
  const [withSummary, setWithSummary] = useState(false);
  const summary = useMeetingStore((s) => s.summary);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const href = `/api/meetings/${meeting.id}/export?format=${format}&mode=${mode}&tz=${encodeURIComponent(tz)}&summary=${withSummary ? 1 : 0}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Xuất biên bản"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
          <a className="btn btn-primary" href={href} download onClick={() => setTimeout(onClose, 300)}>
            <Download className="size-4" aria-hidden /> Tải xuống
          </a>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Định dạng">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(
              [
                ['txt', 'TXT (UTF-8)'],
                ['docx', 'Word (DOCX)'],
                ['md', 'Markdown'],
                ['srt', 'Phụ đề SRT'],
                ['json', 'JSON (tích hợp)'],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className={`btn justify-start ${format === v ? 'border-accent bg-accent-soft' : ''}`}>
                <input type="radio" name="fmt" className="sr-only" checked={format === v} onChange={() => setFormat(v)} />
                <FileText className="size-4" aria-hidden /> {l}
              </label>
            ))}
          </div>
        </Field>
        {format !== 'json' && (
          <Field label="Nội dung">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'both' | 'vi')}>
              <option value="both">Cả hai ngôn ngữ (gốc + tiếng Việt)</option>
              <option value="vi">Chỉ tiếng Việt</option>
            </select>
          </Field>
        )}
        {format !== 'srt' && format !== 'json' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={withSummary} disabled={!summary} onChange={(e) => setWithSummary(e.target.checked)} />
            Kèm báo cáo tóm tắt {summary ? '' : '(chưa tạo)'}
          </label>
        )}
        {meeting.status !== 'ended' && <Notice kind="warn">Cuộc họp chưa kết thúc – file chỉ chứa nội dung tính đến thời điểm hiện tại.</Notice>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Báo cáo AI
export function SummaryPanel({ meeting }: { meeting: Meeting }) {
  const summary = useMeetingStore((s) => s.summary);
  const count = useMeetingStore((s) => s.order.length);
  const { set, toast } = useMeetingStore.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [md, setMd] = useState('');

  useEffect(() => setEditing(false), [summary?.generatedAt]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ summary: MeetingSummary }>('POST', `/api/meetings/${meeting.id}/summary`, { tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      set({ summary: r.summary });
    } catch (e) {
      setError({ message: errorText(e), hint: (e as { hint?: string }).hint });
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (value: string | null) => {
    try {
      const r = await api<{ summary: MeetingSummary }>('PUT', `/api/meetings/${meeting.id}/summary`, { editedMarkdown: value });
      set({ summary: r.summary });
      setEditing(false);
      toast({ kind: 'success', message: value ? 'Đã lưu bản chỉnh sửa' : 'Đã khôi phục bản do AI tạo' });
    } catch (e) {
      toast({ kind: 'error', message: errorText(e) });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-primary" onClick={() => void generate()} disabled={busy || count === 0}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
          {summary ? 'Tạo lại báo cáo' : 'Tạo báo cáo bằng AI'}
        </button>
        {summary && !editing && (
          <button className="btn" onClick={() => (setMd(summary.editedMarkdown ?? summaryMarkdown(meeting, summary)), setEditing(true))}>
            Chỉnh sửa
          </button>
        )}
        {summary && (
          <div className="ml-auto flex gap-1">
            {(['docx', 'md', 'txt'] as const).map((f) => (
              <a key={f} className="btn" href={`/api/meetings/${meeting.id}/summary/export?format=${f}`} download>
                <Download className="size-4" aria-hidden /> {f.toUpperCase()}
              </a>
            ))}
          </div>
        )}
      </div>
      {count === 0 && <p className="text-sm text-muted">Chưa có nội dung để tổng hợp.</p>}
      {error && (
        <Notice kind="error">
          {error.message}
          {error.hint && <div className="text-muted">{error.hint}</div>}
        </Notice>
      )}
      {summary && (
        <Notice kind="warn">
          Nội dung do AI ({summary.provider} · {summary.model}) tổng hợp – cần kiểm tra lại. Quyết định, người phụ trách và thời hạn chỉ được ghi khi được nêu rõ trong cuộc họp; trích dẫn
          trong ngoặc kép là lời phát biểu nguyên văn.
        </Notice>
      )}
      {summary && editing && (
        <div className="space-y-2">
          <textarea className="input min-h-[50dvh] font-mono text-sm" value={md} onChange={(e) => setMd(e.target.value)} aria-label="Nội dung báo cáo (Markdown)" />
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => void saveEdit(md)}>
              <Save className="size-4" aria-hidden /> Lưu bản chỉnh sửa
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Hủy
            </button>
            {summary.editedMarkdown && (
              <button className="btn btn-ghost" onClick={() => void saveEdit(null)}>
                Khôi phục bản AI
              </button>
            )}
          </div>
        </div>
      )}
      {summary && !editing && (summary.editedMarkdown ? <MarkdownView md={summary.editedMarkdown} /> : <SummaryView s={summary} />)}
    </div>
  );
}

function SummaryView({ s }: { s: MeetingSummary }) {
  const List = ({ items, empty }: { items: string[]; empty: string }) =>
    items.length ? (
      <ul className="list-disc space-y-1 pl-5">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    ) : (
      <p className="text-muted">{empty}</p>
    );
  return (
    <div className="card space-y-5 p-4 sm:p-5">
      <section>
        <h3 className="mb-1 font-semibold">Tóm tắt</h3>
        <p>{s.overview || '—'}</p>
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Chủ đề chính</h3>
        <List items={s.topics} empty="Không có" />
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Vấn đề đã trao đổi</h3>
        <List items={s.discussions} empty="Không có" />
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Quyết định đã được xác nhận</h3>
        {s.decisions.length ? (
          <ul className="space-y-2">
            {s.decisions.map((d, i) => (
              <li key={i}>
                <div>{d.text}</div>
                {d.evidence && <blockquote className="mt-0.5 border-l-2 border-border pl-2 text-sm text-muted">“{d.evidence}”</blockquote>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Không có quyết định được xác nhận rõ ràng.</p>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Công việc cần thực hiện</h3>
        {s.actionItems.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 pr-2 font-medium">Công việc</th>
                  <th className="py-1 pr-2 font-medium">Phụ trách</th>
                  <th className="py-1 font-medium">Thời hạn</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {s.actionItems.map((a, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-1.5 pr-2">
                      {a.task}
                      {a.evidence && <div className="text-xs text-muted">“{a.evidence}”</div>}
                    </td>
                    <td className={`py-1.5 pr-2 ${a.owner ? '' : 'text-muted italic'}`}>{a.owner ?? 'Chưa nêu rõ'}</td>
                    <td className={`py-1.5 ${a.deadline ? '' : 'text-muted italic'}`}>{a.deadline ?? 'Chưa nêu rõ'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted">Không có</p>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Vấn đề chưa được giải quyết</h3>
        <List items={s.openIssues} empty="Không có" />
      </section>
    </div>
  );
}

function MarkdownView({ md }: { md: string }) {
  return (
    <div className="card space-y-1 p-4 sm:p-5">
      {md.split('\n').map((line, i) =>
        line.startsWith('# ') ? (
          <h2 key={i} className="pt-2 text-lg font-bold">
            {line.slice(2)}
          </h2>
        ) : line.startsWith('## ') ? (
          <h3 key={i} className="pt-3 font-semibold">
            {line.slice(3)}
          </h3>
        ) : line.startsWith('> ') ? (
          <p key={i} className="text-sm text-muted">
            {line.slice(2)}
          </p>
        ) : line.trim() ? (
          <p key={i} style={{ paddingLeft: `${(line.match(/^\s*/)?.[0].length ?? 0) * 0.5}rem` }}>
            {line.trim().replace(/^- /, '• ')}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** Markdown ban đầu cho trình chỉnh sửa (giống bản máy chủ xuất ra). */
function summaryMarkdown(meeting: Meeting, s: MeetingSummary): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (Không có)');
  return [
    `# Biên bản cuộc họp: ${meeting.title}`,
    '',
    `> Nội dung do AI (${s.provider} · ${s.model}) tổng hợp – đã được người dùng chỉnh sửa.`,
    '',
    '## Tóm tắt',
    s.overview,
    '',
    '## Chủ đề chính',
    list(s.topics),
    '',
    '## Vấn đề đã trao đổi',
    list(s.discussions),
    '',
    '## Quyết định đã được xác nhận',
    s.decisions.length ? s.decisions.map((d) => `- ${d.text}${d.evidence ? `\n  - Trích dẫn: "${d.evidence}"` : ''}`).join('\n') : '- (Không có)',
    '',
    '## Công việc cần thực hiện',
    s.actionItems.length
      ? s.actionItems.map((a) => `- ${a.task}\n  - Người phụ trách: ${a.owner ?? 'Chưa nêu rõ'}\n  - Thời hạn: ${a.deadline ?? 'Chưa nêu rõ'}`).join('\n')
      : '- (Không có)',
    '',
    '## Vấn đề chưa được giải quyết',
    list(s.openIssues),
    '',
  ].join('\n');
}

export function meetingDurationMs(m: Meeting, now: number): number {
  return (m.endedAt ? Date.parse(m.endedAt) : now) - Date.parse(m.startedAt);
}
export { formatDuration };
