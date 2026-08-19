import type { SerialportOptions, WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import type { SerialDrainResponse } from '../../../generated/ipc-contracts';

export interface SerialWatchHandleAdapter {
  unwatch(): Promise<void>;
}

export type SerialPortBufferSelection = 'input' | 'output' | 'all';

export interface SerialPortAdapter {
  open(): Promise<void>;
  watch(handlers: WatchHandlers, options?: WatchOptions): Promise<SerialWatchHandleAdapter>;
  writeBinary(data: Uint8Array): Promise<number>;
  writeDataTerminalReady(value: boolean): Promise<void>;
  writeRequestToSend(value: boolean): Promise<void>;
  readClearToSend?(): Promise<boolean>;
  readDataSetReady?(): Promise<boolean>;
  readRingIndicator?(): Promise<boolean>;
  readCarrierDetect?(): Promise<boolean>;
  setBreak(): Promise<void>;
  clearBreak(): Promise<void>;
  bytesToRead?(): Promise<number>;
  bytesToWrite?(): Promise<number>;
  clearBuffer?(selection: SerialPortBufferSelection): Promise<void>;
  close(): Promise<void>;
  drainNativeInput?(): Promise<SerialDrainResponse>;
  yieldQueuedChannelEvents?(): Promise<void>;
  forceClose?(): Promise<void>;
}

export type SerialPortFactory = (options: SerialportOptions) => SerialPortAdapter;
