import { invoke } from '@tauri-apps/api/core';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import type { SerialportOptions, WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import type { SerialDrainRequest, SerialDrainResponse } from '../generated/ipc-contracts';

/** Minimal v3 watch handle used by the connection state machine. */
export interface SerialWatchHandleAdapter {
  unwatch(): Promise<void>;
}

/**
 * The serial-plugin surface consumed by the application.
 *
 * Keeping this boundary structural makes connection races testable without a
 * Tauri runtime and prevents plugin details from leaking into session logic.
 */
export interface SerialPortAdapter {
  open(): Promise<void>;
  watch(handlers: WatchHandlers, options?: WatchOptions): Promise<SerialWatchHandleAdapter>;
  writeBinary(data: Uint8Array): Promise<number>;
  writeDataTerminalReady(value: boolean): Promise<void>;
  writeRequestToSend(value: boolean): Promise<void>;
  setBreak(): Promise<void>;
  clearBreak(): Promise<void>;
  close(): Promise<void>;
  /**
   * Drain the native RX hub and driver after `unwatch` has acknowledged.
   *
   * This remains optional for non-Tauri structural adapters. A production
   * connection treats absence or failure as explicitly non-guaranteed.
   */
  drainNativeInput?(): Promise<SerialDrainResponse>;
  /** Yield one host task so Channel events queued before command completion run. */
  yieldQueuedChannelEvents?(): Promise<void>;
  /**
   * Abort a native operation that did not settle during the normal close
   * grace period.  v3 exposes this as a static operation keyed by the port
   * path, so it deliberately lives beside (rather than replaces) `close`.
   */
  forceClose?(): Promise<void>;
}

export type SerialPortFactory = (options: SerialportOptions) => SerialPortAdapter;

/** Production adapter for tauri-plugin-serialplugin v3. */
export const createTauriSerialPort: SerialPortFactory = (options) => {
  const port = new SerialPort(options);
  return {
    open: () => port.open(),
    watch: (handlers, watchOptions) => port.watch(handlers, watchOptions),
    writeBinary: (data) => port.writeBinary(data),
    writeDataTerminalReady: (value) => port.writeDataTerminalReady(value),
    writeRequestToSend: (value) => port.writeRequestToSend(value),
    setBreak: () => port.setBreak(),
    clearBreak: () => port.clearBreak(),
    close: () => port.close(),
    drainNativeInput: () => {
      // serialplugin v3 is path-scoped for every existing operation. The
      // dedicated Rust command is main-window-only, validates this value, and
      // never returns or logs it; an opaque native lease is the future route
      // for removing the path from the WebView boundary entirely.
      const request: SerialDrainRequest = { path: options.path };
      return invoke<SerialDrainResponse>('drain_serial_input', { request });
    },
    yieldQueuedChannelEvents: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
    forceClose: () => SerialPort.forceClose(options.path),
  };
};
