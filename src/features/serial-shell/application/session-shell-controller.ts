import type { SerialSendResult, SerialWriteOptions } from '../../../types/serial';
import type { SerialShellConfig, SerialShellSnapshot } from '../../../types/serial-shell';
import type { SerialAutomationPausePort } from '../../serial';
import {
  SerialShellEngine,
  cloneSerialShellConfig,
  encodeSerialShellKey,
  encodeSerialShellLine,
  echoTextForSerialShellKey,
  isImmediateSerialShellKey,
  pushShellHistory,
  type SerialShellKey,
} from '../../../lib/serial-shell';
import {
  SerialUiPublishScheduler,
  type SerialTimerScheduler,
} from '../../../lib/serial-rx-scheduler';

export const SERIAL_SHELL_COALESCE_MS = 16;
export const SERIAL_SHELL_COALESCE_BYTES = 64;

export interface SessionShellControllerPorts {
  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult>;
  rawBytes(callback: (bytes: Uint8Array) => void): () => void;
  registerAutomation(port: SerialAutomationPausePort): () => void;
  onCleared(listener: () => void): () => void;
  now?: () => number;
  scheduler?: SerialTimerScheduler;
  isDocumentVisible?: () => boolean;
}

export interface SessionShellController {
  snapshot(): SerialShellSnapshot;
  configure(config: SerialShellConfig): void;
  submitLine(text: string): Promise<SerialSendResult>;
  submitKey(key: SerialShellKey): Promise<SerialSendResult | null>;
  flush(): Promise<SerialSendResult | null>;
  clear(): void;
  dispose(): void;
}

export function createSessionShellController(
  getConfig: () => SerialShellConfig,
  onHistoryChange: (history: string[]) => void,
  ports: SessionShellControllerPorts,
  onSnapshot: (snapshot: SerialShellSnapshot) => void,
): SessionShellController {
  const now = ports.now ?? (() => Date.now());
  const engine = new SerialShellEngine(getConfig());
  const pending: number[] = [];
  let writeChain = Promise.resolve<SerialSendResult | null>(null);
  let paused = false;
  let disposed = false;
  let coalesceHandle: unknown | null = null;
  const scheduler: SerialTimerScheduler = ports.scheduler ?? {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    microtask: (callback) => queueMicrotask(callback),
  };
  const publisher = new SerialUiPublishScheduler(
    () => onSnapshot(engine.snapshot()),
    ports.isDocumentVisible ?? (() => true),
    scheduler,
  );

  function publishIfChanged(changed: boolean): void {
    if (changed) publisher.markDirty();
  }

  function echo(text: string | null): void {
    if (!text || !getConfig().localEcho) return;
    publishIfChanged(engine.feedEcho(text, now()));
  }

  function enqueue(payload: Uint8Array, immediate: boolean): Promise<SerialSendResult | null> {
    if (disposed || payload.length === 0) return Promise.resolve(null);
    for (const byte of payload) pending.push(byte);
    if (immediate || pending.length >= SERIAL_SHELL_COALESCE_BYTES) return flush();
    scheduleCoalesce();
    return Promise.resolve(null);
  }

  function scheduleCoalesce(): void {
    if (coalesceHandle !== null || paused) return;
    coalesceHandle = scheduler.schedule(() => {
      coalesceHandle = null;
      void flush();
    }, SERIAL_SHELL_COALESCE_MS);
  }

  function cancelCoalesce(): void {
    if (coalesceHandle === null) return;
    scheduler.cancel(coalesceHandle);
    coalesceHandle = null;
  }

  function flush(): Promise<SerialSendResult | null> {
    cancelCoalesce();
    if (disposed || paused || pending.length === 0) return writeChain;
    const payload = Uint8Array.from(pending);
    pending.length = 0;
    writeChain = writeChain.then(() => ports.sendBytes(payload));
    return writeChain;
  }

  const stopRaw = ports.rawBytes((bytes) => {
    if (disposed) return;
    publishIfChanged(engine.feedRx(bytes, now()));
  });
  const stopCleared = ports.onCleared(() => {
    engine.clear();
    publisher.cancel();
    onSnapshot(engine.snapshot());
  });
  const stopAutomation = ports.registerAutomation({
    id: 'serial-shell',
    async pause() {
      if (disposed) return null;
      paused = true;
      cancelCoalesce();
      return {
        async restore() {
          paused = false;
          if (!disposed) await flush();
        },
      };
    },
  });

  onSnapshot(engine.snapshot());

  return {
    snapshot: () => engine.snapshot(),
    configure(config) {
      engine.configure(cloneSerialShellConfig(config));
    },
    async submitLine(text) {
      if (disposed) {
        return {
          outcome: 'failed',
          requestedBytes: 0,
          sentBytes: 0,
        };
      }
      await flush();
      const config = getConfig();
      const payload = encodeSerialShellLine(text, config.encoding, config.txNewline);
      echo(text.length > 0 ? `${text}\n` : '\n');
      const nextHistory = pushShellHistory(config.history, text);
      if (
        nextHistory.length !== config.history.length ||
        nextHistory.at(-1) !== config.history.at(-1)
      ) {
        onHistoryChange(nextHistory);
      }
      return ports.sendBytes(payload);
    },
    async submitKey(key) {
      if (disposed) return null;
      const config = getConfig();
      const payload = encodeSerialShellKey(
        key,
        config.encoding,
        config.txNewline,
        config.backspace,
      );
      echo(echoTextForSerialShellKey(key));
      return enqueue(payload, isImmediateSerialShellKey(key));
    },
    flush,
    clear() {
      engine.clear();
      publisher.cancel();
      onSnapshot(engine.snapshot());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelCoalesce();
      pending.length = 0;
      publisher.cancel();
      stopRaw();
      stopCleared();
      stopAutomation();
    },
  };
}
