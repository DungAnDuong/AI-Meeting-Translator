import type { Meeting, MeetingSummary, Segment, Speaker } from '@amt/shared';
import { formatClock, speakerDisplayName } from '@amt/shared';
import { withRetry } from '../ai-provider-manager/retry';
import type { ITranslationProvider } from '../ai-provider-manager/types';

const SYSTEM = `You are a meticulous meeting secretary. You write meeting minutes in Vietnamese from a transcript.
Strict rules:
- Use ONLY information explicitly stated in the transcript. Never invent or guess.
- A decision is listed only if participants clearly agreed or confirmed it. Proposals or open discussion are NOT decisions.
- For action items, "owner" and "deadline" must be null unless they were explicitly stated in the transcript.
- Every decision and action item must include "evidence": a short verbatim quote (original language) from the transcript supporting it.
- Unresolved questions or topics deferred go to "openIssues".
- Keep technical codes, part numbers, drawing numbers, units and names unchanged.
- Output a single JSON object, no markdown fences, matching exactly:
{"overview": string, "topics": string[], "discussions": string[], "decisions": [{"text": string, "evidence": string}], "actionItems": [{"task": string, "owner": string|null, "deadline": string|null, "evidence": string}], "openIssues": string[]}`;

const PART_SYSTEM = `You are a meticulous meeting secretary. Extract concise Vietnamese notes from this PART of a meeting transcript:
key points, explicit decisions, explicit action items (with owner/deadline only if stated), and open questions.
Quote short verbatim evidence for each decision/action item. Never invent information. Plain text bullet list.`;

const CHUNK_CHARS = 60_000;

export function transcriptForSummary(segments: Segment[], speakers: Speaker[], timeZone?: string): string {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  return segments
    .filter((s) => s.originalText.trim())
    .map((s) => {
      const who = speakerDisplayName(s.speakerId ? byId.get(s.speakerId) : null);
      const vi = s.translatedText && s.translatedText !== s.originalText ? ` (VI: ${s.translatedText})` : '';
      return `[${formatClock(s.startedAt, timeZone)}] ${who}: ${s.originalText}${vi}`;
    })
    .join('\n');
}

export function parseSummaryJson(raw: string): Omit<MeetingSummary, 'generatedAt' | 'provider' | 'model' | 'editedMarkdown'> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI không trả về JSON hợp lệ cho báo cáo');
  const o = JSON.parse(raw.slice(start, end + 1));
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const opt = (v: unknown) => {
    const s = str(v);
    return s && !/^(null|none|không|chưa nêu|n\/a)$/i.test(s) ? s : null;
  };
  return {
    overview: str(o.overview),
    topics: arr(o.topics).map(str).filter(Boolean),
    discussions: arr(o.discussions).map(str).filter(Boolean),
    decisions: arr(o.decisions)
      .map((d: any) => ({ text: str(d?.text), evidence: str(d?.evidence) }))
      .filter((d) => d.text),
    actionItems: arr(o.actionItems)
      .map((a: any) => ({ task: str(a?.task), owner: opt(a?.owner), deadline: opt(a?.deadline), evidence: str(a?.evidence) }))
      .filter((a) => a.task),
    openIssues: arr(o.openIssues).map(str).filter(Boolean),
  };
}

/**
 * Tổng hợp báo cáo bằng AI đã chọn. Transcript dài được chia phần (map-reduce) thay vì cắt bớt.
 */
export async function generateSummary(
  meeting: Meeting,
  segments: Segment[],
  speakers: Speaker[],
  provider: ITranslationProvider,
  opts: { timeoutMs: number; retries: number; signal: AbortSignal; timeZone?: string },
): Promise<MeetingSummary> {
  const transcript = transcriptForSummary(segments, speakers, opts.timeZone);
  if (!transcript.trim()) throw new Error('Cuộc họp chưa có nội dung để tổng hợp');
  const call = (system: string, user: string, maxTokens: number) =>
    withRetry((signal) => provider.complete({ system, user, maxTokens, signal }), {
      provider: provider.id,
      retries: opts.retries,
      timeoutMs: Math.max(opts.timeoutMs, 120_000),
      signal: opts.signal,
    });

  let material = transcript;
  if (transcript.length > CHUNK_CHARS) {
    const lines = transcript.split('\n');
    const parts: string[] = [];
    let cur = '';
    for (const l of lines) {
      if (cur.length + l.length > CHUNK_CHARS && cur) (parts.push(cur), (cur = ''));
      cur += l + '\n';
    }
    if (cur) parts.push(cur);
    const notes: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      notes.push(`### Phần ${i + 1}/${parts.length}\n` + (await call(PART_SYSTEM, parts[i], 4000)));
    }
    material = `Ghi chú đã trích xuất từ từng phần của cuộc họp (theo thứ tự thời gian):\n\n${notes.join('\n\n')}`;
  }

  const header = `Tên cuộc họp: ${meeting.title}\nNgữ cảnh: ${meeting.context || '(không có)'}\n\nTranscript:\n`;
  const raw = await call(SYSTEM, header + material, 8000);
  return {
    ...parseSummaryJson(raw),
    generatedAt: new Date().toISOString(),
    provider: provider.id,
    model: provider.model,
    editedMarkdown: null,
  };
}

export function summaryToMarkdown(meeting: Meeting, s: MeetingSummary): string {
  if (s.editedMarkdown?.trim()) return s.editedMarkdown;
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- (Không có)');
  const lines = [
    `# Biên bản cuộc họp: ${meeting.title}`,
    '',
    `> Nội dung dưới đây do AI (${s.provider} · ${s.model}) tổng hợp từ transcript — cần được người tham dự kiểm tra lại. Trích dẫn trong ngoặc kép là lời được phát biểu nguyên văn.`,
    '',
    '## Tóm tắt',
    s.overview || '(Không có)',
    '',
    '## Chủ đề chính',
    list(s.topics),
    '',
    '## Vấn đề đã trao đổi',
    list(s.discussions),
    '',
    '## Quyết định đã được xác nhận',
    s.decisions.length ? s.decisions.map((d) => `- ${d.text}${d.evidence ? `\n  - Trích dẫn: "${d.evidence}"` : ''}`).join('\n') : '- (Không có quyết định được xác nhận rõ ràng)',
    '',
    '## Công việc cần thực hiện',
    s.actionItems.length
      ? s.actionItems
          .map(
            (a) =>
              `- ${a.task}\n  - Người phụ trách: ${a.owner ?? 'Chưa nêu rõ'}\n  - Thời hạn: ${a.deadline ?? 'Chưa nêu rõ'}${a.evidence ? `\n  - Trích dẫn: "${a.evidence}"` : ''}`,
          )
          .join('\n')
      : '- (Không có)',
    '',
    '## Vấn đề chưa được giải quyết',
    list(s.openIssues),
    '',
  ];
  return lines.join('\n');
}
