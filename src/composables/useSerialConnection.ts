import { onScopeDispose, ref, shallowRef } from 'vue';
import { useSessionCapture } from '../features/sessions/session-ports';
import { useSessionFrames } from './useSessionFrames';
import { useAutoLog } from './useAutoLog';
import {
  createSerialConnectionController,
  type SerialConnectionOptions,
} from '../features/serial/application/serial-connection-controller';
import type { PortLeaseClient } from '../features/serial/application/port-lease-registry';
import type { SerialConnectionFailure } from '../features/serial/application/serial-connection-failure';
import type { SerialTimerScheduler } from '../lib/serial-rx-scheduler';
import {
  createTauriSerialPort,
  type SerialPortAdapter,
  type SerialPortFactory,
} from '../features/serial';
import { formatBytes } from '../lib/format';
import { t } from '../lib/i18n';
import type { PortConfig, SerialWriteOptions } from '../types';

export { buildSendPayload } from '../features/serial/application/serial-connection-controller';
export type {
  SendPayloadResult,
  SerialConnectionOptions,
} from '../features/serial/application/serial-connection-controller';
export {
  classifyOpenFailure,
  serialConnectionFailureMessage,
  type SerialConnectionFailure,
} from './serial/connection-errors';
export type { SerialStopResult } from './serial/shutdown-evidence';

/** Compatibility dependencies for the Vue bridge. Native details stop here. */
export interface SerialConnectionDependencies {
  leaseClient: PortLeaseClient;
  sessionName: string | (() => string);
  createPort?: SerialPortFactory;
  timerScheduler?: SerialTimerScheduler;
  isDocumentVisible?: () => boolean;
  writeCloseGraceMs?: number;
}

/**
 * Vue projection for the framework-free SerialConnectionController. It owns
 * only refs, localization, the visibility listener, and scope cleanup.
 */
export function useSerialConnection(
  sessionId: string,
  portName: string | (() => string),
  config: PortConfig | (() => PortConfig),
  options: SerialConnectionOptions | undefined,
  dependencies: SerialConnectionDependencies,
) {
  const capture = useSessionCapture(sessionId);
  const { addFrame, publishFrames } = useSessionFrames(sessionId);
  const { appendFrame } = useAutoLog();
  const controller = createSerialConnectionController(sessionId, portName, config, options, {
    leaseClient: dependencies.leaseClient,
    sessionName: dependencies.sessionName,
    createPort: dependencies.createPort ?? createTauriSerialPort,
    timerScheduler: dependencies.timerScheduler,
    visibilityPort: {
      isVisible:
        dependencies.isDocumentVisible ??
        (() => typeof document === 'undefined' || document.visibilityState !== 'hidden'),
    },
    writeCloseGraceMs: dependencies.writeCloseGraceMs,
    sink: {
      setConnected: (_id, connected) => capture.projectConnected(connected),
      updateDroppedBytes: (_id, total) => capture.updateDroppedBytes(total),
      addFrame: (_id, frame, frameOptions) => addFrame(frame, frameOptions),
      publishFrames: () => publishFrames(),
      appendAutoLogFrame: (id, frame) => appendFrame(id, frame),
    },
  });

  const initial = controller.snapshot();
  const port = shallowRef<SerialPortAdapter | null>(initial.port);
  const isConnecting = ref(initial.isConnecting);
  const isConnected = ref(initial.isConnected);
  const isClosing = ref(initial.isClosing);
  const reconnecting = ref(initial.reconnecting);
  const error = ref<string | null>(localizedError(initial.error, initial.totalDroppedBytes));
  const connectionFailure = shallowRef<SerialConnectionFailure | null>(initial.connectionFailure);
  const totalDroppedBytes = ref(initial.totalDroppedBytes);

  const unsubscribe = controller.subscribe((snapshot) => {
    port.value = snapshot.port;
    isConnecting.value = snapshot.isConnecting;
    isConnected.value = snapshot.isConnected;
    isClosing.value = snapshot.isClosing;
    reconnecting.value = snapshot.reconnecting;
    error.value = localizedError(snapshot.error, snapshot.totalDroppedBytes);
    connectionFailure.value = snapshot.connectionFailure;
    totalDroppedBytes.value = snapshot.totalDroppedBytes;
  });

  const onVisibilityChange = () => controller.visibilityChanged();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  onScopeDispose(() => {
    unsubscribe();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    void controller.dispose();
  });

  return {
    port,
    isConnecting,
    isConnected,
    isClosing,
    reconnecting,
    error,
    connectionFailure,
    totalDroppedBytes,
    start: () => controller.start(),
    send: (data: string, isHex: boolean, writeOptions?: SerialWriteOptions) =>
      controller.send(data, isHex, writeOptions),
    sendBytes: (payload: Uint8Array, writeOptions?: SerialWriteOptions) =>
      controller.sendBytes(payload, writeOptions),
    sendBreak: (durationMs?: number) => controller.sendBreak(durationMs),
    rawBytes: (callback: (bytes: Uint8Array) => void) => controller.rawBytes(callback),
    serialTransactions: controller.serialTransactions,
    stop: () => controller.stop(),
  };
}

function localizedError(value: string | null, droppedBytes: number): string | null {
  return value === 'SERIAL_RX_OVERFLOW'
    ? t('serial.error.rxOverflow', { bytes: formatBytes(droppedBytes) })
    : value;
}
