import { storeToRefs } from 'pinia';
import { computed, type ComputedRef, type DeepReadonly, type Ref } from 'vue';
import type { DataFrame, PortConfig, SerialSession, SessionWaveformState } from '../../types';
import {
  findCaptureFrameBySeq,
  sessionCaptureTimeline,
  type SessionCaptureTimeline,
} from '../../lib/capture-stream';
import type { WorkspacePortHint, WorkspaceSessionKind } from '../../generated/ipc-contracts';
import { useSessionCoreStore } from '../../stores/session-core';
import type {
  CompleteWorkspaceRebindResult,
  DeletedSessionSnapshot,
  UndoDeletedSessionResult,
  WorkspaceSessionChangeEvent,
  WorkspaceSessionChangeListener,
  WorkspaceSessionMutationPermissions,
  SessionCreationOptions,
} from '../../stores/session-core';

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
    ...args: Parameters<ReturnType<typeof useSessionCoreStore>['replaceWorkspaceSessions']>
  ): ReturnType<ReturnType<typeof useSessionCoreStore>['replaceWorkspaceSessions']>;
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

function sessionCore() {
  return useSessionCoreStore();
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
  remove(sessionId: string): ReturnType<ReturnType<typeof useSessionCoreStore>['removeSession']>;
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
    ReturnType<typeof useSessionCoreStore>,
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
  appendSamples: ReturnType<typeof useSessionCoreStore>['appendSessionWaveformSamples'];
  replaceSamples: ReturnType<typeof useSessionCoreStore>['replaceSessionWaveformSamples'];
  setChannelVisible: ReturnType<typeof useSessionCoreStore>['setSessionWaveformChannelVisible'];
  clear: () => void;
  reset: ReturnType<typeof useSessionCoreStore>['resetSessionWaveform'];
  setFrameCursor: ReturnType<typeof useSessionCoreStore>['setSessionWaveformFrameCursor'];
  commitFrameIngest: ReturnType<typeof useSessionCoreStore>['commitSessionWaveformFrameIngest'];
}

export function useSessionMutationPolicy(): SessionMutationPolicyPort {
  const core = sessionCore();
  const refs = storeToRefs(core);
  return {
    userMutationsAllowed: refs.userMutationsAllowed,
    runtimeCaptureAllowed: refs.runtimeCaptureAllowed,
    persistenceReadOnly: refs.persistenceReadOnly,
    setWorkspaceMutationPermissions: core.setWorkspaceMutationPermissions,
    registerCleanup: core.registerCleanup,
  };
}

export function useSessionCatalog(): SessionCatalogPort {
  const core = sessionCore();
  const refs = storeToRefs(core);
  return {
    sessions: refs.sessions,
    activeSessionId: refs.activeSessionId,
    activeSession: refs.activeSession,
    lastDeletedSession: refs.lastDeletedSession,
    workspaceRebindBySessionId: refs.workspaceRebindBySessionId,
    create: core.createSession,
    remove: core.removeSession,
    undo: core.undoLastRemovedSession,
    activate: core.setActiveSession,
    reorder: core.reorderSessions,
    framesVersion: core.getSessionFramesVersion,
    completeRebind: core.completeWorkspaceRebind,
  };
}

export function useSessionCapture(sessionId: string): SessionCapturePort {
  const core = sessionCore();
  const refs = storeToRefs(core);
  const session = computed(() => refs.sessions.value.find((item) => item.id === sessionId) ?? null);
  const timeline = computed(() => (session.value ? sessionCaptureTimeline(session.value) : null));
  return {
    session,
    framesVersion: computed(() => core.getSessionFramesVersion(sessionId)),
    timeline,
    add: (frame, options) => core.addFrame(sessionId, frame, options),
    frameAt: (captureSeq) => {
      const view = timeline.value;
      return view ? findCaptureFrameBySeq(view, captureSeq) : undefined;
    },
    publish: () => core.publishSessionFrames(sessionId),
    clear: () => core.clearFrames(sessionId),
    setPaused: (paused) => core.setCapturePaused(sessionId, paused),
    updateDroppedBytes: (total) => core.updateDroppedBytes(sessionId, total),
    projectConnected: (connected) => core.setConnected(sessionId, connected),
    onCleared: (listener) => core.onFramesCleared(sessionId, listener),
  };
}

export function useSessionDocument(sessionId: string): SessionDocumentPort {
  const core = sessionCore();
  const refs = storeToRefs(core);
  return {
    session: computed(() => refs.sessions.value.find((item) => item.id === sessionId) ?? null),
    isDirty: computed(() => core.isSessionConfigurationDirty(sessionId)),
    addSendHistory: core.addSendHistory,
    clearSendHistory: core.clearSendHistory,
    setSendDraft: core.setSendDraft,
    addQuickCommand: core.addQuickCommand,
    removeQuickCommand: core.removeQuickCommand,
    addMacro: core.addMacro,
    updateMacro: core.updateMacro,
    removeMacro: core.removeMacro,
    addTrigger: core.addTrigger,
    updateTrigger: core.updateTrigger,
    removeTrigger: core.removeTrigger,
    addHighlight: core.addHighlight,
    updateHighlight: core.updateHighlight,
    removeHighlight: core.removeHighlight,
    addModbusRegister: core.addModbusRegister,
    updateModbusRegister: core.updateModbusRegister,
    removeModbusRegister: core.removeModbusRegister,
    setModbusRegisters: core.setModbusRegisters,
    setModbusRegisterValues: core.setModbusRegisterValues,
    addLogAiMessage: core.addLogAiMessage,
    clearLogAiMessages: core.clearLogAiMessages,
    setParserState: core.setParserState,
    setModbusConfig: core.setModbusConfig,
    setShellConfig: core.setShellConfig,
    setMcumgrConfig: core.setMcumgrConfig,
    setWaveformSourceMode: core.setWaveformSourceMode,
    setAutoLogTarget: core.setAutoLogTarget,
    setTerminalAiModel: core.setTerminalAiModel,
    setLogAiModel: core.setLogAiModel,
    setLogAiContextMode: core.setLogAiContextMode,
    setLogAiFrameLimit: core.setLogAiFrameLimit,
  };
}

export function useSessionWaveform(sessionId: string): SessionWaveformPort {
  const core = sessionCore();
  const refs = storeToRefs(core);
  return {
    state: computed(() => refs.workspaceWaveformBySessionId.value[sessionId] ?? null),
    appendSamples: core.appendSessionWaveformSamples,
    replaceSamples: core.replaceSessionWaveformSamples,
    setChannelVisible: core.setSessionWaveformChannelVisible,
    clear: () => core.clearSessionWaveform(sessionId),
    reset: core.resetSessionWaveform,
    setFrameCursor: core.setSessionWaveformFrameCursor,
    commitFrameIngest: core.commitSessionWaveformFrameIngest,
  };
}

export function useWorkspaceSessionPort(): WorkspaceSessionPort {
  return sessionCore();
}
