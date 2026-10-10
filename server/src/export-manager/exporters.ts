import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { Meeting, MeetingSummary, Segment, Speaker } from '@amt/shared';
import { formatClock, formatDateVi, formatSrtTime, languageName, slugifyFileName, speakerDisplayName } from '@amt/shared';
import { summaryToMarkdown } from '../meeting-summary/summary';

export type ExportFormat = 'txt' | 'md' | 'docx' | 'srt' | 'json';
export type ExportMode = 'both' | 'vi';

export interface ExportInput {
  meeting: Meeting;
  speakers: Speaker[];
  segments: Segment[];
  summary: MeetingSummary | null;
  mode: ExportMode;
  timeZone?: string;
  includeSummary?: boolean;
}

export interface ExportFile {
  fileName: string;
  contentType: string;
  body: Buffer;
}

const BOM = '﻿';

/** Tên file mặc định: <tên cuộc họp>_<yyyy-mm-dd>.<ext> */
export function exportFileName(meeting: Meeting, ext: string, suffix = ''): string {
  const d = formatDateVi(meeting.startedAt).split('/').reverse().join('-');
  return `${meeting.isDemo ? 'DEMO_' : ''}${slugifyFileName(meeting.title)}_${d}${suffix}.${ext}`;
}

function rows(input: ExportInput) {
  const byId = new Map(input.speakers.map((s) => [s.id, s]));
  return [...input.segments]
    .filter((s) => s.originalText.trim())
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.subIndex - b.subIndex)
    .map((s) => ({
      seg: s,
      time: formatClock(s.startedAt, input.timeZone),
      speaker: speakerDisplayName(s.speakerId ? byId.get(s.speakerId) : null),
      vi: s.translatedText.trim() || (s.status === 'error' ? '[Chưa dịch được]' : '[Đang chờ dịch]'),
    }));
}

function headerLines(input: ExportInput): string[] {
  const m = input.meeting;
  const end = m.endedAt ?? input.segments.at(-1)?.startedAt ?? m.startedAt;
  const speakers = input.speakers.map((s) => speakerDisplayName(s)).join(', ') || '(chưa xác định)';
  return [
    'AI MEETING TRANSLATOR',
    ...(m.isDemo ? ['[DEMO] Dữ liệu mẫu – không phải bản ghi cuộc họp thật'] : []),
    `Tên cuộc họp: ${m.title}`,
    `Ngày: ${formatDateVi(m.startedAt, input.timeZone)}`,
    `Thời gian: ${formatClock(m.startedAt, input.timeZone).slice(0, 5)} - ${formatClock(end, input.timeZone).slice(0, 5)}`,
    `Ngôn ngữ nguồn: ${languageName(m.sourceLanguage)} · Ngôn ngữ đích: ${languageName(m.targetLanguage)}`,
    `Người nói: ${speakers}`,
  ];
}

export function exportTxt(input: ExportInput): string {
  const out = [...headerLines(input), ''];
  for (const r of rows(input)) {
    out.push(`[${r.time}] ${r.speaker}${r.seg.overlap ? ' (nói chồng)' : ''}`);
    out.push('');
    if (input.mode === 'both') {
      out.push(`Original: ${r.seg.originalText}`);
      out.push('');
      out.push(`Vietnamese: ${r.vi}`);
    } else {
      out.push(r.vi);
    }
    out.push('');
  }
  if (input.includeSummary && input.summary) out.push('', '='.repeat(40), '', summaryToMarkdown(input.meeting, input.summary));
  return out.join('\r\n');
}

export function exportMarkdown(input: ExportInput): string {
  const [title, ...meta] = headerLines(input);
  const out = [`# ${title}`, '', ...meta.map((l) => `- ${l}`), '', '## Nội dung cuộc họp', ''];
  for (const r of rows(input)) {
    out.push(`**${r.speaker} — ${r.time}**${r.seg.overlap ? ' _(nói chồng)_' : ''}`, '');
    if (input.mode === 'both') out.push(`> ${r.seg.originalText}`, '', r.vi, '');
    else out.push(r.vi, '');
  }
  if (input.includeSummary && input.summary) out.push('---', '', summaryToMarkdown(input.meeting, input.summary));
  return out.join('\n');
}

export function exportSrt(input: ExportInput): string {
  return rows(input)
    .map((r, i) => {
      const s = r.seg;
      const end = Math.max(s.endOffsetMs, s.startOffsetMs + 1000);
      const text = input.mode === 'both' ? `${r.speaker}: ${s.originalText}\n${r.vi}` : `${r.speaker}: ${r.vi}`;
      return `${i + 1}\n${formatSrtTime(s.startOffsetMs)} --> ${formatSrtTime(end)}\n${text}\n`;
    })
    .join('\n');
}

export function exportJson(input: ExportInput): string {
  return JSON.stringify(
    {
      format: 'ai-meeting-translator/v1',
      meeting: input.meeting,
      speakers: input.speakers.map((s) => ({ ...s, name: speakerDisplayName(s) })),
      segments: rows(input).map((r) => ({ ...r.seg, speakerName: r.speaker })),
      summary: input.summary,
    },
    null,
    2,
  );
}

export async function exportDocx(input: ExportInput): Promise<Buffer> {
  const children: Paragraph[] = [];
  const [title, ...meta] = headerLines(input);
  children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  for (const l of meta) children.push(new Paragraph({ children: [new TextRun({ text: l, size: 22 })] }));
  children.push(new Paragraph({ text: 'Nội dung cuộc họp', heading: HeadingLevel.HEADING_1 }));
  for (const r of rows(input)) {
    children.push(
      new Paragraph({
        spacing: { before: 200 },
        children: [new TextRun({ text: `[${r.time}] ${r.speaker}`, bold: true }), ...(r.seg.overlap ? [new TextRun({ text: ' (nói chồng)', italics: true })] : [])],
      }),
    );
    if (input.mode === 'both') children.push(new Paragraph({ children: [new TextRun({ text: `Original: ${r.seg.originalText}`, color: '555555' })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: input.mode === 'both' ? `Tiếng Việt: ${r.vi}` : r.vi })] }));
  }
  if (input.includeSummary && input.summary) {
    for (const line of summaryToMarkdown(input.meeting, input.summary).split('\n')) {
      if (line.startsWith('# ')) children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      else if (line.startsWith('## ')) children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      else if (line.trim()) children.push(new Paragraph({ text: line.replace(/^> /, '').replace(/^(\s*)- /, '$1• ') }));
    }
  }
  const doc = new Document({ creator: 'AI Meeting Translator', title: input.meeting.title, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function buildExport(format: ExportFormat, input: ExportInput): Promise<ExportFile> {
  const suffix = input.mode === 'vi' ? '_tieng-viet' : '';
  switch (format) {
    case 'txt':
      return { fileName: exportFileName(input.meeting, 'txt', suffix), contentType: 'text/plain; charset=utf-8', body: Buffer.from(BOM + exportTxt(input), 'utf8') };
    case 'md':
      return { fileName: exportFileName(input.meeting, 'md', suffix), contentType: 'text/markdown; charset=utf-8', body: Buffer.from(exportMarkdown(input), 'utf8') };
    case 'srt':
      return { fileName: exportFileName(input.meeting, 'srt', suffix), contentType: 'application/x-subrip; charset=utf-8', body: Buffer.from(exportSrt(input), 'utf8') };
    case 'json':
      return { fileName: exportFileName(input.meeting, 'json'), contentType: 'application/json; charset=utf-8', body: Buffer.from(exportJson(input), 'utf8') };
    case 'docx':
      return {
        fileName: exportFileName(input.meeting, 'docx', suffix),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: await exportDocx(input),
      };
  }
}

export async function buildSummaryExport(meeting: Meeting, summary: MeetingSummary, format: 'md' | 'txt' | 'docx'): Promise<ExportFile> {
  const md = summaryToMarkdown(meeting, summary);
  if (format === 'md') return { fileName: exportFileName(meeting, 'md', '_bien-ban'), contentType: 'text/markdown; charset=utf-8', body: Buffer.from(md, 'utf8') };
  if (format === 'txt') return { fileName: exportFileName(meeting, 'txt', '_bien-ban'), contentType: 'text/plain; charset=utf-8', body: Buffer.from(BOM + md.replace(/\n/g, '\r\n'), 'utf8') };
  const children = md.split('\n').map((line) =>
    line.startsWith('# ')
      ? new Paragraph({ text: line.slice(2), heading: HeadingLevel.TITLE })
      : line.startsWith('## ')
        ? new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1 })
        : new Paragraph({ text: line.replace(/^> /, '').replace(/^(\s*)- /, '$1• ') }),
  );
  const doc = new Document({ creator: 'AI Meeting Translator', title: meeting.title, sections: [{ children }] });
  return {
    fileName: exportFileName(meeting, 'docx', '_bien-ban'),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    body: await Packer.toBuffer(doc),
  };
}

/** Content-Disposition hỗ trợ tên file Unicode (RFC 5987). */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
