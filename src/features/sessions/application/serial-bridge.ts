import { onScopeDispose, ref, shallowRef, type Ref } from 'vue';
import {
  useSessionCapture,
  type SessionCapturePort,
} from '@/features/sessions/ports/session-ports';
import { useAutoLog } from './use-auto-log';
import type { DataFrame } from '@/types';
import {
  createSerialConnectionController,
  type SerialConnectionOptions,
} from '@/features/serial/application/serial-connection-controller';
import type { PortLeaseClient } from '@/features/serial/application/port-lease-registry';
import type { SerialConnectionFailure } from '@/features/serial/application/serial-connection-failure';
import type { SerialTimerScheduler } from '@/lib/serial-rx-scheduler';
import {
  createTauriSerialPort,
  type SerialPortAdapter,
  type SerialPortFactory,
} from '@/features/serial';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { PortConfig, SerialWriteOptions } from '@/types';

export { buildSendPayload } from '@/features/serial/application/serial-connection-controller';
export type {
  SendPayloadResult,
  SerialConnectionOptions,
} from '@/features/serial/application/serial-connection-controller';
export {
  classifyOpenFailure,
  type SerialConnectionFailure,
} from '@/features/serial/application/serial-connection-failure';
export { serialConnectionFailureMessage } from '@/features/serial/application/connection-errors';
export type { SerialStopResult } from '@/features/serial/application/shutdown-evidence-composable';

/** Compatibility dependencies for the Vue bridge. Native details stop here. */
export interface SerialConnectionDependencies {
  leaseClient: PortLeaseClient;
  sessionName: string | (() => string);
  createPort?: SerialPortFactory;
  timerScheduler?: SerialTimerScheduler;
  isDocumentVisible?: () => boolean;
  writeCloseGraceMs?: number;
}

export interface SerialBridgeCreateOptions {
  sessionId: string;
  portName: string | (() => string);
  config: PortConfig | (() => PortConfig);
  options: SerialConnectionOptions | undefined;
  dependencies: SerialConnectionDependencies;
  /** Capture storage injected by the owning session transceiver. */
  capture?: SessionCapturePort;
  appendAutoLogFrame: (sessionId: string, frame: DataFrame) => void;
}

/**
 * Headless serial connection bridge. Owns the framework-free controller and
 * exposes reactive state for Vue consumers or the session runtime controller.
 */
export class SerialBridge {
  readonly port: Ref<SerialPortAdapter | null>;
  readonly isConnecting: Ref<boolean>;
  readonly isConnected: Ref<boolean>;
  readonly isClosing: Ref<boolean>;
  readonly reconnecting: Ref<boolean>;
  readonly error: Ref<string | null>;
  readonly connectionFailure: Ref<SerialConnectionFailure | null>;
  readonly totalDroppedBytes: Ref<number>;

  private readonly controller: ReturnType<typeof createSerialConnectionController>;
  private readonly unsubscribe: () => void;
  private readonly onVisibilityChange: () => void;
  private disposed = false;

  constructor(options: SerialBridgeCreateOptions) {
    const capture = options.capture ?? useSessionCapture(options.sessionId);

    this.controller = createSerialConnectionController(
      options.sessionId,
      options.portName,
      options.config,
      options.options,
      {
        leaseClient: options.dependencies.leaseClient,
        sessionName: options.dependencies.sessionName,
        createPort: options.dependencies.createPort ?? createTauriSerialPort,
        timerScheduler: options.dependencies.timerScheduler,
        visibilityPort: {
          isVisible:
            options.dependencies.isDocumentVisible ??
            (() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
        },
        writeCloseGraceMs: options.dependencies.writeCloseGraceMs,
        sink: {
          setConnected: (_id, connected) => capture.projectConnected(connected),
          updateDroppedBytes: (_id, total) => capture.updateDroppedBytes(total),
          addFrame: (_id, frame, frameOptions) => capture.add(frame, frameOptions),
          publishFrames: () => capture.publish(),
          appendAutoLogFrame: (id, frame) => options.appendAutoLogFrame(id, frame),
        },
      },
    );

    const initial = this.controller.snapshot();
    this.port = shallowRef<SerialPortAdapter | null>(initial.port);
    this.isConnecting = ref(initial.isConnecting);
    this.isConnected = ref(initial.isConnected);
    this.isClosing = ref(initial.isClosing);
    this.reconnecting = ref(initial.reconnecting);
    this.error = ref(localizedError(initial.error, initial.totalDroppedBytes));
    this.connectionFailure = shallowRef<SerialConnectionFailure | null>(initial.connectionFailure);
    this.totalDroppedBytes = ref(initial.totalDroppedBytes);

    this.unsubscribe = this.controller.subscribe((snapshot) => {
      this.port.value = snapshot.port;
      this.isConnecting.value = snapshot.isConnecting;
      this.isConnected.value = snapshot.isConnected;
      this.isClosing.value = snapshot.isClosing;
      this.reconnecting.value = snapshot.reconnecting;
      this.error.value = localizedError(snapshot.error, snapshot.totalDroppedBytes);
      this.connectionFailure.value = snapshot.connectionFailure;
      this.totalDroppedBytes.value = snapshot.totalDroppedBytes;
    });

    this.onVisibilityChange = () => this.controller.visibilityChanged();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  start(): Promise<boolean> {
    return this.controller.start();
  }

  send(
    data: string,
    isHex: boolean,
    writeOptions?: SerialWriteOptions,
  ): ReturnType<ReturnType<typeof createSerialConnectionController>['send']> {
    return this.controller.send(data, isHex, writeOptions);
  }

  sendBytes(
    payload: Uint8Array,
    writeOptions?: SerialWriteOptions,
  ): ReturnType<ReturnType<typeof createSerialConnectionController>['sendBytes']> {
    return this.controller.sendBytes(payload, writeOptions);
  }

  sendBreak(durationMs?: number): Promise<boolean> {
    return this.controller.sendBreak(durationMs);
  }

  rawBytes(callback: (bytes: Uint8Array) => void): () => void {
    return this.controller.rawBytes(callback);
  }

  get serialTransactions(): ReturnType<
    typeof createSerialConnectionController
  >['serialTransactions'] {
    return this.controller.serialTransactions;
  }

  stop(): ReturnType<ReturnType<typeof createSerialConnectionController>['stop']> {
    return this.controller.stop();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    await this.controller.dispose();
  }
}

export function createSerialBridge(options: SerialBridgeCreateOptions): SerialBridge {
  return new SerialBridge(options);
}

/**
 * Vue projection for SerialBridge. It owns only scope cleanup and delegates
 * all connection logic to the headless bridge class.
 */
export function useSerialConnection(
  sessionId: string,
  portName: string | (() => string),
  config: PortConfig | (() => PortConfig),
  options: SerialConnectionOptions | undefined,
  dependencies: SerialConnectionDependencies,
) {
  const { appendFrame } = useAutoLog();
  const bridge = createSerialBridge({
    sessionId,
    portName,
    config,
    options,
    dependencies,
    appendAutoLogFrame: appendFrame,
  });

  onScopeDispose(() => {
    void bridge.dispose();
  });

  return {
    port: bridge.port,
    isConnecting: bridge.isConnecting,
    isConnected: bridge.isConnected,
    isClosing: bridge.isClosing,
    reconnecting: bridge.reconnecting,
    error: bridge.error,
    connectionFailure: bridge.connectionFailure,
    totalDroppedBytes: bridge.totalDroppedBytes,
    start: () => bridge.start(),
    send: (data: string, isHex: boolean, writeOptions?: SerialWriteOptions) =>
      bridge.send(data, isHex, writeOptions),
    sendBytes: (payload: Uint8Array, writeOptions?: SerialWriteOptions) =>
      bridge.sendBytes(payload, writeOptions),
    sendBreak: (durationMs?: number) => bridge.sendBreak(durationMs),
    rawBytes: (callback: (bytes: Uint8Array) => void) => bridge.rawBytes(callback),
    serialTransactions: bridge.serialTransactions,
    stop: () => bridge.stop(),
  };
}

function localizedError(value: string | null, droppedBytes: number): string | null {
  return value === 'SERIAL_RX_OVERFLOW'
    ? t('serial.error.rxOverflow', { bytes: formatBytes(droppedBytes) })
    : value;
}
