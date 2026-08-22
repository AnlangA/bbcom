import { storeToRefs } from 'pinia';
import { computed, type ComputedRef, type DeepReadonly, type Ref } from 'vue';
import type { DataFrame, PortConfig, SerialSession, SessionWaveformState } from '@/types';
import {
  findCaptureFrameBySeq,
  sessionCaptureTimeline,
  type SessionCaptureTimeline,
} from '@/lib/capture-stream';
import type { WorkspacePortHint, WorkspaceSessionKind } from '@/generated/ipc-contracts';
import type { SessionStore } from '@/features/sessions/application/session-store';
import {
  type CompleteWorkspaceRebindResult,
  type DeletedSessionSnapshot,
  type UndoDeletedSessionResult,
  type WorkspaceSessionChangeEvent,
  type WorkspaceSessionChangeListener,
  type WorkspaceSessionMutationPermissions,
  type SessionCreationOptions,
} from '@/features/sessions/application/session-store';
import { resolveHeadlessSessionStore, useSessionStore } from '@/features/sessions/store/session-store';

type SessionPiniaStore = ReturnType<typeof useSessionStore>;

/** Public application port consumed by workspace persistence projection. */
export interface WorkspaceSessionPort {
  readonly sessions: readonly SerialSession[];
  readonly activeSessionId: string | null;
  readonly workspaceWaveformBySessionId: Readonly<Record<string, SessionWaveformState>>;
  readonly workspaceRebindBySessionId: Readonly<
    Record<
      string,
      {
        readonly required: true;
        readonly displayName: string;
        readonly kind: WorkspaceSessionKind;
        readonly lastPortHint: WorkspacePortHint | null;
      }
    >
  >;
  replaceWorkspaceSessions(
    ...args: Parameters<SessionPiniaStore['replaceWorkspaceSessions']>
  ): ReturnType<SessionPiniaStore['replaceWorkspaceSessions']>;
  markWorkspacePersisted(): void;
  subscribeWorkspaceChanges(listener: WorkspaceSessionChangeListener): () => void;
  createSession(
    portName: string,
    portConfig: PortConfig,
    options?: SessionCreationOptions,
  ): string | null;
  createRuntimeSession(
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): string | null;
  removeSession(sessionId: string): Promise<DeletedSessionSnapshot | null>;
  removeRuntimeSession(sessionId: string): Promise<DeletedSessionSnapshot | null>;
  updateSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean;
  updateRuntimeSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean;
  isPersistentSession(sessionId: string): boolean;
}

export type { WorkspaceSessionChangeEvent, WorkspaceSessionChangeListener };

function resolveSessionStore(): SessionStore {
  return resolveHeadlessSessionStore();
}

function resolveSessionFacade(): SessionPiniaStore {
  return useSessionStore();
}

export interface SessionMutationPolicyPort {
  readonly userMutationsAllowed: Readonly<Ref<boolean>>;
  readonly runtimeCaptureAllowed: Readonly<Ref<boolean>>;
  readonly persistenceReadOnly: Readonly<Ref<boolean>>;
  setWorkspaceMutationPermissions(permissions: WorkspaceSessionMutationPermissions): void;
  registerCleanup(sessionId: string, cleanup: () => Promise<void>): void;
}

export interface SessionCatalogPort {
  readonly sessions: Readonly<Ref<SerialSession[]>>;
  readonly activeSessionId: Readonly<Ref<string | null>>;
  readonly activeSession: ComputedRef<SerialSession | null>;
  readonly lastDeletedSession: Readonly<Ref<DeepReadonly<DeletedSessionSnapshot> | null>>;
  readonly workspaceRebindBySessionId: Readonly<
    Ref<
      Readonly<
        Record<
          string,
          {
            readonly required: true;
            readonly displayName: string;
            readonly kind: WorkspaceSessionKind;
            readonly lastPortHint: WorkspacePortHint | null;
          }
        >
      >
    >
  >;
  create(portName: string, portConfig: PortConfig): string | null;
  remove(sessionId: string): ReturnType<SessionPiniaStore['removeSession']>;
  undo(): UndoDeletedSessionResult;
  activate(sessionId: string): void;
  reorder(fromIndex: number, toIndex: number): void;
  framesVersion(sessionId: string): number;
  completeRebind(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
  ): CompleteWorkspaceRebindResult;
}

export interface SessionCapturePort {
  readonly session: ComputedRef<SerialSession | null>;
  readonly framesVersion: ComputedRef<number>;
  readonly timeline: ComputedRef<SessionCaptureTimeline | null>;
  add(
    frame: Omit<DataFrame, 'id' | 'timestamp' | 'captureSeq'> &
      Partial<Pick<DataFrame, 'timestamp' | 'captureSeq' | 'origin'>>,
    options?: { publish?: boolean },
  ): DataFrame | undefined;
  frameAt(captureSeq: number): DataFrame | undefined;
  publish(): void;
  clear(): void;
  setPaused(paused: boolean): void;
  updateDroppedBytes(total: number): void;
  projectConnected(connected: boolean): void;
  onCleared(listener: () => void): () => void;
}

export type SessionDocumentPort = Readonly<{
  session: ComputedRef<SerialSession | null>;
  isDirty: ComputedRef<boolean>;
}> &
  Pick<
    SessionPiniaStore,
    | 'addSendHistory'
    | 'clearSendHistory'
    | 'setSendDraft'
    | 'addQuickCommand'
    | 'removeQuickCommand'
    | 'addMacro'
    | 'updateMacro'
    | 'removeMacro'
    | 'addTrigger'
    | 'updateTrigger'
    | 'removeTrigger'
    | 'addHighlight'
    | 'updateHighlight'
    | 'removeHighlight'
    | 'addModbusRegister'
    | 'updateModbusRegister'
    | 'removeModbusRegister'
    | 'setModbusRegisters'
    | 'setModbusRegisterValues'
    | 'addLogAiMessage'
    | 'clearLogAiMessages'
    | 'setParserState'
    | 'setModbusConfig'
    | 'setShellConfig'
    | 'setMcumgrConfig'
    | 'setWaveformSourceMode'
    | 'setAutoLogTarget'
    | 'setTerminalAiModel'
    | 'setLogAiModel'
    | 'setLogAiContextMode'
    | 'setLogAiFrameLimit'
  >;

export interface SessionWaveformPort {
  readonly state: ComputedRef<SessionWaveformState | null>;
  appendSamples: SessionPiniaStore['appendSessionWaveformSamples'];
  replaceSamples: SessionPiniaStore['replaceSessionWaveformSamples'];
  setChannelVisible: SessionPiniaStore['setSessionWaveformChannelVisible'];
  clear: () => void;
  reset: SessionPiniaStore['resetSessionWaveform'];
  setFrameCursor: SessionPiniaStore['setSessionWaveformFrameCursor'];
  commitFrameIngest: SessionPiniaStore['commitSessionWaveformFrameIngest'];
}

export function useSessionMutationPolicy(): SessionMutationPolicyPort {
  const store = resolveSessionStore();
  const refs = storeToRefs(resolveSessionFacade());
  return {
    userMutationsAllowed: refs.userMutationsAllowed,
    runtimeCaptureAllowed: refs.runtimeCaptureAllowed,
    persistenceReadOnly: refs.persistenceReadOnly,
    setWorkspaceMutationPermissions: store.setWorkspaceMutationPermissions.bind(store),
    registerCleanup: store.registerCleanup.bind(store),
  };
}

export function useSessionCatalog(): SessionCatalogPort {
  const store = resolveSessionStore();
  const refs = storeToRefs(resolveSessionFacade());
  return {
    sessions: refs.sessions,
    activeSessionId: refs.activeSessionId,
    activeSession: refs.activeSession,
    lastDeletedSession: refs.lastDeletedSession as SessionCatalogPort['lastDeletedSession'],
    workspaceRebindBySessionId: refs.workspaceRebindBySessionId,
    create: store.createSession.bind(store),
    remove: store.removeSession.bind(store),
    undo: store.undoLastRemovedSession.bind(store),
    activate: store.setActiveSession.bind(store),
    reorder: store.reorderSessions.bind(store),
    framesVersion: store.getSessionFramesVersion.bind(store),
    completeRebind: store.completeWorkspaceRebind.bind(store),
  };
}

export function useSessionCapture(sessionId: string): SessionCapturePort {
  const store = resolveSessionStore();
  const refs = storeToRefs(resolveSessionFacade());
  const session = computed(() => refs.sessions.value.find((item) => item.id === sessionId) ?? null);
  const timeline = computed(() => (session.value ? sessionCaptureTimeline(session.value) : null));
  return {
    session,
    framesVersion: computed(() => store.getSessionFramesVersion(sessionId)),
    timeline,
    add: (frame, options) => store.addFrame(sessionId, frame, options),
    frameAt: (captureSeq) => {
      const view = timeline.value;
      return view ? findCaptureFrameBySeq(view, captureSeq) : undefined;
    },
    publish: () => store.publishSessionFrames(sessionId),
    clear: () => store.clearFrames(sessionId),
    setPaused: (paused) => store.setCapturePaused(sessionId, paused),
    updateDroppedBytes: (total) => store.updateDroppedBytes(sessionId, total),
    projectConnected: (connected) => store.setConnected(sessionId, connected),
    onCleared: (listener) => store.onFramesCleared(sessionId, listener),
  };
}

export function useSessionDocument(sessionId: string): SessionDocumentPort {
  const facade = resolveSessionFacade();
  const refs = storeToRefs(facade);
  return {
    session: computed(() => refs.sessions.value.find((item) => item.id === sessionId) ?? null),
    isDirty: computed(() => resolveSessionStore().isSessionConfigurationDirty(sessionId)),
    addSendHistory: facade.addSendHistory,
    clearSendHistory: facade.clearSendHistory,
    setSendDraft: facade.setSendDraft,
    addQuickCommand: facade.addQuickCommand,
    removeQuickCommand: facade.removeQuickCommand,
    addMacro: facade.addMacro,
    updateMacro: facade.updateMacro,
    removeMacro: facade.removeMacro,
    addTrigger: facade.addTrigger,
    updateTrigger: facade.updateTrigger,
    removeTrigger: facade.removeTrigger,
    addHighlight: facade.addHighlight,
    updateHighlight: facade.updateHighlight,
    removeHighlight: facade.removeHighlight,
    addModbusRegister: facade.addModbusRegister,
    updateModbusRegister: facade.updateModbusRegister,
    removeModbusRegister: facade.removeModbusRegister,
    setModbusRegisters: facade.setModbusRegisters,
    setModbusRegisterValues: facade.setModbusRegisterValues,
    addLogAiMessage: facade.addLogAiMessage,
    clearLogAiMessages: facade.clearLogAiMessages,
    setParserState: facade.setParserState,
    setModbusConfig: facade.setModbusConfig,
    setShellConfig: facade.setShellConfig,
    setMcumgrConfig: facade.setMcumgrConfig,
    setWaveformSourceMode: facade.setWaveformSourceMode,
    setAutoLogTarget: facade.setAutoLogTarget,
    setTerminalAiModel: facade.setTerminalAiModel,
    setLogAiModel: facade.setLogAiModel,
    setLogAiContextMode: facade.setLogAiContextMode,
    setLogAiFrameLimit: facade.setLogAiFrameLimit,
  };
}

export function useSessionWaveform(sessionId: string): SessionWaveformPort {
  const store = resolveSessionStore();
  return {
    state: computed(() => store.workspaceWaveformBySessionId.value[sessionId] ?? null),
    appendSamples: store.appendSessionWaveformSamples,
    replaceSamples: store.replaceSessionWaveformSamples,
    setChannelVisible: store.setSessionWaveformChannelVisible,
    clear: () => store.clearSessionWaveform(sessionId),
    reset: store.resetSessionWaveform,
    setFrameCursor: store.setSessionWaveformFrameCursor,
    commitFrameIngest: store.commitSessionWaveformFrameIngest,
  };
}

export function useWorkspaceSessionPort(): WorkspaceSessionPort {
  return resolveSessionFacade();
}
