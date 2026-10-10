// Kiểu dữ liệu và giao thức dùng chung giữa server và web.

export * from './protocol';
export * from './languages';
export * from './format';

export type ProviderId = 'openai' | 'anthropic' | 'local';
export type SttProviderId = 'openai' | 'local';
export type TranslationProviderId = ProviderId;
/**
 * - `openai`: dùng gpt-4o-transcribe-diarize (STT + phân biệt người nói trong cùng một lệnh gọi).
 * - `per-source`: mỗi nguồn âm thanh (mỗi micro/thiết bị/tab) là một người nói.
 * - `none`: không phân biệt người nói, mọi lượt gán "Không xác định".
 */
export type DiarizationMode = 'openai' | 'per-source' | 'none';

export type MeetingStatus = 'active' | 'paused' | 'ended';
export type SegmentStatus = 'transcribing' | 'translating' | 'final' | 'error';

export interface Meeting {
  id: string;
  title: string;
  context: string;
  glossary: string;
  sourceLanguage: string; // 'auto' hoặc mã ISO-639-1
  targetLanguage: string; // mặc định 'vi'
  status: MeetingStatus;
  sttProvider: string;
  translationProvider: string;
  diarizationMode: DiarizationMode;
  storeAudio: boolean;
  isDemo: boolean;
  startedAt: string; // ISO
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  segmentCount?: number;
}

export interface Speaker {
  id: string;
  meetingId: string;
  label: string; // A, B, C...
  displayName: string | null;
  colorIndex: number;
}

export interface Segment {
  id: string;
  meetingId: string;
  chunkId: string | null;
  subIndex: number;
  speakerId: string | null; // null = Không xác định
  sourceId: string;
  startOffsetMs: number; // tính từ lúc bắt đầu cuộc họp
  endOffsetMs: number;
  startedAt: string; // ISO, thời điểm bắt đầu phát biểu
  language: string | null;
  originalText: string;
  translatedText: string;
  status: SegmentStatus;
  error: string | null;
  originalEdited: boolean;
  translationEdited: boolean;
  overlap: boolean;
  sttLatencyMs: number | null;
  translationLatencyMs: number | null;
  updatedAt: string;
  /** Chỉ có ở client: bản cập nhật tạm thời chưa lưu DB (văn bản streaming). */
  interim?: boolean;
}

export interface MeetingSummary {
  overview: string;
  topics: string[];
  discussions: string[];
  decisions: Array<{ text: string; evidence: string }>;
  actionItems: Array<{ task: string; owner: string | null; deadline: string | null; evidence: string }>;
  openIssues: string[];
  generatedAt: string;
  provider: string;
  model: string;
  /** Markdown do người dùng chỉnh sửa (nếu có) – ưu tiên khi xuất. */
  editedMarkdown: string | null;
}

/** Nguồn API key: người dùng nhập (mã hóa trong DB), biến môi trường server, hoặc chưa có. */
export type KeySource = 'user' | 'env' | null;

/** Cấu hình gửi về trình duyệt: API key luôn bị che. */
export interface ProviderPublicConfig {
  openai: { apiKey: string | null; apiKeySource: KeySource; baseUrl: string; sttModel: string; translationModel: string; temperature: number | null };
  anthropic: { apiKey: string | null; apiKeySource: KeySource; model: string; effort: 'low' | 'medium' | 'high'; useFallbacks: boolean };
  local: {
    sttBaseUrl: string;
    sttApiStyle: 'openai' | 'whisper.cpp';
    sttModel: string;
    llmBaseUrl: string;
    llmModel: string;
    apiKey: string | null;
    apiKeySource: KeySource;
  };
  pipeline: {
    sttProvider: SttProviderId;
    translationProvider: TranslationProviderId;
    diarizationMode: DiarizationMode;
    contextSegments: number;
    sttConcurrency: number;
    translationConcurrency: number;
    requestTimeoutMs: number;
    maxRetries: number;
    glossary: string;
  };
}

export interface ConnectionTestResult {
  ok: boolean;
  target: string;
  message: string;
  hint?: string;
  latencyMs?: number;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
}
