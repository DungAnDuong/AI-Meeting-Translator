import type { Speaker } from '@amt/shared';
import { sleep } from '../ai-provider-manager/retry';
import type { TranscriptRepository } from '../transcript-manager/repository';
import type { MeetingSession } from './session';

/**
 * CHẾ ĐỘ DEMO – phát lại transcript MẪU (không phải kết quả nhận dạng thật) để thử giao diện,
 * lưu trữ, sửa tên người nói, xuất file... mà không cần API Key. Cuộc họp demo luôn được gắn nhãn [DEMO].
 */
export const DEMO_SCRIPT: Array<{ speaker: string; en: string; vi: string; gapMs: number; overlap?: boolean }> = [
  { speaker: 'A', en: 'Good morning everyone. Let’s start with the control panel project status.', vi: 'Chào buổi sáng mọi người. Chúng ta bắt đầu với tình trạng dự án tủ điều khiển.', gapMs: 800 },
  { speaker: 'A', en: 'We need to finish the electrical design before Friday.', vi: 'Chúng ta cần hoàn thành thiết kế điện trước thứ Sáu.', gapMs: 1500 },
  { speaker: 'B', en: 'I agree. We also need to check the cable tray dimensions.', vi: 'Tôi đồng ý. Chúng ta cũng cần kiểm tra kích thước máng cáp.', gapMs: 1200 },
  { speaker: 'C', en: 'Can you send the updated drawings tomorrow?', vi: 'Bạn có thể gửi bản vẽ đã cập nhật vào ngày mai không?', gapMs: 1000 },
  { speaker: 'B', en: 'Yes, I will send drawing E-201 revision C by tomorrow noon.', vi: 'Vâng, tôi sẽ gửi bản vẽ E-201 phiên bản C trước trưa mai.', gapMs: 1500 },
  { speaker: 'A', en: 'The PLC is a Siemens S7-1500 with 128 digital inputs. Please update the BOM accordingly.', vi: 'PLC là Siemens S7-1500 với 128 đầu vào số. Vui lòng cập nhật BOM cho phù hợp.', gapMs: 1300 },
  { speaker: 'C', en: 'What about the HMI screens for the SCADA integration?', vi: 'Còn các màn hình HMI cho việc tích hợp SCADA thì sao?', gapMs: 900, overlap: true },
  { speaker: 'A', en: 'We haven’t decided yet. Let’s discuss it next week.', vi: 'Chúng ta chưa quyết định. Hãy thảo luận vào tuần sau.', gapMs: 1400 },
];

export async function runDemo(session: MeetingSession, repo: TranscriptRepository): Promise<void> {
  if (session.isDemoRunning) return;
  session.setDemoRunning(true);
  const meetingId = session.meeting.id;
  try {
    const speakers = new Map<string, Speaker>(repo.listSpeakers(meetingId).map((s) => [s.label, s]));
    const already = repo.listSegments(meetingId).length;
    const start = Math.max(0, Date.now() - Date.parse(session.meeting.startedAt));
    let offset = start;
    for (const line of DEMO_SCRIPT.slice(already % DEMO_SCRIPT.length)) {
      const stop = () => session.signal.aborted || session.isEnding || session.isEnded;
      while (session.meeting.status === 'paused' && !stop()) await sleep(300, session.signal);
      if (stop()) break;
      await sleep(line.gapMs, session.signal);
      if (stop()) break;

      let speaker = speakers.get(line.speaker);
      if (!speaker) {
        speaker = repo.createSpeaker(meetingId);
        speakers.set(speaker.label, speaker);
        session.broadcast({ type: 'speaker', speaker });
      }
      const durationMs = 600 + line.en.split(' ').length * 260;
      let seg = repo.createSegment({
        meetingId,
        chunkId: null,
        subIndex: 0,
        speakerId: speaker.id,
        sourceId: 'demo',
        startOffsetMs: offset,
        endOffsetMs: offset + durationMs,
        startedAt: new Date(Date.parse(session.meeting.startedAt) + offset).toISOString(),
        status: 'transcribing',
        overlap: line.overlap,
      });
      session.emitSegment(seg);
      // Mô phỏng văn bản xuất hiện dần như streaming
      const words = line.en.split(' ');
      for (let i = 1; i <= words.length; i += 2) {
        if (stop()) break;
        session.broadcast({ type: 'segment', segment: { ...seg, originalText: words.slice(0, i).join(' '), interim: true } });
        await sleep(90, session.signal);
      }
      seg = repo.updateSegment(seg.id, { originalText: line.en, language: 'en', status: 'translating', sttLatencyMs: 0 });
      session.emitSegment(seg);
      const viWords = line.vi.split(' ');
      for (let i = 2; i <= viWords.length; i += 3) {
        if (stop()) break;
        session.broadcast({ type: 'segment', segment: { ...seg, translatedText: viWords.slice(0, i).join(' '), interim: true } });
        await sleep(70, session.signal);
      }
      session.emitSegment(repo.updateSegment(seg.id, { translatedText: line.vi, status: 'final', translationLatencyMs: 0 }));
      offset += durationMs + line.gapMs;
    }
  } finally {
    session.setDemoRunning(false);
  }
}
