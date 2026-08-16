import { invoke } from '@tauri-apps/api/core';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import type { SerialDrainRequest, SerialDrainResponse } from '../../../generated/ipc-contracts';
import type { SerialPortFactory } from '../application/serial-port';

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

export function enumerateTauriSerialPorts(): Promise<Record<string, unknown>> {
  return SerialPort.available_ports();
}
