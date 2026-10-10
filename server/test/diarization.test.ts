import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database/db';
import { TranscriptRepository } from '../src/transcript-manager/repository';
import { markOverlaps, mergeAdjacent, OpenAIReferenceDiarization, PerSourceDiarization } from '../src/speaker-diarization/diarizers';
import { makeSpeechPcm } from './helpers/mock-ai-server';

let repo: TranscriptRepository;
let meetingId: string;

beforeEach(() => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ('u1','a@b.c','A','x','now')").run();
  repo = new TranscriptRepository(db);
  meetingId = repo.createMeeting({ ownerId: 'u1', title: 'T', sttProvider: 'openai', translationProvider: 'openai', diarizationMode: 'openai' }).id;
});

const input = (chunkId: string, ms = 8000) => ({
  meetingId,
  chunkId,
  sourceId: 'c1:mic',
  sourceLabel: 'mic',
  pcm: makeSpeechPcm(ms),
  sampleRate: 16000,
  durationMs: ms,
});

describe('OpenAIReferenceDiarization', () => {
  it('labels new speakers A, B in detection order and keeps them consistent across chunks', async () => {
    const created: string[] = [];
    const d = new OpenAIReferenceDiarization(repo, (s) => created.push(s.label));

    const in1 = input('c1');
    expect(await d.prepare(in1)).toEqual({}); // chưa có người nói nào
    const r1 = await d.assign(in1, {
      text: '',
      language: null,
      pieces: [
        { speakerTag: 'A', startMs: 0, endMs: 3000, text: 'We need to finish the design.' },
        { speakerTag: 'B', startMs: 3200, endMs: 6000, text: 'I agree with that.' },
      ],
    });
    expect(created).toEqual(['A', 'B']);
    expect(r1.map((r) => r.speakerId)).toEqual(repo.listSpeakers(meetingId).map((s) => s.id));
    expect(d.referenceCount).toBe(2);

    // Chunk tiếp theo: gửi mẫu giọng tham chiếu, model trả về đúng tên tham chiếu
    const in2 = input('c2');
    const prep = await d.prepare(in2);
    expect(prep.knownSpeakers?.map((k) => k.name).sort()).toEqual(['spk_A', 'spk_B']);
    expect(prep.knownSpeakers?.[0].dataUrl.startsWith('data:audio/wav;base64,')).toBe(true);
    const r2 = await d.assign(in2, { text: '', language: null, pieces: [{ speakerTag: 'spk_B', startMs: 0, endMs: 2000, text: 'Yes.' }] });
    expect(r2[0].speakerId).toBe(repo.listSpeakers(meetingId).find((s) => s.label === 'B')!.id);
    expect(created).toEqual(['A', 'B']); // không tạo người nói mới
  });

  it('does not invent a new speaker for a short unknown voice → Không xác định (null)', async () => {
    const d = new OpenAIReferenceDiarization(repo, () => {});
    const out = await d.assign(input('c1'), {
      text: '',
      language: null,
      pieces: [{ speakerTag: 'A', startMs: 0, endMs: 900, text: 'Okay.' }],
    });
    expect(out[0].speakerId).toBeNull();
    expect(repo.listSpeakers(meetingId)).toHaveLength(0);
  });

  it('falls back to a single unknown-speaker segment when the model returns no segments', async () => {
    const d = new OpenAIReferenceDiarization(repo, () => {});
    const out = await d.assign(input('c1'), { text: 'Hello there', language: null, pieces: [] });
    expect(out).toHaveLength(1);
    expect(out[0].speakerId).toBeNull();
  });

  it('flags overlapping speech between different speakers and never merges two speakers', async () => {
    const d = new OpenAIReferenceDiarization(repo, () => {});
    const out = await d.assign(input('c1'), {
      text: '',
      language: null,
      pieces: [
        { speakerTag: 'A', startMs: 0, endMs: 4000, text: 'I think we should' },
        { speakerTag: 'B', startMs: 3000, endMs: 6000, text: 'No wait, listen' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].speakerId).not.toBe(out[1].speakerId);
    expect(out.every((o) => o.overlap)).toBe(true);
  });
});

describe('merge helpers', () => {
  it('merges a short pause from the same speaker', () => {
    const r = mergeAdjacent(
      [
        { speakerId: 's1', text: 'First part,', startMs: 0, endMs: 1000, overlap: false },
        { speakerId: 's1', text: 'second part.', startMs: 1500, endMs: 2500, overlap: false },
        { speakerId: 's2', text: 'Other.', startMs: 2600, endMs: 3000, overlap: false },
      ],
      1200,
    );
    expect(r.map((x) => x.text)).toEqual(['First part, second part.', 'Other.']);
  });

  it('never merges unknown speakers together', () => {
    const r = mergeAdjacent(
      [
        { speakerId: null, text: 'a', startMs: 0, endMs: 1000, overlap: false },
        { speakerId: null, text: 'b', startMs: 1100, endMs: 2000, overlap: false },
      ],
      1200,
    );
    expect(r).toHaveLength(2);
  });

  it('marks overlaps only above threshold', () => {
    const r = markOverlaps(
      [
        { speakerId: 'a', text: 'x', startMs: 0, endMs: 1000, overlap: false },
        { speakerId: 'b', text: 'y', startMs: 950, endMs: 2000, overlap: false },
      ],
      150,
    );
    expect(r.some((x) => x.overlap)).toBe(false);
  });
});

describe('PerSourceDiarization', () => {
  it('maps each audio source to one stable speaker', async () => {
    const d = new PerSourceDiarization(repo, () => {});
    const a1 = await d.assign({ ...input('x1'), sourceId: 'dev1:mic' }, { text: 'hi', language: null });
    const b1 = await d.assign({ ...input('x2'), sourceId: 'dev2:mic' }, { text: 'hello', language: null });
    const a2 = await d.assign({ ...input('x3'), sourceId: 'dev1:mic' }, { text: 'again', language: null });
    expect(a1[0].speakerId).toBe(a2[0].speakerId);
    expect(a1[0].speakerId).not.toBe(b1[0].speakerId);
    expect(repo.listSpeakers(meetingId).map((s) => s.label)).toEqual(['A', 'B']);
  });
});
