import type { Meeting } from '@amt/shared';
import { createDiarizer, createTranscriptionProvider, createTranslationProvider } from '../ai-provider-manager/registry';
import type { SettingsService } from '../settings/settings-service';
import type { TranscriptRepository } from '../transcript-manager/repository';
import { MeetingSession, type ProviderFactory, type SessionDeps } from './session';

export interface SessionManagerDeps {
  repo: TranscriptRepository;
  settings: SettingsService;
  audioDir: string;
  log: SessionDeps['log'];
  /** Cho phép kiểm thử thay provider thật bằng provider cục bộ. */
  providerFactory?: (ownerId: string) => ProviderFactory;
}

/** Quản lý nhiều phiên họp độc lập đang chạy trên máy chủ. */
export class SessionManager {
  private readonly sessions = new Map<string, MeetingSession>();

  constructor(private readonly deps: SessionManagerDeps) {}

  private defaultFactory(ownerId: string): ProviderFactory {
    return (meeting: Meeting, onSpeaker) => {
      const settings = this.deps.settings.resolve(ownerId);
      const glossary = [settings.pipeline.glossary, meeting.glossary].join('\n');
      return {
        settings,
        stt: createTranscriptionProvider(settings, meeting.diarizationMode, glossary),
        translator: createTranslationProvider(settings),
        diarizer: createDiarizer(meeting.diarizationMode, this.deps.repo, onSpeaker),
      };
    };
  }

  get(meetingId: string): MeetingSession | null {
    const existing = this.sessions.get(meetingId);
    if (existing) return existing;
    const meeting = this.deps.repo.getMeeting(meetingId);
    const ownerId = this.deps.repo.getMeetingOwner(meetingId);
    if (!meeting || !ownerId) return null;
    const factory = this.deps.providerFactory?.(ownerId) ?? this.defaultFactory(ownerId);
    const session = new MeetingSession(meeting, {
      repo: this.deps.repo,
      createProviders: factory,
      resolveSettings: () => this.deps.settings.resolve(ownerId),
      audioDir: this.deps.audioDir,
      log: this.deps.log,
      onDisposed: (id) => this.sessions.delete(id),
    });
    this.sessions.set(meetingId, session);
    return session;
  }

  peek(meetingId: string): MeetingSession | undefined {
    return this.sessions.get(meetingId);
  }

  /** Áp dụng cấu hình AI mới cho các phiên đang chạy của người dùng. */
  reloadForUser(userId: string) {
    for (const s of this.sessions.values()) {
      if (this.deps.repo.getMeetingOwner(s.meeting.id) === userId) s.reloadProviders();
    }
  }

  shutdownAll() {
    for (const s of this.sessions.values()) s.shutdown();
    this.sessions.clear();
  }

  remove(meetingId: string) {
    this.sessions.delete(meetingId);
  }

  get size() {
    return this.sessions.size;
  }
}
