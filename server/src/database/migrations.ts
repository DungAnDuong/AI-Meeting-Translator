/** Migration đánh số tăng dần. Không sửa migration đã phát hành – thêm migration mới. */
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  secrets_enc TEXT,            -- JSON các API key, mã hóa AES-256-GCM
  updated_at TEXT NOT NULL
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  glossary TEXT NOT NULL DEFAULT '',
  source_language TEXT NOT NULL DEFAULT 'auto',
  target_language TEXT NOT NULL DEFAULT 'vi',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  stt_provider TEXT NOT NULL,
  translation_provider TEXT NOT NULL,
  diarization_mode TEXT NOT NULL,
  store_audio INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meetings_owner ON meetings(owner_id, started_at DESC);

CREATE TABLE speakers (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  display_name TEXT,
  color_index INTEGER NOT NULL,
  source_id TEXT,              -- chế độ per-source: nguồn âm thanh gắn với người nói
  created_at TEXT NOT NULL,
  UNIQUE (meeting_id, label)
);

CREATE TABLE audio_chunks (
  id TEXT PRIMARY KEY,         -- UUID do client tạo: chống xử lý trùng khi gửi lại
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  start_offset_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,        -- queued | processing | done | empty | error | aborted
  error TEXT,
  audio_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chunks_meeting ON audio_chunks(meeting_id);

CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES audio_chunks(id) ON DELETE SET NULL,
  sub_index INTEGER NOT NULL DEFAULT 0,
  speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
  source_id TEXT NOT NULL,
  start_offset_ms INTEGER NOT NULL,
  end_offset_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  language TEXT,
  original_text TEXT NOT NULL DEFAULT '',
  translated_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('transcribing','translating','final','error')),
  error TEXT,
  original_edited INTEGER NOT NULL DEFAULT 0,
  translation_edited INTEGER NOT NULL DEFAULT 0,
  overlap INTEGER NOT NULL DEFAULT 0,
  stt_latency_ms INTEGER,
  translation_latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_segments_meeting_time ON transcript_segments(meeting_id, start_offset_ms, sub_index);
`,
  },
];
