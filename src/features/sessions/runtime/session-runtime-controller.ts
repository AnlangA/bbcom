import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue';
import { useMessage } from 'naive-ui';
import { useAppStore } from '../../../stores/app';
import { useSessionStore } from '../../../stores/sessions';
import { useSerialConnection } from '../../../composables/useSerialConnection';
import { useSessionModbus } from '../../../composables/useSessionModbus';
import { useTriggers } from '../../../composables/useTriggers';
import { useAutoLog } from '../../../composables/useAutoLog';
import { AsyncSendLoop } from '../../serial/application/async-send-loop';
import { formatBytes } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { logger } from '../../../lib/logger';
import { SerialUiPublishScheduler } from '../../../lib/serial-rx-scheduler';
import type { DisplayParsedFrame } from '../../../lib/parser-frame-collector';
import type {
  DataFrame,
  SerialSendResult,
  SerialSession,
  SerialWriteOptions,
} from '../../../types';
import { SessionProtocolRuntime } from './session-protocol-runtime';

let nextRuntimeInstanceId = 0;

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
  readonly throughputBps: Readonly<Ref<number>>;
  /** Increments on a parser configuration change or explicit terminal clear. */
  readonly resetVersion: Readonly<Ref<number>>;
}

export type SessionRuntimeModbusController = ReturnType<typeof useSessionModbus>;
export type SessionRuntimeViewMode = 'terminal' | 'waveform' | 'parser' | 'modbus';

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
  readonly reconnecting: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<string | null>>;
  readonly totalDroppedBytes: Readonly<Ref<number>>;
  readonly sendingBreak: Readonly<Ref<boolean>>;
  readonly looping: Readonly<Ref<boolean>>;
  readonly viewMode: Ref<SessionRuntimeViewMode>;
  readonly parser: SessionRuntimeProtocolView;
  readonly modbus: SessionRuntimeModbusController;
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
  dispose: () => Promise<void>;
}

export function useSessionRuntimeController(
  session: Readonly<Ref<SerialSession>>,
): SessionRuntimeController {
  const instanceId = `${session.value.id}:${++nextRuntimeInstanceId}`;
  const sessionStore = useSessionStore();
  const appStore = useAppStore();
  const message = useMessage();
  const autoLog = useAutoLog();

  const triggersRef = computed(() => session.value.triggers);
  const { feedBytes: feedTriggerBytes } = useTriggers({
    triggers: triggersRef,
    send: (data, isHex) => send(data, isHex),
    onFire: (fire) => {
      const trigger = session.value.triggers.find((item) => item.id === fire.triggerId);
      message.info(t('message.triggerFired', { name: trigger?.name ?? fire.triggerId }));
    },
  });

  const serial = useSerialConnection(
    session.value.id,
    session.value.portName,
    session.value.portConfig,
    {
      onDisconnect: () => {
        message.warning(t('serial.error.disconnected'));
      },
      onOverflow: (total) => {
        message.warning(t('serial.error.rxOverflow', { bytes: formatBytes(total) }));
        sessionStore.updateDroppedBytes(session.value.id, total);
      },
      autoReconnect: () => appStore.autoReconnect,
      onReconnecting: () => {
        message.info(t('serial.error.reconnecting'));
      },
      onReconnected: () => {
        message.success(t('serial.error.reconnected'));
      },
    },
  );

  // Protocol parsing is deliberately attached to the native raw-byte stream,
  // before the queued terminal capture/UI publication path. This runtime stays
  // resident while the ParserPanel is unmounted and while RAF never runs.
  const protocolRuntime = new SessionProtocolRuntime();
  const parserFrames = shallowRef<readonly DisplayParsedFrame[]>([]);
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
  const removeParserFrameClearObserver = sessionStore.onFramesCleared(session.value.id, () => {
    protocolRuntime.clear();
    parserUiPublisher.cancel();
    publishParserSnapshot();
  });
  const removeParserRawObserver = serial.rawBytes((bytes) => {
    if (protocolRuntime.feed(bytes)) parserUiPublisher.markDirty();
  });
  const parser: SessionRuntimeProtocolView = {
    frames: readonly(parserFrames),
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
  const modbus = useSessionModbus({
    session: computed(() => session.value),
    sendBytes: (payload, writeOptions) => serial.sendBytes(payload, writeOptions),
    rawBytes: (callback) => serial.rawBytes(callback),
    isConnected: serial.isConnected,
    waveformRef,
    showWaveform: () => {
      viewMode.value = 'waveform';
    },
  });

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
    () => message.error(t('send.error.failed')),
  );

  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  async function connect(): Promise<boolean> {
    if (disposed) return false;
    const ok = await serial.start();
    if (!ok && serial.error.value) {
      message.error(t('serial.error.connectFailed', { error: serial.error.value }));
    }
    return ok;
  }

  async function disconnect(): Promise<void> {
    stopSendLoop();
    await serial.stop();
  }

  async function send(data: string, isHex: boolean): Promise<boolean> {
    if (disposed) return false;
    const result = await serial.send(data, isHex);
    if (result.ok) sessionStore.addSendHistory(session.value.id, { data, isHex });
    return result.ok;
  }

  async function sendBreak(): Promise<boolean> {
    if (sendingBreak.value || disposed) return false;
    sendingBreak.value = true;
    try {
      const ok = await serial.sendBreak();
      if (ok) message.success(t('message.breakSent'));
      else message.warning(t('message.breakFailed'));
      return ok;
    } finally {
      sendingBreak.value = false;
    }
  }

  function startSendLoop(data: string, isHex: boolean): boolean {
    if (disposed || !serial.isConnected.value || looping.value || data.length === 0) return false;
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
      await autoLog.disable(session.value.id);
      message.info(t('message.autoLogStopped'));
      return;
    }
    const path = await autoLog.enable(session.value.id);
    if (path) message.success(t('message.autoLogStarted', { path }));
  }

  function attachView(binding: SessionRuntimeViewBinding): () => void {
    viewBinding.value = binding;
    return () => {
      if (viewBinding.value === binding) viewBinding.value = null;
    };
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      stopSendLoop();
      viewBinding.value = null;
      removeParserRawObserver();
      removeParserFrameClearObserver();
      stopParserConfigWatch();
      parserUiPublisher.cancel();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onParserVisibilityChange);
      }
      removeTriggerRawObserver();
      modbus.master.stop();
      // Always invalidate the per-session generation, even when the save
      // dialog is still pending and no active grant has reached the store yet.
      await autoLog.disable(session.value.id);
      await serial.stop();
    })();
    return disposePromise;
  }

  watch(serial.isConnected, (connected) => {
    if (!connected) stopSendLoop();
  });

  onScopeDispose(() => {
    void dispose();
  });

  return {
    sessionId: session.value.id,
    instanceId,
    isConnecting: readonly(serial.isConnecting),
    isConnected: readonly(serial.isConnected),
    reconnecting: readonly(serial.reconnecting),
    error: readonly(serial.error),
    totalDroppedBytes: readonly(serial.totalDroppedBytes),
    sendingBreak: readonly(sendingBreak),
    looping: readonly(looping),
    viewMode,
    parser,
    modbus,
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
    dispose,
  };
}
