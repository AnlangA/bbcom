import type { SerialSendResult, SerialWriteOptions } from '@/types/serial';
import type { SerialShellConfig } from '@/types/serial-shell';
import type { SerialAutomationPausePort } from '../../serial';
import {
  SerialShellDecoder,
  SerialShellRxMapper,
  cloneSerialShellConfig,
  encodeSerialShellKey,
  echoTextForSerialShellKey,
  isImmediateSerialShellKey,
  serialShellKeysFromData,
} from '@/lib/serial-shell';
import type { SerialTimerScheduler } from '@/lib/serial-rx-scheduler';

export const SERIAL_SHELL_COALESCE_MS = 16;
export const SERIAL_SHELL_COALESCE_BYTES = 64;
/** Upper bound of terminal-ready output retained for replay after a remount. */
export const SERIAL_SHELL_REPLAY_MAX_CHARS = 256 * 1024;

export interface SessionShellControllerPorts {
  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult>;
  rawBytes(callback: (bytes: Uint8Array) => void): () => void;
  registerAutomation(port: SerialAutomationPausePort): () => void;
  onCleared(listener: () => void): () => void;
  scheduler?: SerialTimerScheduler;
}

/**
 * Resident RX/TX bridge between the serial session and the shell terminal.
 * RX bytes become terminal-ready text (decode + newline adaptation) published
 * to `onOutput` and retained in a bounded replay buffer so a freshly mounted
 * terminal can restore its scrollback. TX translates xterm `onData` chunks
 * into device bytes with the same coalescing and automation-pause rules the
 * previous input path used.
 */
export interface SessionShellController {
  configure(config: SerialShellConfig): void;
  /** Translate an xterm.js `onData` chunk into device bytes and local echo. */
  handleTerminalData(data: string): void;
  /** Terminal-ready output retained for replay into a fresh terminal. */
  replay(): string;
  onOutput(listener: (chunk: string) => void): () => void;
  onReset(listener: () => void): () => void;
  clear(): void;
  flush(): Promise<SerialSendResult | null>;
  dispose(): void;
}

export function createSessionShellController(
  getConfig: () => SerialShellConfig,
  ports: SessionShellControllerPorts,
): SessionShellController {
  let configured = cloneSerialShellConfig(getConfig());
  const decoder = new SerialShellDecoder(configured.encoding);
  const rxMapper = new SerialShellRxMapper(configured.rxNewline);
  const outputListeners = new Set<(chunk: string) => void>();
  const resetListeners = new Set<() => void>();
  const replayChunks: string[] = [];
  let replayLength = 0;
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

  function emitOutput(text: string): void {
    if (text.length === 0) return;
    replayChunks.push(text);
    replayLength += text.length;
    while (replayLength > SERIAL_SHELL_REPLAY_MAX_CHARS && replayChunks.length > 1) {
      const dropped = replayChunks.shift();
      replayLength -= dropped?.length ?? 0;
    }
    if (replayLength > SERIAL_SHELL_REPLAY_MAX_CHARS && replayChunks.length === 1) {
      const only = replayChunks[0] ?? '';
      replayChunks[0] = only.slice(only.length - SERIAL_SHELL_REPLAY_MAX_CHARS);
      replayLength = replayChunks[0].length;
    }
    for (const listener of outputListeners) listener(text);
  }

  function enqueue(payload: Uint8Array, immediate: boolean): void {
    if (disposed || payload.length === 0) return;
    for (const byte of payload) pending.push(byte);
    if (immediate || pending.length >= SERIAL_SHELL_COALESCE_BYTES) {
      void flush();
      return;
    }
    scheduleCoalesce();
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

  function clear(): void {
    decoder.reset();
    rxMapper.reset();
    replayChunks.length = 0;
    replayLength = 0;
    for (const listener of resetListeners) listener();
  }

  const stopRaw = ports.rawBytes((bytes) => {
    if (disposed || bytes.length === 0) return;
    const decoded = decoder.push(bytes);
    if (decoded.length === 0) return;
    emitOutput(rxMapper.push(decoded));
  });
  const stopCleared = ports.onCleared(() => {
    clear();
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

  return {
    configure(config) {
      const next = cloneSerialShellConfig(config);
      if (next.encoding !== configured.encoding) decoder.setEncoding(next.encoding);
      if (next.rxNewline !== configured.rxNewline) rxMapper.setMode(next.rxNewline);
      configured = next;
    },
    handleTerminalData(data) {
      if (disposed || data.length === 0) return;
      const config = getConfig();
      for (const key of serialShellKeysFromData(data)) {
        const payload = encodeSerialShellKey(
          key,
          config.encoding,
          config.txNewline,
          config.backspace,
        );
        if (config.localEcho) {
          const echo = echoTextForSerialShellKey(key);
          if (echo) emitOutput(echo);
        }
        enqueue(payload, isImmediateSerialShellKey(key));
      }
    },
    replay: () => replayChunks.join(''),
    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    onReset(listener) {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },
    clear,
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelCoalesce();
      pending.length = 0;
      outputListeners.clear();
      resetListeners.clear();
      stopRaw();
      stopCleared();
      stopAutomation();
    },
  };
}
