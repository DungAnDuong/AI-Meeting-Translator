import { describe, expect, it } from 'vitest';
import type { Meeting, Segment, Speaker } from '@amt/shared';
import { buildExport, contentDisposition, exportFileName, exportSrt, exportTxt } from '../src/export-manager/exporters';
import { parseSummaryJson, summaryToMarkdown } from '../src/meeting-summary/summary';

const meeting: Meeting = {
  id: 'm1',
  title: 'Họp dự án tủ điện',
  context: '',
  glossary: '',
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  status: 'ended',
  sttProvider: 'openai',
  translationProvider: 'openai',
  diarizationMode: 'openai',
  storeAudio: false,
  isDemo: false,
  startedAt: '2026-10-09T03:00:00.000Z',
  endedAt: '2026-10-09T04:00:00.000Z',
  createdAt: '2026-10-09T03:00:00.000Z',
  updatedAt: '2026-10-09T04:00:00.000Z',
};

const speakers: Speaker[] = [
  { id: 'sa', meetingId: 'm1', label: 'A', displayName: null, colorIndex: 0 },
  { id: 'sb', meetingId: 'm1', label: 'B', displayName: 'Anh Nam', colorIndex: 1 },
];

const seg = (id: string, offsetS: number, speakerId: string | null, en: string, vi: string): Segment => ({
  id,
  meetingId: 'm1',
  chunkId: null,
  subIndex: 0,
  speakerId,
  sourceId: 'x',
  startOffsetMs: offsetS * 1000,
  endOffsetMs: offsetS * 1000 + 3000,
  startedAt: new Date(Date.parse(meeting.startedAt) + offsetS * 1000).toISOString(),
  language: 'en',
  originalText: en,
  translatedText: vi,
  status: 'final',
  error: null,
  originalEdited: false,
  translationEdited: false,
  overlap: false,
  sttLatencyMs: 1,
  translationLatencyMs: 1,
  updatedAt: '',
});

// Cố ý đảo thứ tự để kiểm tra sắp xếp theo thời gian
const segments = [
  seg('2', 15, 'sb', 'I will review the electrical drawings tomorrow.', 'Tôi sẽ kiểm tra bản vẽ điện vào ngày mai.'),
  seg('1', 5, 'sa', 'We need to complete the control panel design.', 'Chúng ta cần hoàn thành thiết kế tủ điều khiển.'),
  seg('3', 20, null, 'Okay.', 'Được.'),
];

const tz = 'Asia/Ho_Chi_Minh';

describe('TXT export', () => {
  it('matches the required layout with Vietnamese diacritics, sorted by time', () => {
    const txt = exportTxt({ meeting, speakers, segments, summary: null, mode: 'both', timeZone: tz });
    const lines = txt.split('\r\n');
    expect(lines.slice(0, 4)).toEqual(['AI MEETING TRANSLATOR', 'Tên cuộc họp: Họp dự án tủ điện', 'Ngày: 09/10/2026', 'Thời gian: 10:00 - 11:00']);
    const body = txt.slice(txt.indexOf('[10:00:05]'));
    expect(body).toBe(
      [
        '[10:00:05] Speaker A',
        '',
        'Original: We need to complete the control panel design.',
        '',
        'Vietnamese: Chúng ta cần hoàn thành thiết kế tủ điều khiển.',
        '',
        '[10:00:15] Anh Nam',
        '',
        'Original: I will review the electrical drawings tomorrow.',
        '',
        'Vietnamese: Tôi sẽ kiểm tra bản vẽ điện vào ngày mai.',
        '',
        '[10:00:20] Không xác định',
        '',
        'Original: Okay.',
        '',
        'Vietnamese: Được.',
        '',
      ].join('\r\n'),
    );
  });

  it('Vietnamese-only mode omits the original text', () => {
    const txt = exportTxt({ meeting, speakers, segments, summary: null, mode: 'vi', timeZone: tz });
    expect(txt).not.toContain('Original:');
    expect(txt).toContain('Tôi sẽ kiểm tra bản vẽ điện vào ngày mai.');
  });

  it('encodes as UTF-8 (with BOM) and round-trips diacritics', async () => {
    const f = await buildExport('txt', { meeting, speakers, segments, summary: null, mode: 'both', timeZone: tz });
    expect([...f.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(f.body.toString('utf8')).toContain('Chúng ta cần hoàn thành thiết kế tủ điều khiển.');
    expect(f.contentType).toContain('charset=utf-8');
  });

  it('default file name comes from meeting title and date', () => {
    expect(exportFileName(meeting, 'txt')).toBe('Hop_du_an_tu_dien_2026-10-09.txt');
    expect(contentDisposition('Họp.txt')).toContain("filename*=UTF-8''H%E1%BB%8Dp.txt");
  });
});

describe('Other formats', () => {
  it('SRT has timestamps and speakers', () => {
    const srt = exportSrt({ meeting, speakers, segments, summary: null, mode: 'vi' });
    expect(srt.startsWith('1\n00:00:05,000 --> 00:00:08,000\nSpeaker A: Chúng ta')).toBe(true);
  });

  it('DOCX, Markdown and JSON are produced', async () => {
    const docx = await buildExport('docx', { meeting, speakers, segments, summary: null, mode: 'both', timeZone: tz });
    expect(docx.body.subarray(0, 2).toString()).toBe('PK');
    const md = await buildExport('md', { meeting, speakers, segments, summary: null, mode: 'both', timeZone: tz });
    expect(md.body.toString()).toContain('**Anh Nam — 10:00:15**');
    const json = JSON.parse((await buildExport('json', { meeting, speakers, segments, summary: null, mode: 'both' })).body.toString());
    expect(json.segments.map((s: Segment) => s.id)).toEqual(['1', '2', '3']);
  });
});

describe('Summary parsing', () => {
  it('keeps owner/deadline null when not stated and tolerates surrounding text', () => {
    const s = parseSummaryJson(
      'Here: {"overview":"Tổng quan","topics":["A"],"discussions":[],"decisions":[],"actionItems":[{"task":"Gửi bản vẽ","owner":"null","deadline":null,"evidence":"send drawings"}],"openIssues":[]} done',
    );
    expect(s.actionItems[0]).toEqual({ task: 'Gửi bản vẽ', owner: null, deadline: null, evidence: 'send drawings' });
    const md = summaryToMarkdown(meeting, { ...s, generatedAt: '', provider: 'openai', model: 'x', editedMarkdown: null });
    expect(md).toContain('Người phụ trách: Chưa nêu rõ');
    expect(md).toContain('do AI');
  });
});
