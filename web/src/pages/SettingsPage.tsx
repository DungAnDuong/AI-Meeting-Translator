import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, KeyRound, Loader2, PlugZap, Save, XCircle } from 'lucide-react';
import type { ConnectionTestResult, ProviderPublicConfig } from '@amt/shared';
import { AppShell } from '../components/AppShell';
import { Field, Notice } from '../components/ui';
import { api, errorText } from '../lib/api';
import { DIARIZATION_LABELS } from '../lib/providers';
import { useMeetingStore } from '../store/meeting-store';

type Target = 'openai' | 'anthropic' | 'local-stt' | 'local-llm' | 'pipeline';
type Caps = Record<string, { streaming: boolean; diarization: boolean; languageDetection: boolean }>;

const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const OPENAI_CHAT_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'];

export function SettingsPage() {
  const [s, setS] = useState<ProviderPublicConfig | null>(null);
  const [caps, setCaps] = useState<Caps>({});
  const [keys, setKeys] = useState({ openai: '', anthropic: '', local: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState<Partial<Record<Target, ConnectionTestResult[] | 'running'>>>({});
  const toast = useMeetingStore((st) => st.toast);

  useEffect(() => {
    api<{ settings: ProviderPublicConfig; capabilities: { openaiSttModels: Caps } }>('GET', '/api/settings').then(
      (r) => (setS(r.settings), setCaps(r.capabilities.openaiSttModels)),
      (e) => setError(errorText(e)),
    );
  }, []);

  if (!s) {
    return (
      <AppShell title="Cài đặt AI">
        {error ? <Notice kind="error">{error}</Notice> : <Loader2 className="size-5 animate-spin text-muted" aria-label="Đang tải" />}
      </AppShell>
    );
  }

  const up = <K extends keyof ProviderPublicConfig>(section: K, patch: Partial<ProviderPublicConfig[K]>) => {
    setS({ ...s, [section]: { ...s[section], ...patch } });
    setDirty(true);
  };

  const save = async (extra?: { clear?: 'openai' | 'anthropic' | 'local' }): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const strip = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'apiKey' && k !== 'apiKeySource'));
      const keyFor = (k: 'openai' | 'anthropic' | 'local') => (extra?.clear === k ? { apiKey: '' } : keys[k] ? { apiKey: keys[k] } : {});
      const r = await api<{ settings: ProviderPublicConfig }>('PUT', '/api/settings', {
        openai: { ...strip(s.openai), ...keyFor('openai') },
        anthropic: { ...strip(s.anthropic), ...keyFor('anthropic') },
        local: { ...strip(s.local), ...keyFor('local') },
        pipeline: s.pipeline,
      });
      setS(r.settings);
      setKeys({ openai: '', anthropic: '', local: '' });
      setDirty(false);
      toast({ kind: 'success', message: extra?.clear ? 'Đã xóa API Key' : 'Đã lưu cấu hình' });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async (target: Target) => {
    if ((dirty || keys.openai || keys.anthropic || keys.local) && !(await save())) return;
    setTests((t) => ({ ...t, [target]: 'running' }));
    try {
      const r = await api<{ results: ConnectionTestResult[] }>('POST', '/api/settings/test', { target });
      setTests((t) => ({ ...t, [target]: r.results }));
    } catch (e) {
      setTests((t) => ({ ...t, [target]: [{ ok: false, target, message: errorText(e) }] }));
    }
  };

  const p = s.pipeline;
  const diarizeOptions = p.sttProvider === 'openai' ? (['openai', 'per-source', 'none'] as const) : (['per-source', 'none'] as const);

  return (
    <AppShell title="Cài đặt AI">
      <div className="space-y-5 pb-24">
        <Section title="Chức năng & nhà cung cấp" description="Mỗi chức năng có thể dùng một nhà cung cấp khác nhau. Có thể đổi bất cứ lúc nào – áp dụng ngay cho cuộc họp đang chạy.">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Speech-to-Text (nhận dạng giọng nói)" hint="Claude không cung cấp nhận dạng giọng nói.">
              <select
                className="input"
                value={p.sttProvider}
                onChange={(e) => {
                  const v = e.target.value as 'openai' | 'local';
                  up('pipeline', { sttProvider: v, diarizationMode: v === 'local' && p.diarizationMode === 'openai' ? 'per-source' : p.diarizationMode });
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="local">Local AI (máy chủ riêng)</option>
              </select>
            </Field>
            <Field label="Phân biệt người nói" hint={<DiarizationHint mode={p.diarizationMode} />}>
              <select className="input" value={p.diarizationMode} onChange={(e) => up('pipeline', { diarizationMode: e.target.value as any })}>
                {diarizeOptions.map((m) => (
                  <option key={m} value={m}>
                    {DIARIZATION_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dịch thuật" hint="Có thể dùng OpenAI, Anthropic Claude hoặc LLM chạy local.">
              <select className="input" value={p.translationProvider} onChange={(e) => up('pipeline', { translationProvider: e.target.value as any })}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="local">Local AI (máy chủ riêng)</option>
              </select>
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn" onClick={() => void test('pipeline')} disabled={tests.pipeline === 'running'}>
              {tests.pipeline === 'running' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlugZap className="size-4" aria-hidden />}
              Kiểm tra toàn bộ cấu hình
            </button>
            <span className="text-xs text-muted">Gửi 1 giây âm thanh mẫu và dịch thử 1 câu – có thể phát sinh chi phí rất nhỏ.</span>
          </div>
          <TestResults r={tests.pipeline} />
        </Section>

        <Section title="OpenAI" description="Dùng cho Speech-to-Text (gpt-4o-transcribe, gpt-transcribe, whisper-1, gpt-4o-transcribe-diarize) và/hoặc dịch thuật (model chat).">
          <div className="grid gap-4 md:grid-cols-2">
            <KeyField
              label="API Key"
              masked={s.openai.apiKey}
              source={s.openai.apiKeySource}
              value={keys.openai}
              onChange={(v) => setKeys({ ...keys, openai: v })}
              onClear={() => void save({ clear: 'openai' })}
              placeholder="sk-..."
            />
            <Field label="Endpoint (Base URL)" hint="Đổi khi dùng proxy/Azure-compatible gateway hỗ trợ cùng API.">
              <input className="input" value={s.openai.baseUrl} onChange={(e) => up('openai', { baseUrl: e.target.value })} />
            </Field>
            <Field
              label="Model Speech-to-Text"
              hint={
                p.diarizationMode === 'openai'
                  ? 'Đang bật phân biệt người nói OpenAI → hệ thống dùng gpt-4o-transcribe-diarize (không streaming văn bản tạm thời).'
                  : sttCapsText(caps[s.openai.sttModel])
              }
            >
              <input className="input" list="stt-models" value={s.openai.sttModel} onChange={(e) => up('openai', { sttModel: e.target.value })} />
              <datalist id="stt-models">
                {Object.keys(caps)
                  .filter((m) => !caps[m].diarization)
                  .map((m) => (
                    <option key={m} value={m} />
                  ))}
              </datalist>
            </Field>
            <Field label="Model dịch thuật" hint="Model chat. Ưu tiên model nhanh, không suy luận dài để giảm độ trễ.">
              <input className="input" list="oa-chat" value={s.openai.translationModel} onChange={(e) => up('openai', { translationModel: e.target.value })} />
              <datalist id="oa-chat">
                {OPENAI_CHAT_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Temperature (để trống = mặc định của model)" hint="Một số model (dòng suy luận) không chấp nhận tham số này.">
              <input
                className="input"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={s.openai.temperature ?? ''}
                onChange={(e) => up('openai', { temperature: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
          </div>
          <TestButton target="openai" tests={tests} onTest={test} />
        </Section>

        <Section title="Anthropic Claude" description="Claude được dùng làm bộ máy dịch và tổng hợp biên bản. Claude API không thu âm, không nhận dạng giọng nói và không phân biệt người nói.">
          <div className="grid gap-4 md:grid-cols-2">
            <KeyField
              label="API Key"
              masked={s.anthropic.apiKey}
              source={s.anthropic.apiKeySource}
              value={keys.anthropic}
              onChange={(v) => setKeys({ ...keys, anthropic: v })}
              onClear={() => void save({ clear: 'anthropic' })}
              placeholder="sk-ant-..."
            />
            <Field label="Model" hint="Opus mạnh nhất; Sonnet/Haiku nhanh và rẻ hơn cho dịch từng câu.">
              <input className="input" list="claude-models" value={s.anthropic.model} onChange={(e) => up('anthropic', { model: e.target.value })} />
              <datalist id="claude-models">
                {CLAUDE_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Mức nỗ lực (effort)" hint="Thấp = nhanh nhất, phù hợp dịch thời gian thực. Tóm tắt biên bản tự dùng tối thiểu mức Trung bình.">
              <select className="input" value={s.anthropic.effort} onChange={(e) => up('anthropic', { effort: e.target.value as any })}>
                <option value="low">Thấp (khuyến nghị cho dịch)</option>
                <option value="medium">Trung bình</option>
                <option value="high">Cao</option>
              </select>
            </Field>
            <label className="flex items-start gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="mt-1 size-4" checked={s.anthropic.useFallbacks} onChange={(e) => up('anthropic', { useFallbacks: e.target.checked })} />
              <span>
                Tự chuyển sang model dự phòng khi model từ chối xử lý
                <span className="block text-xs text-muted">Chỉ áp dụng cho các model hỗ trợ (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1).</span>
              </span>
            </label>
          </div>
          <TestButton target="anthropic" tests={tests} onTest={test} />
        </Section>

        <Section title="Local AI" description="Chạy model trên máy chủ của bạn (Ollama, LM Studio, vLLM, faster-whisper-server/Speaches, whisper.cpp…).">
          <Notice kind="info">
            Local AI là cách triển khai riêng, không phải nhà cung cấp đám mây. Máy chủ cần đủ GPU/RAM và phải <b>tải model trước</b> (vd. <code>ollama pull qwen2.5:7b-instruct</code>).
            Dữ liệu được xử lý trên máy có địa chỉ bên dưới – nếu địa chỉ đó là máy khác trong mạng, âm thanh/văn bản sẽ được gửi qua mạng tới máy đó. Ứng dụng web và máy chủ ứng dụng vẫn cần chạy; dùng Local AI không có nghĩa toàn bộ hệ thống chạy offline.
          </Notice>
          <h3 className="mt-4 mb-2 text-sm font-semibold">Local Speech-to-Text</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Kiểu API">
              <select className="input" value={s.local.sttApiStyle} onChange={(e) => up('local', { sttApiStyle: e.target.value as any })}>
                <option value="openai">Tương thích OpenAI (/v1/audio/transcriptions)</option>
                <option value="whisper.cpp">whisper.cpp server (/inference)</option>
              </select>
            </Field>
            <Field label="Địa chỉ máy chủ STT" hint={s.local.sttApiStyle === 'openai' ? 'VD: http://localhost:8000/v1' : 'VD: http://localhost:8080'}>
              <input className="input" value={s.local.sttBaseUrl} onChange={(e) => up('local', { sttBaseUrl: e.target.value })} />
            </Field>
            <Field label="Tên model STT" hint="VD: Systran/faster-whisper-small, large-v3…">
              <input className="input" value={s.local.sttModel} onChange={(e) => up('local', { sttModel: e.target.value })} />
            </Field>
          </div>
          <TestButton target="local-stt" tests={tests} onTest={test} label="Kiểm tra Local STT" />
          <h3 className="mt-5 mb-2 text-sm font-semibold">Local Translation LLM</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Endpoint API (tương thích OpenAI)" hint="Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1">
              <input className="input" value={s.local.llmBaseUrl} onChange={(e) => up('local', { llmBaseUrl: e.target.value })} />
            </Field>
            <Field label="Tên model LLM">
              <input className="input" value={s.local.llmModel} onChange={(e) => up('local', { llmModel: e.target.value })} />
            </Field>
            <KeyField
              label="Thông tin xác thực (nếu cần)"
              masked={s.local.apiKey}
              source={s.local.apiKeySource}
              value={keys.local}
              onChange={(v) => setKeys({ ...keys, local: v })}
              onClear={() => void save({ clear: 'local' })}
              placeholder="Bearer token (để trống nếu không cần)"
              optional
            />
          </div>
          <TestButton target="local-llm" tests={tests} onTest={test} label="Kiểm tra Local LLM" />
        </Section>

        <Section title="Thuật ngữ chuyên ngành" description='Mỗi dòng: "thuật ngữ gốc = cách dịch mong muốn". Áp dụng cho mọi cuộc họp; mỗi cuộc họp có thể bổ sung thêm.'>
          <textarea
            className="input font-mono text-sm"
            rows={10}
            value={p.glossary}
            onChange={(e) => up('pipeline', { glossary: e.target.value })}
            spellCheck={false}
            aria-label="Danh sách thuật ngữ"
          />
        </Section>

        <Section title="Nâng cao" description="Điều chỉnh theo giới hạn của nhà cung cấp và mạng.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <NumberField label="Số câu ngữ cảnh khi dịch" value={p.contextSegments} min={0} max={20} onChange={(v) => up('pipeline', { contextSegments: v })} />
            <NumberField label="STT đồng thời" value={p.sttConcurrency} min={1} max={8} onChange={(v) => up('pipeline', { sttConcurrency: v })} />
            <NumberField label="Dịch đồng thời" value={p.translationConcurrency} min={1} max={10} onChange={(v) => up('pipeline', { translationConcurrency: v })} />
            <NumberField label="Thời gian chờ (giây)" value={Math.round(p.requestTimeoutMs / 1000)} min={5} max={180} onChange={(v) => up('pipeline', { requestTimeoutMs: v * 1000 })} />
            <NumberField label="Số lần thử lại" value={p.maxRetries} min={0} max={5} onChange={(v) => up('pipeline', { maxRetries: v })} />
          </div>
        </Section>

        {error && <Notice kind="error">{error}</Notice>}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-end gap-3">
          <span className="text-sm text-muted">{dirty || keys.openai || keys.anthropic || keys.local ? 'Có thay đổi chưa lưu' : 'Đã lưu'}</span>
          <button className="btn btn-primary btn-lg" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
            Lưu cấu hình
          </button>
        </div>
      </div>
    </AppShell>
  );
}

function sttCapsText(c?: { streaming: boolean; languageDetection: boolean }) {
  if (!c) return 'Model không có trong danh sách đã biết – sẽ dùng chế độ an toàn (không streaming).';
  return `${c.streaming ? 'Có hiển thị văn bản tạm thời (streaming)' : 'Không streaming'} · ${c.languageDetection ? 'trả về ngôn ngữ phát hiện được' : 'không trả về ngôn ngữ'}`;
}

function DiarizationHint({ mode }: { mode: string }) {
  if (mode === 'openai')
    return <>Phân biệt theo giọng nói bằng gpt-4o-transcribe-diarize, giữ nhãn nhất quán bằng mẫu giọng tham chiếu (tối đa 4 người gần nhất). Một micro chung cho cả phòng có thể nhầm lẫn.</>;
  if (mode === 'per-source') return <>Mỗi micro/thiết bị/tab là một người nói. Chính xác nhất khi mỗi người có micro riêng hoặc tham gia bằng thiết bị riêng.</>;
  return <>Mọi lượt phát biểu được gán "Không xác định".</>;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-0.5 mb-4 text-sm text-muted">{description}</p>}
      {children}
    </section>
  );
}

function KeyField(props: {
  label: string;
  masked: string | null;
  source: 'user' | 'env' | null;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  optional?: boolean;
}) {
  const status =
    props.source === 'user'
      ? `Đã cấu hình: ${props.masked}`
      : props.source === 'env'
        ? 'Đang dùng key từ biến môi trường máy chủ'
        : props.optional
          ? 'Không dùng (không bắt buộc)'
          : 'Chưa cấu hình';
  return (
    <Field label={props.label} hint="Key được mã hóa và chỉ lưu trên máy chủ, không bao giờ gửi lại trình duyệt.">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            className="input pl-9"
            type="password"
            autoComplete="off"
            placeholder={props.source ? 'Nhập key mới để thay thế' : props.placeholder}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </div>
        {props.source === 'user' && (
          <button type="button" className="btn" onClick={props.onClear}>
            Xóa
          </button>
        )}
      </div>
      <p className={`mt-1 text-xs font-medium ${props.source ? 'text-ok' : props.optional ? 'text-muted' : 'text-warn'}`}>{status}</p>
    </Field>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input className="input" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} />
    </Field>
  );
}

function TestButton({ target, tests, onTest, label = 'Kiểm tra kết nối' }: { target: Target; tests: Partial<Record<Target, ConnectionTestResult[] | 'running'>>; onTest: (t: Target) => void; label?: string }) {
  const r = tests[target];
  return (
    <div className="mt-4">
      <button className="btn" onClick={() => onTest(target)} disabled={r === 'running'}>
        {r === 'running' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PlugZap className="size-4" aria-hidden />}
        {label}
      </button>
      <TestResults r={r} />
    </div>
  );
}

function TestResults({ r }: { r?: ConnectionTestResult[] | 'running' }) {
  if (!r || r === 'running') return null;
  return (
    <ul className="mt-3 space-y-2" aria-live="polite">
      {r.map((x, i) => (
        <li key={i} className={`flex gap-2 rounded-lg border px-3 py-2 text-sm ${x.ok ? 'border-ok/40 bg-ok-soft' : 'border-danger/40 bg-danger-soft'}`}>
          {x.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
          <div>
            <div>
              <b>{x.target}</b> – {x.ok ? 'Thành công' : 'Lỗi'}: {x.message}
              {x.latencyMs !== undefined && <span className="text-muted"> ({x.latencyMs} ms)</span>}
            </div>
            {x.hint && <div className="text-muted">{x.hint}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
