import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { History, Home, Languages, Settings } from 'lucide-react';

/** Khung cho các trang ngoài phòng họp (Trang chủ, Lịch sử, Cài đặt). */
export function AppShell({ children, title }: { children: ReactNode; title?: string }) {
  const link = ({ isActive }: { isActive: boolean }) => `btn btn-ghost ${isActive ? 'bg-surface-2' : ''}`;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:px-4">
          <Link to="/" className="mr-auto flex items-center gap-2 font-bold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Languages className="size-5" aria-hidden />
            </span>
            <span className="hidden sm:inline">AI Meeting Translator</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="Điều hướng chính">
            <NavLink to="/" end className={link} aria-label="Trang chủ">
              <Home className="size-4" aria-hidden />
              <span className="hidden md:inline">Trang chủ</span>
            </NavLink>
            <NavLink to="/history" className={link} aria-label="Lịch sử cuộc họp">
              <History className="size-4" aria-hidden />
              <span className="hidden md:inline">Lịch sử</span>
            </NavLink>
            <NavLink to="/settings" className={link} aria-label="Cài đặt AI">
              <Settings className="size-4" aria-hidden />
              <span className="hidden md:inline">Cài đặt</span>
            </NavLink>          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-4 sm:px-4 sm:py-6">
        {title && <h1 className="mb-4 text-xl font-bold sm:text-2xl">{title}</h1>}
        {children}
      </main>
    </div>
  );
}
