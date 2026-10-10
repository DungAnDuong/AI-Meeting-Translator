import workletUrl from './capture.worklet.ts?worker&url';

export type SourceKind = 'mic' | 'tab';

export interface CapturedUtterance {
  sourceId: string;
  sourceLabel: string;
  pcm: Int16Array;
  capturedAt: number; // epoch ms (đồng hồ máy khách)
  durationMs: number;
}

export interface SourceHandlers {
  onUtterance: (u: CapturedUtterance) => void;
  onLevel: (sourceId: string, rms: number) => void;
  onSpeaking: (sourceId: string, speaking: boolean) => void;
  onEnded: (sourceId: string, reason: string) => void;
}

/** Lỗi thu âm đã được diễn giải cho người dùng. */
export class CaptureError extends Error {
  constructor(
    message: string,
    public readonly hint: string,
    public readonly code: 'denied' | 'not_found' | 'busy' | 'unsupported' | 'no_audio' | 'cancelled' | 'insecure' | 'unknown',
  ) {
    super(message);
  }
}

export function explainMediaError(err: unknown, kind: SourceKind): CaptureError {
  const name = (err as DOMException)?.name ?? '';
  if (!window.isSecureContext) {
    return new CaptureError('Trình duyệt chỉ cho thu âm trên HTTPS hoặc localhost', 'Hãy mở ứng dụng qua https:// (hoặc http://localhost khi phát triển).', 'insecure');
  }
  if (kind === 'tab' && name === 'NotAllowedError') {
    return new CaptureError('Bạn đã hủy hoặc không cho phép chia sẻ màn hình/tab', 'Bấm Bắt đầu lại và chọn tab cuộc họp, nhớ bật "Chia sẻ âm thanh tab".', 'cancelled');
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError(
        'Quyền truy cập micro đã bị từ chối',
        'Bấm biểu tượng ổ khóa cạnh thanh địa chỉ → cho phép Micro, sau đó tải lại trang. Trên điện thoại: Cài đặt → Trình duyệt → Micro.',
        'denied',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CaptureError('Không tìm thấy micro', 'Kiểm tra micro đã cắm/bật chưa, hoặc chọn thiết bị đầu vào khác.', 'not_found');
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError('Micro đang bận hoặc không hoạt động', 'Đóng ứng dụng khác đang dùng micro (Zoom, Teams...) hoặc thử thiết bị khác.', 'busy');
    case 'TypeError':
      return new CaptureError('Trình duyệt không hỗ trợ tính năng thu âm này', 'Dùng Chrome/Edge bản mới trên máy tính để thu âm thanh tab.', 'unsupported');
    default:
      return new CaptureError(`Không thể bắt đầu thu âm: ${(err as Error)?.message ?? err}`, 'Thử tải lại trang hoặc chọn nguồn âm thanh khác.', 'unknown');
  }
}

export function supportsTabAudio(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
}

let sharedContext: AudioContext | null = null;
let moduleLoaded: Promise<void> | null = null;

async function getContext(): Promise<AudioContext> {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext({ latencyHint: 'interactive' });
    moduleLoaded = sharedContext.audioWorklet.addModule(workletUrl);
  }
  await moduleLoaded;
  if (sharedContext.state === 'suspended') await sharedContext.resume();
  return sharedContext;
}

/** Một nguồn âm thanh đang được thu (micro hoặc tab). */
export class AudioSourceCapture {
  private node: AudioWorkletNode | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private flushResolvers: Array<() => void> = [];
  muted = false;

  private constructor(
    readonly sourceId: string,
    readonly kind: SourceKind,
    readonly label: string,
    private readonly stream: MediaStream,
    private readonly h: SourceHandlers,
  ) {}

  static async openMic(clientId: string, deviceId: string | undefined, h: SourceHandlers): Promise<AudioSourceCapture> {
    if (!navigator.mediaDevices?.getUserMedia) throw explainMediaError(new TypeError('no getUserMedia'), 'mic');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      throw explainMediaError(err, 'mic');
    }
    const track = stream.getAudioTracks()[0];
    const cap = new AudioSourceCapture(`${clientId}:mic:${deviceId ?? 'default'}`.slice(0, 120), 'mic', track?.label || 'Micro', stream, h);
    await cap.start();
    return cap;
  }

  /**
   * Âm thanh tab/hệ thống qua chia sẻ màn hình. Trình duyệt bắt buộc người dùng chọn tab và
   * tích "Chia sẻ âm thanh". Không phải trình duyệt nào cũng hỗ trợ (Safari/di động thường không).
   */
  static async openTab(clientId: string, h: SourceHandlers): Promise<AudioSourceCapture> {
    if (!supportsTabAudio()) {
      throw new CaptureError('Trình duyệt/thiết bị này không hỗ trợ thu âm thanh tab', 'Dùng Chrome hoặc Edge trên máy tính, hoặc chọn nguồn Micro.', 'unsupported');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
        // Gợi ý cho Chrome: ưu tiên tab, có âm thanh hệ thống
        ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include' } as object),
      } as DisplayMediaStreamOptions);
    } catch (err) {
      throw explainMediaError(err, 'tab');
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CaptureError(
        'Không nhận được âm thanh từ tab đã chọn',
        'Khi chọn tab, hãy bật "Chia sẻ âm thanh tab" (Share tab audio). Cửa sổ ứng dụng (Zoom/Teams desktop) thường không chia sẻ được âm thanh – hãy dùng bản web của cuộc họp trong một tab, hoặc chọn "Toàn màn hình" + "Chia sẻ âm thanh hệ thống" trên Windows.',
        'no_audio',
      );
    }
    const label = stream.getVideoTracks()[0]?.label || 'Âm thanh tab';
    const cap = new AudioSourceCapture(`${clientId}:tab`, 'tab', label, stream, h);
    await cap.start();
    return cap;
  }

  private async start() {
    const ctx = await getContext();
    this.srcNode = ctx.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    this.node = new AudioWorkletNode(ctx, 'amt-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'utterance') {
        const durationMs = Math.round((m.pcm.length / 16000) * 1000);
        const capturedAt = Date.now() - Math.round(((m.nowSample - m.startSample) / 16000) * 1000);
        this.h.onUtterance({ sourceId: this.sourceId, sourceLabel: this.label, pcm: m.pcm, capturedAt, durationMs });
      } else if (m.type === 'level') this.h.onLevel(this.sourceId, m.rms);
      else if (m.type === 'speaking') this.h.onSpeaking(this.sourceId, m.speaking);
      else if (m.type === 'flushed') this.flushResolvers.splice(0).forEach((r) => r());
    };
    this.srcNode.connect(this.node);
    for (const t of this.stream.getTracks()) {
      t.addEventListener('ended', () => this.h.onEnded(this.sourceId, this.kind === 'tab' ? 'Đã dừng chia sẻ tab' : 'Micro đã bị ngắt'));
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.node?.port.postMessage({ type: 'mute', muted });
    this.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  pause() {
    this.node?.port.postMessage({ type: 'pause' });
  }

  resume() {
    this.node?.port.postMessage({ type: 'resume' });
  }

  /** Gửi nốt lượt nói đang dở (dùng khi tạm dừng/kết thúc). */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.node) return resolve();
      this.flushResolvers.push(resolve);
      this.node.port.postMessage({ type: 'flush' });
      setTimeout(resolve, 500);
    });
  }

  stop() {
    try {
      this.srcNode?.disconnect();
      this.node?.disconnect();
    } catch {
      /* đã ngắt */
    }
    this.node?.port.close();
    this.stream.getTracks().forEach((t) => t.stop());
    this.node = null;
  }
}
