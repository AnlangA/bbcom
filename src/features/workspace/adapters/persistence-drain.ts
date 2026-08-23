import type { DataFrame } from '@/types';
import type { WorkspaceSessionChangeEvent, WorkspaceSessionPort } from '../../sessions';
import { projectWorkspaceWaveformPreferences } from './workspace-waveform-projection';
import type { WorkspaceApplicationService } from '../application';
import type {
  WorkspaceConfigMutationCommand,
  WorkspaceQueueOutcome,
  WorkspaceRuntimePersistenceDrain,
} from '../application';

export class WorkspacePersistenceDrain {
  constructor(
    private readonly store: WorkspaceSessionPort,
    private readonly application: WorkspaceApplicationService,
    private readonly getDrain: () => WorkspaceRuntimePersistenceDrain | null,
    private readonly onRejected: (messageKey: string) => void,
  ) {}

  queueFrame(sessionId: string, frame: DataFrame): void {
    this.requireAccepted(
      this.route(
        (d) => d.queueCapturedFrame({ sessionId, frame }),
        () => this.application.queueCapturedFrame(sessionId, frame),
      ),
    );
  }

  queueCaptureReset(sessionId: string): void {
    const commands: WorkspaceConfigMutationCommand[] = [
      { kind: 'replace-capture', sessionId, payload: { frames: [] } },
    ];
    this.requireAccepted(
      this.route(
        (d) => d.queueOrderedMutations(commands),
        () => this.application.queueCaptureReset(sessionId),
      ),
    );
  }

  queueCaptureTrim(sessionId: string, droppedFrames: number, droppedBytes: number): void {
    this.requireAccepted(
      this.route(
        (d) => d.queueCaptureTrim(sessionId, droppedFrames, droppedBytes),
        () => this.application.queueCaptureTrim(sessionId, droppedFrames, droppedBytes),
      ),
    );
  }

  queueWaveformReplacement(
    sessionId: string,
    waveform: import('@/types').SessionWaveformState,
  ): void {
    const channels = waveform.channels.map((c) => ({
      channelIndex: c.channelIndex,
      config: structuredClone(c.config),
    }));
    const samples = waveform.samples.map((s) => ({ ...s }));
    this.requireAccepted(
      this.route(
        (d) => d.queueWaveformReplacement(sessionId, channels, samples),
        () => this.application.queueWaveformReplacement(sessionId, channels, samples),
      ),
    );
  }

  queueWaveformSamples(
    sessionId: string,
    samples: readonly import('@/types').SessionWaveformSample[],
  ): void {
    const payload = samples.map((s) => ({ ...s }));
    this.requireAccepted(
      this.route(
        (d) => d.queueWaveformSamples(sessionId, payload),
        () => this.application.queueWaveformSamples(sessionId, payload),
      ),
    );
  }

  queueWaveformCursor(
    sessionId: string,
    cursor: import('@/types').SessionWaveformFrameCursor,
  ): void {
    const session = this.store.sessions.find((c) => c.id === sessionId);
    if (!session) return;
    this.queueConfigMutation({
      kind: 'upsert-feature-state',
      entityId: sessionId,
      payload: {
        feature: 'waveform',
        state: projectWorkspaceWaveformPreferences(
          session,
          cursor,
          this.store.workspaceWaveformBySessionId[sessionId]?.channels,
        ),
      },
    });
  }

  queueWaveformPreferences(
    sessionId: string,
    waveform: import('@/types').SessionWaveformState,
  ): void {
    const session = this.store.sessions.find((c) => c.id === sessionId);
    if (!session) return;
    this.queueConfigMutation({
      kind: 'upsert-feature-state',
      entityId: sessionId,
      payload: {
        feature: 'waveform',
        state: projectWorkspaceWaveformPreferences(
          session,
          waveform.frameCursor,
          waveform.channels,
        ),
      },
    });
  }

  queueWaveformFrameIngest(
    event: Extract<WorkspaceSessionChangeEvent, { kind: 'waveform-frame-ingested' }>,
  ): void {
    const session = this.store.sessions.find((c) => c.id === event.sessionId);
    if (!session) return;
    const channels = event.waveform.channels.map((c) => ({
      channelIndex: c.channelIndex,
      config: structuredClone(c.config),
    }));
    const samples = event.samples.map((s) => ({ ...s }));
    const ingest = {
      sessionId: event.sessionId,
      mode: event.mode,
      channels,
      samples,
      featureState: projectWorkspaceWaveformPreferences(
        session,
        event.waveform.frameCursor,
        event.waveform.channels,
      ),
    } as const;
    this.requireAccepted(
      this.route(
        (d) => d.queueWaveformFrameIngest(ingest),
        () => this.application.queueWaveformFrameIngest(ingest),
      ),
    );
  }

  queueAiMessage(
    sessionId: string,
    message: import('@/types/ai').AiChatMessage,
    startPosition: number,
  ): void {
    this.queueConfigMutation({
      kind: 'append-ai-messages',
      sessionId,
      payload: {
        startPosition,
        messages: [
          {
            id: message.id,
            role: message.role,
            content: message.content,
            timestampMs: message.timestamp,
          },
        ],
      },
    });
  }

  queueAiMessagesCleared(sessionId: string): void {
    this.queueConfigMutation({ kind: 'clear-ai-messages', sessionId });
  }

  private queueConfigMutation(command: WorkspaceConfigMutationCommand): void {
    this.requireAccepted(
      this.route(
        (d) => d.queueConfigMutation(command),
        () => this.application.queueConfigMutation(command),
      ),
    );
  }

  private route<T extends WorkspaceQueueOutcome>(
    drain: (d: WorkspaceRuntimePersistenceDrain) => T,
    app: () => T,
  ): T {
    const d = this.getDrain();
    return d ? drain(d) : app();
  }

  private requireAccepted(outcome: WorkspaceQueueOutcome): void {
    if (!outcome.accepted) this.onRejected(outcome.messageKey);
  }
}
