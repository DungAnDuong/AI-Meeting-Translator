/** Đóng gói PCM Int16 mono thành file WAV (RIFF) để gửi cho dịch vụ STT. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // kích thước chunk fmt
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

export function wavDataUrl(wav: Buffer): string {
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

export function slicePcm(pcm: Int16Array, sampleRate: number, startMs: number, endMs: number): Int16Array {
  const s = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const e = Math.min(pcm.length, Math.ceil((endMs / 1000) * sampleRate));
  return pcm.slice(s, Math.max(s, e));
}

export function pcmDurationMs(pcm: Int16Array, sampleRate: number): number {
  return Math.round((pcm.length / sampleRate) * 1000);
}

/** RMS chuẩn hóa 0..1 – dùng để loại các đoạn gần như im lặng. */
export function pcmRms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
  return Math.sqrt(sum / pcm.length);
}
