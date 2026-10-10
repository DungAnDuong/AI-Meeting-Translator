/// <reference lib="webworker" />
import { Downsampler, UtteranceSegmenter } from './vad';

// Khai báo tối thiểu cho phạm vi AudioWorkletGlobalScope
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Command = { type: 'pause' } | { type: 'resume' } | { type: 'mute'; muted: boolean } | { type: 'flush' } | { type: 'reset' };

/**
 * Xử lý âm thanh ngoài luồng giao diện: hạ mẫu về 16 kHz mono, phát hiện lời nói,
 * gửi từng lượt nói (PCM Int16) về luồng chính. Không ghi âm khi đang tạm dừng hoặc tắt micro.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  private down = new Downsampler(sampleRate, 16000);
  private seg = new UtteranceSegmenter();
  private paused = false;
  private muted = false;
  private levelCounter = 0;
  private wasSpeaking = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Command>) => {
      const c = e.data;
      if (c.type === 'pause') (this.paused = true), this.flush();
      else if (c.type === 'resume') this.paused = false;
      else if (c.type === 'mute') {
        this.muted = c.muted;
        if (c.muted) this.flush();
      } else if (c.type === 'flush') this.flush();
      else if (c.type === 'reset') this.seg.reset();
    };
  }

  private flush() {
    const u = this.seg.flush();
    if (u) this.post(u);
    this.postSpeaking(false);
    this.port.postMessage({ type: 'flushed' });
  }

  private post(u: { pcm: Int16Array; startSample: number }) {
    this.port.postMessage({ type: 'utterance', pcm: u.pcm, startSample: u.startSample, nowSample: this.seg.samplesProcessed }, [u.pcm.buffer]);
  }

  private postSpeaking(v: boolean) {
    if (v !== this.wasSpeaking) {
      this.wasSpeaking = v;
      this.port.postMessage({ type: 'speaking', speaking: v });
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || !input.length || this.paused) return true;
    // Trộn các kênh về mono
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
    if (this.muted) mono.fill(0);

    const samples = this.down.process(mono);
    const utterances = this.seg.push(samples);
    for (const u of utterances) this.post(u);

    if (++this.levelCounter % 8 === 0) {
      this.port.postMessage({ type: 'level', rms: this.muted ? 0 : this.seg.lastRms, threshold: this.seg.threshold });
    }
    this.postSpeaking(this.seg.isSpeaking);
    return true;
  }
}

registerProcessor('amt-capture', CaptureProcessor);
