/**
 * Chia luồng âm thanh thành từng lượt nói (utterance) dựa trên năng lượng (VAD thích nghi).
 * Chạy bên trong AudioWorklet nên không phụ thuộc DOM; tách riêng để kiểm thử được.
 *
 * - Ngưỡng nói = max(minThreshold, nền nhiễu × thresholdRatio); nền nhiễu cập nhật khi im lặng.
 * - Bắt đầu lượt khi đủ `startFrames` khung liên tiếp vượt ngưỡng (kèm pre-roll để không mất âm đầu).
 * - Kết thúc lượt khi im lặng ≥ `silenceMs`, hoặc cắt cưỡng bức khi dài quá `maxUtteranceMs`
 *   (tại khung yên nhất trong 1.5 giây cuối để tránh cắt giữa từ).
 */
export interface VadOptions {
  sampleRate: number;
  frameMs: number;
  thresholdRatio: number;
  minThreshold: number;
  startFrames: number;
  silenceMs: number;
  preRollMs: number;
  minUtteranceMs: number;
  /** Thời lượng có tiếng (vượt ngưỡng) tối thiểu – loại tiếng gõ, click. */
  minVoicedMs: number;
  maxUtteranceMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  sampleRate: 16000,
  frameMs: 30,
  thresholdRatio: 3,
  minThreshold: 0.008,
  startFrames: 3,
  silenceMs: 650,
  preRollMs: 300,
  minUtteranceMs: 450,
  minVoicedMs: 250,
  maxUtteranceMs: 14000,
};

export interface Utterance {
  pcm: Int16Array;
  /** Vị trí mẫu bắt đầu (tính từ lúc bắt đầu thu) – để suy ra thời điểm phát biểu. */
  startSample: number;
}

export class UtteranceSegmenter {
  private readonly o: VadOptions;
  private readonly frameSize: number;
  private frame: number[] = [];
  private totalSamples = 0;
  private noiseFloor = 0.003;
  private speaking = false;
  private aboveCount = 0;
  private silenceMsAcc = 0;
  private preRoll: Float32Array[] = [];
  private current: Float32Array[] = [];
  private currentRms: number[] = [];
  private currentStart = 0;
  private voicedFrames = 0;
  lastRms = 0;

  constructor(opts: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD, ...opts };
    this.frameSize = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
  }

  /** Tổng số mẫu đã xử lý – để suy ra thời điểm thực của lượt nói (now - (processed - startSample)). */
  get samplesProcessed() {
    return this.totalSamples + this.frame.length;
  }

  get isSpeaking() {
    return this.speaking;
  }

  get threshold() {
    return Math.max(this.o.minThreshold, this.noiseFloor * this.o.thresholdRatio);
  }

  reset() {
    this.frame = [];
    this.totalSamples = 0;
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMsAcc = 0;
    this.preRoll = [];
    this.current = [];
    this.currentRms = [];
  }

  /** Đưa mẫu 16 kHz (float -1..1) vào; trả về các lượt nói đã hoàn tất. */
  push(samples: Float32Array): Utterance[] {
    const out: Utterance[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.frame.push(samples[i]);
      if (this.frame.length === this.frameSize) {
        const f = Float32Array.from(this.frame);
        this.frame = [];
        const u = this.processFrame(f);
        if (u) out.push(u);
        this.totalSamples += this.frameSize;
      }
    }
    return out;
  }

  /** Kết thúc lượt đang nói dở (khi tạm dừng/kết thúc). */
  flush(): Utterance | null {
    if (!this.speaking) return null;
    return this.finish(this.current.length);
  }

  private processFrame(f: Float32Array): Utterance | null {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.lastRms = rms;
    const above = rms > this.threshold;

    if (!this.speaking) {
      // Cập nhật nền nhiễu khi im lặng (thích nghi chậm, tăng chậm hơn giảm)
      if (!above) this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.9 + rms * 0.1 : this.noiseFloor * 0.995 + rms * 0.005;
      this.preRoll.push(f);
      const maxPre = Math.ceil(this.o.preRollMs / this.o.frameMs);
      if (this.preRoll.length > maxPre) this.preRoll.shift();
      this.aboveCount = above ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= this.o.startFrames) {
        this.speaking = true;
        this.silenceMsAcc = 0;
        this.current = [...this.preRoll];
        this.currentRms = this.preRoll.map(() => 0);
        this.currentStart = Math.max(0, this.totalSamples + this.frameSize - this.preRoll.length * this.frameSize);
        this.voicedFrames = this.aboveCount;
        this.preRoll = [];
      }
      return null;
    }

    if (above) this.voicedFrames++;
    this.current.push(f);
    this.currentRms.push(rms);
    this.silenceMsAcc = above ? 0 : this.silenceMsAcc + this.o.frameMs;
    const durationMs = this.current.length * this.o.frameMs;

    if (this.silenceMsAcc >= this.o.silenceMs) {
      // Bỏ phần im lặng ở cuối, giữ lại ~150ms
      const keep = this.current.length - Math.floor((this.silenceMsAcc - 150) / this.o.frameMs);
      return this.finish(keep);
    }
    if (durationMs >= this.o.maxUtteranceMs) {
      const lookback = Math.min(this.current.length - 1, Math.round(1500 / this.o.frameMs));
      let cut = this.current.length;
      let minRms = Infinity;
      for (let i = this.current.length - lookback; i < this.current.length; i++) {
        if (this.currentRms[i] < minRms) (minRms = this.currentRms[i]), (cut = i + 1);
      }
      const rest = this.current.slice(cut);
      const restRms = this.currentRms.slice(cut);
      const u = this.finish(cut);
      // Phần còn lại tiếp tục là một lượt mới của cùng dòng nói
      if (rest.length) {
        this.speaking = true;
        this.current = rest;
        this.currentRms = restRms;
        this.currentStart = this.totalSamples + this.frameSize - rest.length * this.frameSize;
        this.voicedFrames = restRms.filter((r) => r > this.threshold).length;
      }
      return u;
    }
    return null;
  }

  private finish(frames: number): Utterance | null {
    const used = this.current.slice(0, Math.max(0, frames));
    const start = this.currentStart;
    const voicedMs = this.voicedFrames * this.o.frameMs;
    this.voicedFrames = 0;
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMsAcc = 0;
    this.current = [];
    this.currentRms = [];
    this.preRoll = [];
    // Tiếng động ngắn (click, gõ bàn) → bỏ qua, không gửi đi nhận dạng
    if (used.length * this.o.frameMs < this.o.minUtteranceMs || voicedMs < this.o.minVoicedMs) return null;
    const pcm = new Int16Array(used.length * this.frameSize);
    let k = 0;
    for (const fr of used) for (let i = 0; i < fr.length; i++) pcm[k++] = Math.max(-32768, Math.min(32767, Math.round(fr[i] * 32767)));
    return { pcm, startSample: start };
  }
}

/**
 * Hạ tần số lấy mẫu (vd. 48 kHz → 16 kHz) bằng trung bình theo cửa sổ (lọc thông thấp đơn giản),
 * giữ trạng thái giữa các lần gọi để không bị gián đoạn.
 */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0;
  private acc = 0;
  private accCount = 0;

  constructor(inputRate: number, outputRate = 16000) {
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        out.push(this.acc / this.accCount);
        this.pos -= this.ratio;
        this.acc = 0;
        this.accCount = 0;
      }
    }
    return Float32Array.from(out);
  }
}
