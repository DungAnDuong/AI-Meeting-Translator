import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useMeetingStore } from '../store/meeting-store';

/** Hộp thoại modal: trên điện thoại hiển thị dạng tấm trượt từ dưới lên. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`card flex max-h-[92dvh] w-full flex-col rounded-b-none shadow-2xl sm:rounded-b-[0.9rem] ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

/** Ngăn kéo bên phải (desktop) / từ dưới lên (điện thoại) cho cài đặt nâng cao. */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        role="dialog"
        aria-label={title}
        className="mt-auto flex h-[85dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-2xl sm:mt-0 sm:h-full sm:max-w-md sm:rounded-none"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Đóng">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </aside>
    </div>
  );
}

export function Toasts() {
  const toasts = useMeetingStore((s) => s.toasts);
  const dismiss = useMeetingStore((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex flex-col items-center gap-2 px-3" aria-live="assertive">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-xl border px-3 py-2.5 text-sm shadow-lg ${
            t.kind === 'error' ? 'border-danger bg-danger-soft' : t.kind === 'success' ? 'border-ok bg-ok-soft' : 'border-border bg-surface'
          }`}
        >
          {t.kind === 'error' ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          )}
          <div className="flex-1">
            <div className="font-medium">{t.message}</div>
            {t.hint && <div className="mt-0.5 text-muted">{t.hint}</div>}
          </div>
          <button className="text-muted hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Đóng thông báo">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const cls = {
    info: 'border-border bg-surface-2',
    warn: 'border-warn/50 bg-warn-soft',
    error: 'border-danger/50 bg-danger-soft',
    ok: 'border-ok/50 bg-ok-soft',
  }[kind];
  const Icon = kind === 'error' || kind === 'warn' ? AlertTriangle : kind === 'ok' ? CheckCircle2 : Info;
  const iconCls = { info: 'text-accent', warn: 'text-warn', error: 'text-danger', ok: 'text-ok' }[kind];
  return (
    <div className={`flex gap-2 rounded-xl border px-3 py-2.5 text-sm ${cls}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${iconCls}`} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
