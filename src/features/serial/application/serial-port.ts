import type { SerialportOptions, WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import type { SerialDrainResponse } from '../../../generated/ipc-contracts';
import type { PortConfig } from '@/types';

export interface SerialWatchHandleAdapter {
  unwatch(): Promise<void>;
}

export type SerialPortBufferSelection = 'input' | 'output' | 'all';

export interface SerialPortAdapter {
  open(): Promise<void>;
  watch(handlers: WatchHandlers, options?: WatchOptions): Promise<SerialWatchHandleAdapter>;
  writeBinary(data: Uint8Array): Promise<number>;
  /** Apply communication parameters without closing the active port. */
  reconfigure?(config: PortConfig, previousConfig?: Readonly<PortConfig>): Promise<void>;
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
