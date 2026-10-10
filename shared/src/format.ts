import type { Speaker } from './index';

export const UNKNOWN_SPEAKER_LABEL = 'Không xác định';

export function speakerDisplayName(speaker: Speaker | null | undefined): string {
  if (!speaker) return UNKNOWN_SPEAKER_LABEL;
  return speaker.displayName?.trim() || `Speaker ${speaker.label}`;
}

/** Nhãn theo thứ tự phát hiện: A..Z, rồi AA, AB... */
export function speakerLabelForIndex(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** HH:MM:SS theo giờ địa phương (hoặc theo timeZone nếu truyền vào). */
export function formatClock(iso: string | number | Date, timeZone?: string): string {
  const d = new Date(iso);
  if (timeZone) {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateVi(iso: string | number | Date, timeZone?: string): string {
  const d = new Date(iso);
  if (timeZone) {
    return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  }
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Định dạng thời gian SRT: HH:MM:SS,mmm */
export function formatSrtTime(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(v % 1000, 3)}`;
}

/** Tạo tên file an toàn từ tiêu đề tiếng Việt (bỏ dấu, thay ký tự đặc biệt). */
export function slugifyFileName(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s.slice(0, 80) || 'cuoc_hop';
}
