import { useCallback, useEffect, useRef } from 'react';
import type { Meeting, MeetingSummary, Segment, Speaker } from '@amt/shared';
import { AudioSourceCapture, CaptureError, type SourceHandlers } from '../audio/audio-capture';
import { api, errorText } from '../lib/api';
import { getClientId, MeetingConnection } from '../lib/connection';
import { useMeetingStore } from '../store/meeting-store';

export type SourceChoice = { kind: 'mic'; deviceId?: string } | { kind: 'tab' } | { kind: 'mic+tab'; deviceId?: string };

/**
 * Điều phối một phiên họp phía trình duyệt: tải dữ liệu, giữ kết nối realtime,
 * quản lý các nguồn thu âm và luồng tạm dừng / tiếp tục / kết thúc.
 */
export function useMeetingSession(meetingId: string) {
  const connRef = useRef<MeetingConnection | null>(null);
  const sourcesRef = useRef(new Map<string, AudioSourceCapture>());
  const levelsRef = useRef(new Map<string, number>());
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const st = useMeetingStore;

  // ---------------- kết nối & tải dữ liệu ----------------
  useEffect(() => {
    st.getState().reset();
    let cancelled = false;
    api<{ meeting: Meeting; speakers: Speaker[]; segments: Segment[]; summary: MeetingSummary | null }>('GET', `/api/meetings/${meetingId}`).then(
      (d) => !cancelled && st.getState().load(d),
      (e) => !cancelled && st.getState().toast({ kind: 'error', message: errorText(e) }),
    );
    const conn = new MeetingConnection(meetingId, getClientId(), {
      onMessage: (m) => st.getState().apply(m, conn.clockOffsetMs),
      onState: (s) => st.getState().set({ connection: s }),
      onPendingChange: (n) => st.getState().set({ pendingUploads: n }),
      onDropped: () => st.getState().toast({ kind: 'error', message: 'Mất kết nối quá lâu – đã bỏ đoạn âm thanh cũ nhất do bộ đệm đầy' }),
    });
    connRef.current = conn;
    conn.connect();

    const levelTimer = window.setInterval(() => {
      const max = Math.max(0, ...levelsRef.current.values());
      if (Math.abs(max - st.getState().level) > 0.001) st.getState().set({ level: max });
    }, 100);

    const sources = sourcesRef.current;
    return () => {
      cancelled = true;
      clearInterval(levelTimer);
      for (const s of sources.values()) s.stop();
      sources.clear();
      conn.close();
      void wakeLockRef.current?.release().catch(() => {});
    };
  }, [meetingId, st]);

  // Cảnh báo khi rời trang trong lúc đang thu âm hoặc còn âm thanh chưa đồng bộ
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = st.getState();
      if (s.capture === 'capturing' || s.pendingUploads > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [st]);

  const syncSources = () =>
    st.getState().set({ sources: [...sourcesRef.current.values()].map((s) => ({ id: s.sourceId, kind: s.kind, label: s.label })) });

  const handlers: SourceHandlers = {
    onUtterance: (u) => {
      const s = st.getState();
      if (s.capture !== 'capturing' && s.capture !== 'stopping') return;
      connRef.current?.sendAudio({ sourceId: u.sourceId, sourceLabel: u.sourceLabel, capturedAtLocal: u.capturedAt, durationMs: u.durationMs, pcm: u.pcm });
    },
    onLevel: (id, rms) => levelsRef.current.set(id, rms),
    onSpeaking: (id, speaking) => st.getState().set({ speaking: { ...st.getState().speaking, [id]: speaking } }),
    onEnded: (id, reason) => {
      sourcesRef.current.get(id)?.stop();
      sourcesRef.current.delete(id);
      levelsRef.current.delete(id);
      syncSources();
      const left = sourcesRef.current.size;
      st.getState().toast({
        kind: left ? 'info' : 'error',
        message: reason,
        hint: left ? 'Các nguồn âm thanh khác vẫn đang thu.' : 'Thu âm đã dừng. Bấm Bắt đầu để thu lại, hoặc chọn nguồn Micro.',
      });
      if (!left) st.getState().set({ capture: 'idle', speaking: {} });
    },
  };

  const requestWakeLock = async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
      wakeLockRef.current = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* không hỗ trợ – bỏ qua */
    }
  };

  // ---------------- điều khiển ----------------
  const start = useCallback(
    async (choice: SourceChoice): Promise<boolean> => {
      const s = st.getState();
      if (s.capture === 'starting' || s.capture === 'capturing') return true;
      s.set({ capture: 'starting' });
      const clientId = getClientId();
      const opened: AudioSourceCapture[] = [];
      try {
        if (choice.kind === 'tab' || choice.kind === 'mic+tab') opened.push(await AudioSourceCapture.openTab(clientId, handlers));
        if (choice.kind === 'mic' || choice.kind === 'mic+tab') {
          try {
            opened.push(await AudioSourceCapture.openMic(clientId, choice.deviceId, handlers));
          } catch (err) {
            if (!opened.length) throw err;
            st.getState().toast({ kind: 'error', message: (err as CaptureError).message, hint: 'Vẫn tiếp tục thu âm thanh tab.' });
          }
        }
      } catch (err) {
        opened.forEach((o) => o.stop());
        const ce = err instanceof CaptureError ? err : new CaptureError(String(err), '', 'unknown');
        st.getState().set({ capture: 'idle' });
        st.getState().toast({ kind: 'error', message: ce.message, hint: ce.hint });
        return false;
      }
      for (const o of opened) {
        o.setMuted(st.getState().muted);
        sourcesRef.current.set(o.sourceId, o);
      }
      syncSources();
      if (st.getState().meeting?.status === 'paused') connRef.current?.send({ type: 'resume' });
      st.getState().set({ capture: 'capturing' });
      void requestWakeLock();
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st],
  );

  const pause = useCallback(async () => {
    const srcs = [...sourcesRef.current.values()];
    srcs.forEach((s) => s.pause());
    await Promise.all(srcs.map((s) => s.flush()));
    connRef.current?.send({ type: 'pause' });
    st.getState().set({ capture: 'paused', speaking: {} });
  }, [st]);

  const resume = useCallback(() => {
    if (!sourcesRef.current.size) return false;
    sourcesRef.current.forEach((s) => s.resume());
    connRef.current?.send({ type: 'resume' });
    st.getState().set({ capture: 'capturing' });
    return true;
  }, [st]);

  const toggleMute = useCallback(() => {
    const muted = !st.getState().muted;
    sourcesRef.current.forEach((s) => s.kind === 'mic' && s.setMuted(muted));
    st.getState().set({ muted });
  }, [st]);

  /** Dừng thu âm, gửi nốt phần đang nói dở và chờ server nhận hết âm thanh. */
  const stopCapture = useCallback(async () => {
    const srcs = [...sourcesRef.current.values()];
    if (srcs.length) {
      st.getState().set({ capture: 'stopping' });
      await Promise.all(srcs.map((s) => s.flush()));
      srcs.forEach((s) => s.stop());
      sourcesRef.current.clear();
      levelsRef.current.clear();
      syncSources();
    }
    st.getState().set({ capture: 'idle', speaking: {}, level: 0 });
    void wakeLockRef.current?.release().catch(() => {});
    return (await connRef.current?.waitForUploads()) ?? 0;
  }, [st]);

  /** Bước 1 kết thúc: dừng thu, đồng bộ, hỏi server còn đoạn chưa xử lý không. */
  const requestEnd = useCallback(async (): Promise<{ unsent: number }> => {
    const unsent = await stopCapture();
    if (unsent === 0) connRef.current?.send({ type: 'end', mode: 'ask' });
    return { unsent };
  }, [stopCapture]);

  const confirmEnd = useCallback(
    async (mode: 'drain' | 'abort') => {
      if (!connRef.current?.send({ type: 'end', mode })) {
        // Không có WebSocket → kết thúc qua REST
        try {
          const r = await api<{ meeting: Meeting }>('POST', `/api/meetings/${meetingId}/end`, { mode });
          st.getState().set({ meeting: r.meeting, endPending: null });
        } catch (e) {
          st.getState().toast({ kind: 'error', message: errorText(e) });
        }
      }
    },
    [meetingId, st],
  );

  const retry = useCallback((segmentId: string) => {
    if (!connRef.current?.send({ type: 'retry_segment', segmentId })) {
      void api('POST', `/api/meetings/${meetingId}/segments/${segmentId}/retry`, {}).catch((e) => st.getState().toast({ kind: 'error', message: errorText(e) }));
    }
  }, [meetingId, st]);

  const startDemo = useCallback(() => {
    connRef.current?.send({ type: 'demo_start' });
    st.getState().set({ capture: 'capturing' });
  }, [st]);

  const metrics = () => ({ rttMs: connRef.current?.rttMs ?? null });

  return { start, pause, resume, toggleMute, stopCapture, requestEnd, confirmEnd, retry, startDemo, metrics };
}
