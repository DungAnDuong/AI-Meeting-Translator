import { describe, expect, it } from 'vitest';
import { Downsampler, UtteranceSegmenter } from './vad';

const SR = 16000;
const tone = (ms: number, amp = 0.2) => Float32Array.from({ length: (SR * ms) / 1000 }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / SR) * amp);
const silence = (ms: number, amp = 0.001) => Float32Array.from({ length: (SR * ms) / 1000 }, () => (Math.random() - 0.5) * amp);
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe('UtteranceSegmenter (VAD)', () => {
  it('splits speech separated by pauses into separate utterances', () => {
    const seg = new UtteranceSegmenter();
    const out = seg.push(concat(silence(1000), tone(1500), silence(1000), tone(2000), silence(1000)));
    expect(out).toHaveLength(2);
    const d1 = (out[0].pcm.length / SR) * 1000;
    const d2 = (out[1].pcm.length / SR) * 1000;
    expect(d1).toBeGreaterThan(1500);
    expect(d1).toBeLessThan(2200);
    expect(d2).toBeGreaterThan(2000);
    // vị trí bắt đầu gần 1s (có pre-roll 300ms)
    expect(out[0].startSample / SR).toBeGreaterThan(0.6);
    expect(out[0].startSample / SR).toBeLessThan(1.1);
  });

  it('ignores short clicks and keeps silence silent', () => {
    const seg = new UtteranceSegmenter();
    expect(seg.push(concat(silence(1000), tone(150), silence(1500)))).toHaveLength(0);
  });

  it('does not split a sentence on a short breath pause', () => {
    const seg = new UtteranceSegmenter();
    const out = seg.push(concat(silence(500), tone(1000), silence(300), tone(1000), silence(1000)));
    expect(out).toHaveLength(1);
  });

  it('force-cuts very long continuous speech so text keeps flowing', () => {
    const seg = new UtteranceSegmenter({ maxUtteranceMs: 5000 });
    const out = seg.push(concat(silence(500), tone(12000), silence(1000)));
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const u of out) expect((u.pcm.length / SR) * 1000).toBeLessThanOrEqual(5100);
    const total = out.reduce((n, u) => n + u.pcm.length, 0) / SR;
    expect(total).toBeGreaterThan(11.5); // không mất âm thanh khi cắt
  });

  it('flush returns the utterance in progress (pause / end meeting)', () => {
    const seg = new UtteranceSegmenter();
    expect(seg.push(concat(silence(500), tone(1500)))).toHaveLength(0);
    expect(seg.flush()).not.toBeNull();
    expect(seg.flush()).toBeNull();
  });

  it('adapts to background noise', () => {
    const seg = new UtteranceSegmenter();
    // nền ồn ổn định không bị coi là lời nói
    expect(seg.push(silence(4000, 0.02))).toHaveLength(0);
    expect(seg.push(concat(tone(1500, 0.3), silence(1000, 0.02)))).toHaveLength(1);
  });
});

describe('Downsampler', () => {
  it('converts 48 kHz to 16 kHz', () => {
    const d = new Downsampler(48000);
    expect(d.process(new Float32Array(4800)).length).toBe(1600);
  });
  it('handles non-integer ratios across calls', () => {
    const d = new Downsampler(44100);
    let n = 0;
    for (let i = 0; i < 100; i++) n += d.process(new Float32Array(441)).length;
    expect(Math.abs(n - 16000)).toBeLessThanOrEqual(1);
  });
});
