import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Mic } from 'lucide-react';
import type { Speaker } from '@amt/shared';
import { useMeetingStore } from '../store/meeting-store';
import { fold, SegmentCard, type ViewMode } from './SegmentCard';

const CONTINUE_GAP_MS = 30_000;

/**
 * Danh sách lượt phát biểu (ảo hóa – chỉ render phần đang nhìn thấy, chịu được hàng nghìn lượt).
 * Tự cuộn tới nội dung mới chỉ khi người dùng đang ở cuối danh sách.
 */
export function TranscriptView({
  view,
  showOriginal,
  query,
  onRetry,
  emptyHint,
}: {
  view: ViewMode;
  showOriginal: boolean;
  query: string;
  onRetry: (id: string) => void;
  emptyHint: React.ReactNode;
}) {
  const order = useMeetingStore((s) => s.order);
  const segments = useMeetingStore((s) => s.segments);
  const speakersMap = useMeetingStore((s) => s.speakers);
  const speaking = useMeetingStore((s) => s.speaking);
  const speakers = useMemo(() => Object.values(speakersMap).sort((a, b) => a.colorIndex - b.colorIndex), [speakersMap]);

  const ids = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return order;
    return order.filter((id) => {
      const s = segments[id];
      return s && (fold(s.originalText).includes(q) || fold(s.translatedText).includes(q));
    });
  }, [order, segments, query]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (view === 'vi' ? 96 : 130),
    overscan: 6,
    getItemKey: (i) => ids[i],
  });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  }, []);

  const scrollToEnd = useCallback(() => {
    if (!ids.length) return;
    virtualizer.scrollToIndex(ids.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    atBottomRef.current = true;
    setShowJump(false);
  }, [ids.length, virtualizer]);

  // Nội dung mới / cập nhật: cuộn nếu đang ở cuối, ngược lại hiện nút "Nội dung mới"
  const lastId = ids[ids.length - 1];
  const lastSeg = lastId ? segments[lastId] : undefined;
  useEffect(() => {
    if (!lastSeg) return;
    if (atBottomRef.current && !query) scrollToEnd();
    else if (!query) setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, lastSeg?.originalText, lastSeg?.translatedText, ids.length]);

  const anySpeaking = Object.values(speaking).some(Boolean);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain px-2 pb-6 sm:px-4" role="log" aria-live="polite" aria-relevant="additions">
        {ids.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-muted">{query ? 'Không tìm thấy nội dung phù hợp.' : emptyHint}</div>
        ) : (
          <div className="relative mx-auto w-full max-w-5xl" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const id = ids[vi.index];
              const seg = segments[id];
              if (!seg) return null;
              const prev = vi.index > 0 ? segments[ids[vi.index - 1]] : undefined;
              const continued =
                !query && !!prev && prev.speakerId === seg.speakerId && seg.speakerId !== null && seg.startOffsetMs - prev.endOffsetMs < CONTINUE_GAP_MS;
              const speaker: Speaker | null = seg.speakerId ? speakersMap[seg.speakerId] ?? null : null;
              return (
                <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${vi.start}px)` }}>
                  <SegmentCard
                    segment={seg}
                    speaker={speaker}
                    speakers={speakers}
                    continued={continued}
                    view={view}
                    showOriginal={showOriginal}
                    query={query}
                    onRetry={onRetry}
                  />
                </div>
              );
            })}
          </div>
        )}
        {anySpeaking && !query && (
          <div className="mx-auto mt-3 flex max-w-5xl items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted">
            <Mic className="pulse size-4 text-accent" aria-hidden /> Đang có người nói…
          </div>
        )}
      </div>
      {showJump && (
        <button className="btn btn-primary absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg" onClick={scrollToEnd}>
          <ArrowDown className="size-4" aria-hidden /> Nội dung mới
        </button>
      )}
    </div>
  );
}
