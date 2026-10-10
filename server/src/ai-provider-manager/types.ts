/**
 * Giao diện thống nhất cho các nhà cung cấp AI. Mỗi provider tự triển khai,
 * phần còn lại của ứng dụng chỉ làm việc với các interface này.
 */

export interface TranscriptionCapabilities {
  /** Trả về văn bản tạm thời (delta) trong khi đang nhận dạng. */
  streaming: boolean;
  /** Trả về nhãn người nói theo từng đoạn. */
  diarization: boolean;
  /** Trả về ngôn ngữ đã phát hiện. */
  languageDetection: boolean;
}

export interface KnownSpeakerReference {
  name: string;
  /** data URL audio/wav dài 2–10 giây. */
  dataUrl: string;
}

export interface TranscriptionRequest {
  wav: Buffer;
  durationMs: number;
  /** 'auto' hoặc mã ISO-639-1 */
  language: string;
  /** Văn bản ngay trước đó – giúp model nối câu/thuật ngữ (chỉ model hỗ trợ prompt). */
  prompt?: string;
  knownSpeakers?: KnownSpeakerReference[];
  signal: AbortSignal;
  onPartial?: (text: string) => void;
}

export interface DiarizedPiece {
  speakerTag: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  pieces?: DiarizedPiece[];
}

export interface ITranscriptionProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: TranscriptionCapabilities;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface TranslationContextItem {
  speaker: string;
  original: string;
  translated: string;
}

export interface TranslationRequest {
  text: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  speaker: string;
  context: TranslationContextItem[];
  meetingContext: string;
  glossary: string;
  signal: AbortSignal;
  onPartial?: (text: string) => void;
}

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ITranslationProvider {
  readonly id: string;
  readonly model: string;
  translate(req: TranslationRequest): Promise<string>;
  /** Hoàn thành văn bản tổng quát (dùng cho tóm tắt cuộc họp). */
  complete(req: CompletionRequest): Promise<string>;
}

/** Phần nhận dạng thời gian thực cần cho một chunk – dùng bởi lớp diarization. */
export interface DiarizationInput {
  meetingId: string;
  chunkId: string;
  sourceId: string;
  sourceLabel: string;
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
}

export interface SpeakerAssignment {
  speakerId: string | null;
  text: string;
  startMs: number; // tương đối trong chunk
  endMs: number;
  overlap: boolean;
}

export interface ISpeakerDiarizationProvider {
  readonly mode: string;
  /** Cần STT trả về các đoạn có nhãn người nói hay không. */
  readonly requiresDiarizedTranscription: boolean;
  /** Chuẩn bị tham số bổ sung cho STT (vd. mẫu giọng người nói đã biết). */
  prepare(input: DiarizationInput): Promise<Pick<TranscriptionRequest, 'knownSpeakers'>>;
  /** Gán người nói cho kết quả STT. Trả về speakerId = null khi không đủ cơ sở xác định. */
  assign(input: DiarizationInput, result: TranscriptionResult): Promise<SpeakerAssignment[]>;
}
