const NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  vietnamese: 'vi',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  mandarin: 'zh',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  thai: 'th',
  russian: 'ru',
  italian: 'it',
  portuguese: 'pt',
  indonesian: 'id',
  malay: 'ms',
  hindi: 'hi',
  dutch: 'nl',
};

/** Chuẩn hóa ngôn ngữ trả về từ STT ("english", "en", "en-US") thành mã ISO-639-1. */
export function normalizeLanguage(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (NAME_TO_CODE[s]) return NAME_TO_CODE[s];
  const code = s.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}
