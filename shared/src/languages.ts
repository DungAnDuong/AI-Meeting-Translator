export interface LanguageOption {
  code: string;
  name: string; // tên hiển thị tiếng Việt
  english: string;
}

/** Ngôn ngữ đầu vào. Thêm ngôn ngữ mới chỉ cần bổ sung vào danh sách này. */
export const INPUT_LANGUAGES: LanguageOption[] = [
  { code: 'auto', name: 'Tự động nhận dạng', english: 'Auto Detect' },
  { code: 'en', name: 'Tiếng Anh', english: 'English' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'ja', name: 'Tiếng Nhật', english: 'Japanese' },
  { code: 'ko', name: 'Tiếng Hàn', english: 'Korean' },
  { code: 'zh', name: 'Tiếng Trung', english: 'Chinese' },
  { code: 'fr', name: 'Tiếng Pháp', english: 'French' },
  { code: 'de', name: 'Tiếng Đức', english: 'German' },
  { code: 'es', name: 'Tiếng Tây Ban Nha', english: 'Spanish' },
  { code: 'th', name: 'Tiếng Thái', english: 'Thai' },
];

export const OUTPUT_LANGUAGES: LanguageOption[] = [{ code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese' }];

export function languageName(code: string | null | undefined): string {
  if (!code) return 'Không rõ';
  return INPUT_LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();
}

export function languageEnglishName(code: string | null | undefined): string {
  if (!code || code === 'auto') return 'the source language';
  return INPUT_LANGUAGES.find((l) => l.code === code)?.english ?? code;
}

const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

/**
 * Nhận dạng ngôn ngữ theo chữ viết – chỉ dùng khi nhà cung cấp STT không trả về ngôn ngữ.
 * Trả về null khi không đủ cơ sở (không đoán bừa giữa các ngôn ngữ dùng chữ Latinh).
 */
export function detectLanguageByScript(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (!letters) return null;
  const viHits = (t.match(new RegExp(VI_CHARS.source, 'gi')) ?? []).length;
  if (viHits >= 2 || viHits / letters.length > 0.05) return 'vi';
  return null;
}
