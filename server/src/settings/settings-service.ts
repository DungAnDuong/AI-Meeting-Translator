import { z } from 'zod';
import type { KeySource, ProviderPublicConfig } from '@amt/shared';
import type { Db } from '../database/db';
import { decryptJson, encryptJson, maskSecret } from './crypto';

export interface Secrets {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  localApiKey?: string;
}

/** Cấu hình lưu trong DB (không chứa API key). */
export type StoredSettings = {
  openai: Omit<ProviderPublicConfig['openai'], 'apiKey' | 'apiKeySource'>;
  anthropic: Omit<ProviderPublicConfig['anthropic'], 'apiKey' | 'apiKeySource'>;
  local: Omit<ProviderPublicConfig['local'], 'apiKey' | 'apiKeySource'>;
  pipeline: ProviderPublicConfig['pipeline'];
};

/** Cấu hình đầy đủ dùng ở backend – chứa API key thật, KHÔNG bao giờ gửi ra ngoài. */
export type ResolvedSettings = StoredSettings & {
  secrets: { openaiApiKey: string | null; anthropicApiKey: string | null; localApiKey: string | null };
};

export const DEFAULT_GLOSSARY = `PLC = PLC (giữ nguyên)
HMI = HMI (giữ nguyên)
SCADA = SCADA (giữ nguyên)
BOM = BOM / danh mục vật tư
CAD = CAD (giữ nguyên)
cable tray = máng cáp
control panel = tủ điều khiển
electrical panel = tủ điện
switchgear = tủ đóng cắt
single-line diagram = sơ đồ một sợi
VFD = biến tần (VFD)
MCC = tủ MCC
I/O list = danh sách I/O
commissioning = chạy thử nghiệm thu
FAT = FAT (nghiệm thu tại xưởng)
SAT = SAT (nghiệm thu tại công trường)`;

export const DEFAULT_SETTINGS: StoredSettings = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    sttModel: 'gpt-4o-transcribe',
    translationModel: 'gpt-4.1-mini',
    temperature: null,
  },
  anthropic: { model: 'claude-opus-5-5', effort: 'low', useFallbacks: true },
  local: {
    // Whisper cài sẵn bằng tools/install-whisper.ps1, được Start.bat khởi động ở cổng 8178
    sttBaseUrl: 'http://127.0.0.1:8178',
    sttApiStyle: 'whisper.cpp',
    sttModel: 'ggml-small',
    llmBaseUrl: 'http://localhost:11434/v1',
    llmModel: 'qwen2.5:7b-instruct',
  },
  pipeline: {
    sttProvider: 'openai',
    translationProvider: 'openai',
    diarizationMode: 'openai',
    contextSegments: 4,
    sttConcurrency: 2,
    translationConcurrency: 3,
    requestTimeoutMs: 30_000,
    maxRetries: 2,
    glossary: DEFAULT_GLOSSARY,
  },
};

const url = z.string().trim().url().max(500);
const model = z.string().trim().min(1).max(200);

/** Schema cập nhật một phần. API key: chuỗi mới để đặt, '' để xóa, bỏ qua để giữ nguyên. */
export const settingsPatchSchema = z
  .object({
    openai: z
      .object({
        apiKey: z.string().max(500).optional(),
        baseUrl: url.optional(),
        sttModel: model.optional(),
        translationModel: model.optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
      })
      .strict()
      .optional(),
    anthropic: z
      .object({
        apiKey: z.string().max(500).optional(),
        model: model.optional(),
        effort: z.enum(['low', 'medium', 'high']).optional(),
        useFallbacks: z.boolean().optional(),
      })
      .strict()
      .optional(),
    local: z
      .object({
        apiKey: z.string().max(500).optional(),
        sttBaseUrl: url.optional(),
        sttApiStyle: z.enum(['openai', 'whisper.cpp']).optional(),
        sttModel: z.string().trim().max(200).optional(),
        llmBaseUrl: url.optional(),
        llmModel: model.optional(),
      })
      .strict()
      .optional(),
    pipeline: z
      .object({
        sttProvider: z.enum(['openai', 'local']).optional(),
        translationProvider: z.enum(['openai', 'anthropic', 'local']).optional(),
        diarizationMode: z.enum(['openai', 'per-source', 'none']).optional(),
        contextSegments: z.number().int().min(0).max(20).optional(),
        sttConcurrency: z.number().int().min(1).max(8).optional(),
        translationConcurrency: z.number().int().min(1).max(10).optional(),
        requestTimeoutMs: z.number().int().min(5_000).max(180_000).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        glossary: z.string().max(20_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Kiểm tra tổ hợp cấu hình có khả thi không (tránh giả định model nào cũng làm được mọi việc). */
export function validateCombination(s: StoredSettings): string | null {
  if (s.pipeline.diarizationMode === 'openai' && s.pipeline.sttProvider !== 'openai') {
    return 'Phân biệt người nói bằng OpenAI (gpt-4o-transcribe-diarize) chỉ dùng được khi Speech-to-Text là OpenAI. Hãy chọn chế độ "Theo nguồn âm thanh" hoặc "Không phân biệt" khi dùng Local STT.';
  }
  return null;
}

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly env: { openaiApiKey: string | null; anthropicApiKey: string | null },
  ) {}

  private load(userId: string): { settings: StoredSettings; secrets: Secrets } {
    const row = this.db.prepare('SELECT settings_json, secrets_enc FROM user_settings WHERE user_id = ?').get(userId) as
      | { settings_json: string; secrets_enc: string | null }
      | undefined;
    if (!row) return { settings: structuredClone(DEFAULT_SETTINGS), secrets: {} };
    const stored = JSON.parse(row.settings_json) as Partial<StoredSettings>;
    const settings: StoredSettings = {
      openai: { ...DEFAULT_SETTINGS.openai, ...stored.openai },
      anthropic: { ...DEFAULT_SETTINGS.anthropic, ...stored.anthropic },
      local: { ...DEFAULT_SETTINGS.local, ...stored.local },
      pipeline: { ...DEFAULT_SETTINGS.pipeline, ...stored.pipeline },
    };
    let secrets: Secrets = {};
    if (row.secrets_enc) {
      try {
        secrets = decryptJson<Secrets>(this.key, row.secrets_enc);
      } catch {
        // Khóa APP_SECRET đã thay đổi → không giải mã được; người dùng cần nhập lại key.
        secrets = {};
      }
    }
    return { settings, secrets };
  }

  resolve(userId: string): ResolvedSettings {
    const { settings, secrets } = this.load(userId);
    return {
      ...settings,
      secrets: {
        openaiApiKey: secrets.openaiApiKey || this.env.openaiApiKey,
        anthropicApiKey: secrets.anthropicApiKey || this.env.anthropicApiKey,
        localApiKey: secrets.localApiKey || null,
      },
    };
  }

  getPublic(userId: string): ProviderPublicConfig {
    const { settings, secrets } = this.load(userId);
    const src = (user?: string, env?: string | null): KeySource => (user ? 'user' : env ? 'env' : null);
    return {
      openai: {
        ...settings.openai,
        apiKey: maskSecret(secrets.openaiApiKey ?? null) ?? (this.env.openaiApiKey ? '(biến môi trường)' : null),
        apiKeySource: src(secrets.openaiApiKey, this.env.openaiApiKey),
      },
      anthropic: {
        ...settings.anthropic,
        apiKey: maskSecret(secrets.anthropicApiKey ?? null) ?? (this.env.anthropicApiKey ? '(biến môi trường)' : null),
        apiKeySource: src(secrets.anthropicApiKey, this.env.anthropicApiKey),
      },
      local: { ...settings.local, apiKey: maskSecret(secrets.localApiKey ?? null), apiKeySource: src(secrets.localApiKey, null) },
      pipeline: settings.pipeline,
    };
  }

  update(userId: string, patch: SettingsPatch): ProviderPublicConfig {
    const { settings, secrets } = this.load(userId);
    const next: StoredSettings = structuredClone(settings);
    const nextSecrets: Secrets = { ...secrets };

    const applyKey = (field: keyof Secrets, value: string | undefined) => {
      if (value === undefined) return;
      const v = value.trim();
      if (v) nextSecrets[field] = v;
      else delete nextSecrets[field];
    };

    if (patch.openai) {
      const { apiKey, ...rest } = patch.openai;
      applyKey('openaiApiKey', apiKey);
      Object.assign(next.openai, stripUndefined(rest));
    }
    if (patch.anthropic) {
      const { apiKey, ...rest } = patch.anthropic;
      applyKey('anthropicApiKey', apiKey);
      Object.assign(next.anthropic, stripUndefined(rest));
    }
    if (patch.local) {
      const { apiKey, ...rest } = patch.local;
      applyKey('localApiKey', apiKey);
      Object.assign(next.local, stripUndefined(rest));
    }
    if (patch.pipeline) Object.assign(next.pipeline, stripUndefined(patch.pipeline));

    const problem = validateCombination(next);
    if (problem) throw new SettingsValidationError(problem);

    const enc = Object.keys(nextSecrets).length ? encryptJson(this.key, nextSecrets) : null;
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, settings_json, secrets_enc, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, secrets_enc = excluded.secrets_enc, updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(next), enc, new Date().toISOString());
    return this.getPublic(userId);
  }
}

export class SettingsValidationError extends Error {}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
