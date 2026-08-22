import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import { useAppStore } from '@/features/settings/store/app-store';
import { useSessionCapture, useSessionDocument } from '@/features/sessions/ports/session-ports';
import {
  createSerialBridge,
  serialConnectionFailureMessage,
  type SerialStopResult,
} from '@/features/sessions/application/serial-bridge';
import {
  createModbusBridge,
  type ModbusBridge,
} from '@/features/sessions/application/modbus-bridge';
import {
  createMcumgrBridge,
  type McumgrBridge,
} from '@/features/sessions/application/mcumgr-bridge';
import {
  createAutomationBridge,
} from '@/features/sessions/application/automation-bridge';
import { mcumgrTraceFramesToDataFrames } from '@/lib/mcumgr-trace';
import {
  AsyncSendLoop,
  type PortLeaseClient,
  type SerialTransactionLeaseCoordinator,
} from '../../serial';
import type { ApplicationNotificationPort } from '@/features/platform/application';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';
import { logger } from '@/lib/logger';
import { SerialUiPublishScheduler } from '@/lib/serial-rx-scheduler';
import type { DisplayParsedFrame } from '@/lib/parser-frame-collector';
import type {
  DataFrame,
  SerialSendResult,
  SerialSession,
  SerialWriteOptions,
} from '@/types';
import type { SerialConnectionFailure } from '@/features/sessions/application/serial-bridge';
import { SessionProtocolRuntime } from './session-protocol-runtime';
import { SessionRuntimeStatusRegistry } from './session-runtime-status';
import type { SessionRuntimeUiState } from './session-ui-state';
import { createSessionShellController, type SessionShellController } from '../../serial-shell';

let nextRuntimeInstanceId = 0;

function assertSerialStopEvidence(result: SerialStopResult): void {
  const stoppedWithoutConnection =
    result.watch === 'not-installed' && result.rxDrainStatus === 'no-active-connection';
  const drainedActiveConnection =
    result.watch === 'unwatch-acknowledged' && result.rxDrainStatus === 'idle-gap-observed';
  const physicalCloseProven =
    result.pendingOpen !== 'unsettled' &&
    (result.portClose === 'no-active-port' ||
      result.portClose === 'close-acknowledged' ||
      result.portClose === 'force-close-acknowledged');
  if (
    result.rxDrainGuarantee !== 'guaranteed' ||
    (!stoppedWithoutConnection && !drainedActiveConnection) ||
    !physicalCloseProven
  ) {
    throw new Error(
      `serial stop did not prove shutdown: watch=${result.watch}, status=${result.rxDrainStatus}, guarantee=${result.rxDrainGuarantee}, pendingOpen=${result.pendingOpen}, portClose=${result.portClose}`,
    );
  }
}

export interface SessionRuntimeWaveformSink {
  pushRegisterSample: (channel: number, value: number, timestamp?: number) => void;
  pushRegisterSamples: (
    samples: readonly { channel: number; value: number; timestamp?: number }[],
  ) => void;
}

export interface SessionRuntimeViewBinding {
  waveformRef: Readonly<Ref<SessionRuntimeWaveformSink | null>>;
}

/** UI-facing, throttled snapshot of the resident raw-byte protocol parser. */
export interface SessionRuntimeProtocolView {
  readonly frames: Readonly<Ref<readonly DisplayParsedFrame[]>>;
  readonly droppedFrames: Readonly<Ref<number>>;
  readonly droppedBytes: Readonly<Ref<number>>;
  readonly throughputBps: Readonly<Ref<number>>;
  /** Increments on a parser configuration change or explicit terminal clear. */
  readonly resetVersion: Readonly<Ref<number>>;
}

export type SessionRuntimeModbusController = ModbusBridge;
export type SessionRuntimeMcumgrController = McumgrBridge;
export interface SessionRuntimeShellController {
  replay: SessionShellController['replay'];
  onOutput: SessionShellController['onOutput'];
  onReset: SessionShellController['onReset'];
  handleTerminalData: SessionShellController['handleTerminalData'];
  clear: SessionShellController['clear'];
}
export type SessionRuntimeMacroController = {
  readonly running: Readonly<Ref<boolean>>;
  readonly status: Readonly<Ref<'idle' | 'running'>>;
  run: (
    definition: import('@/types').Macro,
  ) => Promise<import('@/features/sessions/application/automation-bridge').MacroRunResult>;
  abort: () => void;
  pause: (signal?: AbortSignal) => Promise<void>;
  resume: () => void;
};
export type SessionRuntimeViewMode =
  'terminal' | 'waveform' | 'parser' | 'modbus' | 'shell' | 'mcumgr';
export interface SessionRuntimeBridgeFactory {
  createSerialBridge: typeof createSerialBridge;
  createModbusBridge: typeof createModbusBridge;
  createMcumgrBridge: typeof createMcumgrBridge;
  createAutomationBridge: typeof createAutomationBridge;
}

const defaultBridgeFactory: SessionRuntimeBridgeFactory = {
  createSerialBridge,
  createModbusBridge,
  createMcumgrBridge,
  createAutomationBridge,
};

export interface SessionRuntimeControllerDependencies {
  readonly notifications: ApplicationNotificationPort;
  readonly portLeaseClient: PortLeaseClient;
  readonly runtimeStatusRegistry?: SessionRuntimeStatusRegistry;
  readonly bridgeFactory?: SessionRuntimeBridgeFactory;
}

/**
 * Long-lived, headless session runtime shared by whichever UI is currently
 * active. Its lifetime follows session residency rather than SessionView, so
 * switching tabs cannot tear down the serial watch, reconnect state, trigger
 * engine, cyclic sender, or Modbus background loops.
 */
export interface SessionRuntimeController {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly isConnecting: Readonly<Ref<boolean>>;
  readonly isConnected: Readonly<Ref<boolean>>;
  /** UI link state: open handle or MCUmgr port-yield in progress. */
  readonly sessionLinkUp: Readonly<Ref<boolean>>;
  readonly reconnecting: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<string | null>>;
  readonly connectionFailure: Readonly<Ref<SerialConnectionFailure | null>>;
  readonly totalDroppedBytes: Readonly<Ref<number>>;
  readonly sendingBreak: Readonly<Ref<boolean>>;
  readonly looping: Readonly<Ref<boolean>>;
  readonly viewMode: Ref<SessionRuntimeViewMode>;
  /** View-local UI state retained across SessionView remounts. */
  readonly uiState: SessionRuntimeUiState;
  readonly parser: SessionRuntimeProtocolView;
  readonly modbus: SessionRuntimeModbusController;
  readonly mcumgr: SessionRuntimeMcumgrController;
  readonly shell: SessionRuntimeShellController;
  readonly macro: SessionRuntimeMacroController;
  readonly serialTransactions: SerialTransactionLeaseCoordinator<SerialSendResult>;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  send: (data: string, isHex: boolean) => Promise<boolean>;
  sendBytes: (payload: Uint8Array, options?: SerialWriteOptions) => Promise<SerialSendResult>;
  rawBytes: (callback: (bytes: Uint8Array) => void) => () => void;
  sendBreak: () => Promise<boolean>;
  startSendLoop: (data: string, isHex: boolean) => boolean;
  stopSendLoop: () => void;
  toggleAutoLog: () => Promise<void>;
  attachView: (binding: SessionRuntimeViewBinding) => () => void;
  /** Stop active work and persist final runtime output without disposing observers. */
  prepareShutdown: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function useSessionRuntimeController(
  session: Readonly<Ref<SerialSession>>,
  dependencies: SessionRuntimeControllerDependencies,
): SessionRuntimeController {
  const instanceId = `${session.value.id}:${++nextRuntimeInstanceId}`;
  const capture = useSessionCapture(session.value.id);
  const sessionDocument = useSessionDocument(session.value.id);
  const appStore = useAppStore();
  const notifications = dependencies.notifications;
  const bridgeFactory = dependencies.bridgeFactory ?? defaultBridgeFactory;
  const runtimeStatusRegistry =
    dependencies.runtimeStatusRegistry ?? new SessionRuntimeStatusRegistry();

  let sendImpl: (data: string, isHex: boolean) => Promise<boolean> = async () => false;

  const automation = bridgeFactory.createAutomationBridge({
    triggers: {
      triggers: computed(() => session.value.triggers),
      send: (data, isHex) => sendImpl(data, isHex),
      onFire: (fire) => {
        const trigger = session.value.triggers.find((item) => item.id === fire.triggerId);
        notifications.info(t('message.triggerFired', { name: trigger?.name ?? fire.triggerId }));
      },
    },
    macro: {
      send: (data, isHex) => sendImpl(data, isHex),
    },
  });
  const feedTriggerBytes = automation.triggers.feedBytes.bind(automation.triggers);

  const serial = bridgeFactory.createSerialBridge({
    sessionId: session.value.id,
    portName: () => session.value.portName,
    config: () => session.value.portConfig,
    options: {
      onDisconnect: () => {
        notifications.warning(t('serial.error.disconnected'));
      },
      onOverflow: (total) => {
        notifications.warning(t('serial.error.rxOverflow', { bytes: formatBytes(total) }));
        capture.updateDroppedBytes(total);
      },
      autoReconnect: () => appStore.autoReconnect,
      onReconnecting: () => {
        notifications.info(t('serial.error.reconnecting'));
      },
      onReconnected: () => {
        notifications.success(t('serial.error.reconnected'));
      },
    },
    dependencies: {
      leaseClient: dependencies.portLeaseClient,
      sessionName: () => session.value.portName,
    },
    appendAutoLogFrame: (id, frame) => automation.autoLog.appendFrame(id, frame),
  });
  const connectionErrorText = computed(() =>
    serial.connectionFailure.value
      ? serialConnectionFailureMessage(serial.connectionFailure.value)
      : serial.error.value,
  );
  const serialClosing = serial.isClosing ?? ref(false);
  const stopRuntimeStatusProjection = watch(
    [
      serial.isConnecting,
      serial.isConnected,
      serialClosing,
      serial.reconnecting,
      serial.connectionFailure,
      serial.error,
      serial.totalDroppedBytes,
    ],
    ([isConnecting, isConnected, isClosing, reconnecting, failure, error, droppedBytes]) => {
      const phase = isClosing
        ? 'closing'
        : reconnecting
          ? 'reconnecting'
          : isConnecting
            ? 'connecting'
            : isConnected
              ? 'connected'
              : failure || error
                ? 'failed'
                : 'stopped';
      runtimeStatusRegistry.publish(session.value.id, {
        phase,
        droppedBytes,
        failure: failure?.error.code ?? error,
      });
    },
    { immediate: true, flush: 'sync' },
  );

  // Protocol parsing is deliberately attached to the native raw-byte stream,
  // before the queued terminal capture/UI publication path. This runtime stays
  // resident while the ParserPanel is unmounted and while RAF never runs.
  const protocolRuntime = new SessionProtocolRuntime();
  const parserFrames = shallowRef<readonly DisplayParsedFrame[]>([]);
  const parserDroppedFrames = ref(0);
  const parserDroppedBytes = ref(0);
  const parserThroughputBps = ref(0);
  const parserResetVersion = ref(0);
  const parserUiPublisher = new SerialUiPublishScheduler(
    publishParserSnapshot,
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const onParserVisibilityChange = () => parserUiPublisher.visibilityChanged();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onParserVisibilityChange);
  }

  function publishParserSnapshot(): void {
    const snapshot = protocolRuntime.snapshot();
    parserFrames.value = snapshot.frames;
    parserDroppedFrames.value = snapshot.droppedFrames;
    parserDroppedBytes.value = snapshot.droppedBytes;
    parserThroughputBps.value = snapshot.throughputBps;
    parserResetVersion.value = snapshot.resetVersion;
  }

  function* capturedParserHistory(): Iterable<Pick<DataFrame, 'direction' | 'data'>> {
    // Reconfiguration deliberately retains the historical parser-panel
    // behavior, including paused capture data. This generator avoids creating
    // a second full frame array; the normal RX path below remains raw-only.
    yield* session.value.frames;
    yield* session.value.pausedFrames;
  }

  const stopParserConfigWatch = watch(
    () => session.value.parserState.config,
    (config) => {
      if (!protocolRuntime.configure(config, capturedParserHistory())) return;
      // Applying a parser setting must immediately clear stale display data;
      // future raw bytes will update this snapshot on the normal UI cadence.
      parserUiPublisher.cancel();
      publishParserSnapshot();
    },
    { immediate: true, flush: 'sync' },
  );
  const removeParserFrameClearObserver = capture.onCleared(() => {
    protocolRuntime.clear();
    parserUiPublisher.cancel();
    publishParserSnapshot();
  });
  const removeParserRawObserver = serial.rawBytes((bytes) => {
    if (protocolRuntime.feed(bytes)) parserUiPublisher.markDirty();
  });
  const parser: SessionRuntimeProtocolView = {
    frames: readonly(parserFrames),
    droppedFrames: readonly(parserDroppedFrames),
    droppedBytes: readonly(parserDroppedBytes),
    throughputBps: readonly(parserThroughputBps),
    resetVersion: readonly(parserResetVersion),
  };

  const removeTriggerRawObserver = serial.rawBytes((bytes) => {
    // Feed the matcher before the UI capture queue.  It has its own streaming
    // decoder and response FIFO, so background rendering cannot delay or
    // reorder trigger recognition.
    void feedTriggerBytes(bytes).catch((triggerError) => {
      logger.warn('serial trigger response failed for', session.value.id, triggerError);
    });
  });

  const viewBinding = shallowRef<SessionRuntimeViewBinding | null>(null);
  const waveformRef = computed(() => viewBinding.value?.waveformRef.value ?? null);
  const viewMode = ref<SessionRuntimeViewMode>('terminal');
  const uiState: SessionRuntimeUiState = {
    // Retained view state: search/filter text, active tools tab, and Modbus
    // drafts survive SessionView destruction exactly like viewMode does.
    packetSearch: ref(''),
    packetDirection: ref<'ALL' | 'TX' | 'RX'>('ALL'),
    toolsTab: ref<'quick' | 'macros' | 'triggers' | 'highlights' | 'history' | 'checksum'>('quick'),
    modbusValueDrafts: ref<Record<string, string>>({}),
    shellSearch: ref(''),
  };
  const shellController = createSessionShellController(() => session.value.shellConfig, {
    sendBytes: (payload, writeOptions) => serial.sendBytes(payload, writeOptions),
    rawBytes: (callback) => serial.rawBytes(callback),
    registerAutomation: (port) => serial.serialTransactions.registerAutomation(port),
    onCleared: (listener) => capture.onCleared(listener),
  });
  const stopShellConfigWatch = watch(
    () => session.value.shellConfig,
    (config) => shellController.configure(config),
  );
  const shell: SessionRuntimeShellController = {
    replay: () => shellController.replay(),
    onOutput: (listener) => shellController.onOutput(listener),
    onReset: (listener) => shellController.onReset(listener),
    handleTerminalData: (data) => shellController.handleTerminalData(data),
    clear: () => shellController.clear(),
  };
  const mcumgr = bridgeFactory.createMcumgrBridge({
    session: computed(() => session.value),
    isConnected: serial.isConnected,
    // Port yield: MCUmgr operations close the frontend connection cleanly,
    // let Rust own the port for the operation, then reconnect afterwards.
    suspendConnection: async () => {
      stopSendLoop();
      await serial.stop();
    },
    resumeConnection: () => serial.start(),
    ingestTraceFrames: (frames) => {
      const mapped = mcumgrTraceFramesToDataFrames(frames);
      for (const frame of mapped) {
        capture.add(frame, { publish: false });
      }
      if (mapped.length > 0) capture.publish();
    },
    setConfig: (patch) => sessionDocument.setMcumgrConfig(session.value.id, patch),
  });
  const modbus = bridgeFactory.createModbusBridge({
    session: computed(() => session.value),
    sendBytes: (payload, writeOptions) => serial.sendBytes(payload, writeOptions),
    rawBytes: (callback) => serial.rawBytes(callback),
    isConnected: serial.isConnected,
    waveformRef,
    showWaveform: () => {
      viewMode.value = 'waveform';
    },
    notifications,
  });

  const macroRunner = automation.macro;
  const macro: SessionRuntimeMacroController = {
    running: readonly(macroRunner.running),
    abort: () => macroRunner.abort(),
    pause: (signal) => macroRunner.pause(signal),
    resume: () => macroRunner.resume(),
    run: (definition) =>
      serial.serialTransactions.snapshot().manualWriteAllowed
        ? macroRunner.run(definition)
        : Promise.resolve({ completed: 0, failedAt: 0, aborted: true }),
    status: readonly(computed(() => (macroRunner.running.value ? 'running' : 'idle'))),
  };

  const sendingBreak = ref(false);
  const looping = ref(false);
  let loopPayload: { data: string; isHex: boolean } | null = null;
  const sendLoop = new AsyncSendLoop(
    async () => {
      if (!loopPayload) return;
      const ok = await send(loopPayload.data, loopPayload.isHex);
      if (!ok) throw new Error('serial send failed');
    },
    () => appStore.loopIntervalMs,
    () => notifications.error(t('send.error.failed')),
  );
  serial.serialTransactions.registerAutomation({
    id: 'cyclic-send',
    async pause() {
      if (!sendLoop.isRunning || !loopPayload) return null;
      const saved = { ...loopPayload };
      stopSendLoop();
      return {
        async restore() {
          if (!disposed) startSendLoop(saved.data, saved.isHex);
        },
      };
    },
  });
  serial.serialTransactions.registerAutomation({
    id: 'macro-runner',
    async pause({ signal }) {
      if (!macroRunner.running.value) return null;
      await macroRunner.pause(signal);
      return { restore: async () => macroRunner.resume() };
    },
  });
  serial.serialTransactions.registerAutomation({
    id: 'modbus-master',
    async pause({ signal }) {
      await modbus.master.pauseForSerialTransaction(signal);
      return { restore: async () => modbus.master.resumeAfterSerialTransaction() };
    },
  });
  serial.serialTransactions.registerAutomation({
    id: 'trigger-responses',
    async pause({ signal }) {
      await automation.triggers.pause(signal);
      return { restore: async () => automation.triggers.resume() };
    },
  });

  let disposed = false;
  let preparePromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;
  let stopConnectionWatch: (() => void) | null = null;

  async function connect(): Promise<boolean> {
    if (disposed) return false;
    // While MCUmgr owns the port the toolbar cannot open a competing handle.
    if (mcumgr.busy.value) return false;
    const ok = await serial.start();
    if (!ok && serial.error.value) {
      notifications.error(
        serial.connectionFailure.value
          ? serialConnectionFailureMessage(serial.connectionFailure.value)
          : t('serial.error.connectFailed', { error: serial.error.value }),
      );
    }
    return ok;
  }

  async function disconnect(): Promise<void> {
    if (mcumgr.busy.value) return;
    stopSendLoop();
    await serial.stop();
  }

  async function send(data: string, isHex: boolean): Promise<boolean> {
    if (disposed) return false;
    const result = await serial.send(data, isHex);
    const completed = result.outcome === 'complete';
    if (completed) sessionDocument.addSendHistory(session.value.id, { data, isHex });
    return completed;
  }
  sendImpl = send;

  async function sendBreak(): Promise<boolean> {
    if (sendingBreak.value || disposed) return false;
    sendingBreak.value = true;
    try {
      const ok = await serial.sendBreak();
      if (ok) notifications.success(t('message.breakSent'));
      else notifications.warning(t('message.breakFailed'));
      return ok;
    } finally {
      sendingBreak.value = false;
    }
  }

  function startSendLoop(data: string, isHex: boolean): boolean {
    if (
      disposed ||
      !serial.isConnected.value ||
      !serial.serialTransactions.snapshot().manualWriteAllowed ||
      looping.value ||
      data.length === 0
    ) {
      return false;
    }
    loopPayload = { data, isHex };
    const started = sendLoop.start();
    looping.value = started;
    if (!started) loopPayload = null;
    return started;
  }

  function stopSendLoop(): void {
    sendLoop.stop();
    loopPayload = null;
    looping.value = false;
  }

  async function toggleAutoLog(): Promise<void> {
    if (session.value.autoLogEnabled) {
      await automation.autoLog.disable(session.value.id);
      notifications.info(t('message.autoLogStopped'));
      return;
    }
    const path = await automation.autoLog.enable(session.value.id);
    if (path) notifications.success(t('message.autoLogStarted', { path }));
  }

  function attachView(binding: SessionRuntimeViewBinding): () => void {
    viewBinding.value = binding;
    return () => {
      if (viewBinding.value === binding) viewBinding.value = null;
    };
  }

  function prepareShutdown(): Promise<void> {
    if (preparePromise) return preparePromise;
    preparePromise = (async () => {
      const failures: unknown[] = [];
      for (const stop of [
        () => stopSendLoop(),
        () => macro.abort(),
        () => modbus.master.stop(),
        () => mcumgr.cancel(),
      ]) {
        try {
          stop();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await shellController.flush();
      } catch (error) {
        failures.push(error);
      }

      // Stop the native stream before closing auto-log. This lets the serial
      // adapter enqueue its final RX bytes before the log footer is committed.
      try {
        assertSerialStopEvidence(await serial.stop());
      } catch (error) {
        failures.push(error);
      }
      try {
        await automation.autoLog.prepareShutdown(session.value.id);
      } catch (error) {
        failures.push(error);
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'session runtime failed to prepare for shutdown');
      }
    })().finally(() => {
      preparePromise = null;
    });
    return preparePromise;
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      try {
        await prepareShutdown();
      } finally {
        await serial.serialTransactions.dispose();
        viewBinding.value = null;
        shellController.dispose();
        stopShellConfigWatch();
        removeParserRawObserver();
        removeParserFrameClearObserver();
        stopParserConfigWatch();
        stopRuntimeStatusProjection();
        runtimeStatusRegistry.stop(session.value.id);
        stopConnectionWatch?.();
        stopConnectionWatch = null;
        parserUiPublisher.cancel();
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onParserVisibilityChange);
        }
        removeTriggerRawObserver();
        automation.dispose();
      }
    })();
    return disposePromise;
  }

  stopConnectionWatch = watch(serial.isConnected, (connected) => {
    if (!connected) {
      stopSendLoop();
      macroRunner.abort();
      automation.triggers.reset();
      automation.triggers.resume();
      modbus.master.resumeAfterSerialTransaction();
    }
  });

  onScopeDispose(() => {
    void dispose();
  });

  const sessionLinkUp = computed(() => serial.isConnected.value || mcumgr.portYielding.value);

  return {
    sessionId: session.value.id,
    instanceId,
    isConnecting: readonly(serial.isConnecting),
    isConnected: readonly(serial.isConnected),
    sessionLinkUp: readonly(sessionLinkUp),
    reconnecting: readonly(serial.reconnecting),
    error: readonly(connectionErrorText),
    connectionFailure: readonly(serial.connectionFailure),
    totalDroppedBytes: readonly(serial.totalDroppedBytes),
    sendingBreak: readonly(sendingBreak),
    looping: readonly(looping),
    viewMode,
    uiState,
    parser,
    modbus,
    mcumgr,
    shell,
    macro,
    serialTransactions: serial.serialTransactions,
    connect,
    disconnect,
    send,
    sendBytes: serial.sendBytes,
    rawBytes: serial.rawBytes,
    sendBreak,
    startSendLoop,
    stopSendLoop,
    toggleAutoLog,
    attachView,
    prepareShutdown,
    dispose,
  };
}
