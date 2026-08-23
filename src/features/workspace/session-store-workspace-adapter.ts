import type { WorkspaceSessionChangeEvent, WorkspaceSessionPort } from '../sessions';
import { WorkspacePersistenceDrain } from './adapters/persistence-drain';
import { SessionProjection, type SessionProjectionState } from './adapters/session-projection';
import type { WorkspaceApplicationService } from './application';
import type {
  WorkspaceConfigMutationCommand,
  WorkspaceRuntimePersistenceDrain,
  WorkspaceSessionFacade,
  WorkspaceFacadeSnapshot,
} from './application';

export class WorkspaceSessionFacadeBridge implements WorkspaceSessionFacade {
  private delegate: WorkspaceSessionFacade | null = null;
  bind(delegate: WorkspaceSessionFacade): void {
    if (this.delegate && this.delegate !== delegate)
      throw new Error('workspace session facade is already bound');
    this.delegate = delegate;
  }
  replaceWorkspace(snapshot: WorkspaceFacadeSnapshot): void {
    const d = this.delegate;
    if (!d) throw new Error('workspace session facade is not bound');
    d.replaceWorkspace(snapshot);
  }
  clearWorkspace(): void {
    const d = this.delegate;
    if (!d) throw new Error('workspace session facade is not bound');
    d.clearWorkspace();
  }
}

export class SessionStoreWorkspaceAdapter implements WorkspaceSessionFacade {
  private detach: (() => void) | null = null;
  private detachApplication: (() => void) | null = null;
  private persistenceDrain: WorkspaceRuntimePersistenceDrain | null = null;
  private readonly projectionState: SessionProjectionState = {
    projectionInFlight: new Set(),
    projectedSessionIds: new Set(),
    projectedSortOrders: new Map(),
    projectedActiveSessionId: null,
  };
  private readonly persistence: WorkspacePersistenceDrain;
  private readonly projection: SessionProjection;

  constructor(
    private readonly store: WorkspaceSessionPort,
    private readonly application: WorkspaceApplicationService,
  ) {
    this.persistence = new WorkspacePersistenceDrain(
      store,
      application,
      () => this.persistenceDrain,
      (k) => application.rejectPersistence(k),
    );
    this.projection = new SessionProjection(
      store,
      application,
      this.projectionState,
      (c) => this.routeOrdered(c),
      (c) => this.routeConfig(c),
      (k) => application.rejectPersistence(k),
    );
  }

  start(): void {
    if (this.detach) return;
    this.detach = this.store.subscribeWorkspaceChanges((event) => {
      try {
        this.onChange(event);
      } catch {
        this.application.rejectPersistence('workspace.mutation.invalid');
      }
    });
    this.detachApplication = this.application.subscribe((snapshot) => {
      if (
        snapshot.currentWorkspace &&
        snapshot.saveHealth === 'clean' &&
        snapshot.unsavedMutationCount === 0
      ) {
        this.store.markWorkspacePersisted();
      }
    });
  }

  stop(): void {
    this.detach?.();
    this.detachApplication?.();
    this.detach = null;
    this.detachApplication = null;
    this.persistenceDrain = null;
  }

  beginPersistenceDrain(drain: WorkspaceRuntimePersistenceDrain): void {
    if (this.persistenceDrain && this.persistenceDrain !== drain) {
      throw new Error('workspace persistence drain already active');
    }
    this.persistenceDrain = drain;
  }

  endPersistenceDrain(drain: WorkspaceRuntimePersistenceDrain): void {
    if (this.persistenceDrain === drain) this.persistenceDrain = null;
  }

  replaceWorkspace(snapshot: Parameters<WorkspaceSessionFacade['replaceWorkspace']>[0]): void {
    this.store.replaceWorkspaceSessions(snapshot.sessions, snapshot.activeSessionId);
    this.projectionState.projectedSessionIds = new Set(snapshot.sessions.map((e) => e.session.id));
    this.projectionState.projectedSortOrders = new Map(
      snapshot.sessions.map((e) => [e.session.id, e.sortOrder]),
    );
    this.projectionState.projectedActiveSessionId = snapshot.activeSessionId;
  }

  clearWorkspace(): void {
    this.store.replaceWorkspaceSessions([], null);
    this.projectionState.projectedSessionIds.clear();
    this.projectionState.projectedSortOrders.clear();
    this.projectionState.projectedActiveSessionId = null;
  }

  private onChange(event: WorkspaceSessionChangeEvent): void {
    if (this.persistenceDrain && !this.persistenceDrain.accepting) this.persistenceDrain = null;
    if (
      event.kind !== 'catalog-changed' &&
      'sessionId' in event &&
      !this.store.isPersistentSession(event.sessionId)
    )
      return;
    switch (event.kind) {
      case 'frame-added':
        this.persistence.queueFrame(event.sessionId, event.frame);
        return;
      case 'capture-cleared':
        this.persistence.queueCaptureReset(event.sessionId);
        return;
      case 'capture-trimmed':
        this.persistence.queueCaptureTrim(event.sessionId, event.droppedFrames, event.droppedBytes);
        return;
      case 'waveform-replaced':
        this.persistence.queueWaveformReplacement(event.sessionId, event.waveform);
        return;
      case 'waveform-samples-appended':
        this.persistence.queueWaveformSamples(event.sessionId, event.samples);
        return;
      case 'waveform-cursor-changed':
        this.persistence.queueWaveformCursor(event.sessionId, event.cursor);
        return;
      case 'waveform-channel-config-changed':
        this.persistence.queueWaveformPreferences(event.sessionId, event.waveform);
        return;
      case 'waveform-frame-ingested':
        this.persistence.queueWaveformFrameIngest(event);
        return;
      case 'session-changed':
        this.projection.projectSession(event.sessionId);
        return;
      case 'ai-message-appended':
        this.persistence.queueAiMessage(event.sessionId, event.message, event.startPosition);
        return;
      case 'ai-messages-cleared':
        this.persistence.queueAiMessagesCleared(event.sessionId);
        return;
      case 'session-restored':
        this.projection.projectRestoredSession(event.sessionId);
        return;
      case 'catalog-changed':
        this.projection.projectCatalog();
        return;
      default:
        event satisfies never;
    }
  }

  private routeOrdered(commands: readonly Readonly<WorkspaceConfigMutationCommand>[]) {
    return this.persistenceDrain
      ? this.persistenceDrain.queueOrderedMutations(commands)
      : this.application.queueOrderedMutations(commands);
  }

  private routeConfig(commands: readonly Readonly<WorkspaceConfigMutationCommand>[]) {
    return this.persistenceDrain
      ? this.persistenceDrain.queueConfigMutations(commands)
      : this.application.queueConfigMutations(commands);
  }
}
