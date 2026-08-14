import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const mocked = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    mocked.calls.push({ method: command, args: [args] });
    return {
      bytes: [0xaa, 0xbb],
      guaranteed: true,
      completion: 'idle-gap-observed',
    };
  },
}));

vi.mock('tauri-plugin-serialplugin-api', () => {
  class SerialPort {
    constructor(options: unknown) {
      mocked.calls.push({ method: 'constructor', args: [options] });
    }

    static async forceClose(path: string): Promise<void> {
      mocked.calls.push({ method: 'forceClose', args: [path] });
    }

    async open(): Promise<void> {
      mocked.calls.push({ method: 'open', args: [] });
    }

    async watch(...args: unknown[]): Promise<{ unwatch: () => Promise<void> }> {
      mocked.calls.push({ method: 'watch', args });
      return { unwatch: async () => undefined };
    }

    async writeBinary(data: Uint8Array): Promise<number> {
      mocked.calls.push({ method: 'writeBinary', args: [data] });
      return data.length;
    }

    async writeDataTerminalReady(value: boolean): Promise<void> {
      mocked.calls.push({ method: 'dtr', args: [value] });
    }

    async writeRequestToSend(value: boolean): Promise<void> {
      mocked.calls.push({ method: 'rts', args: [value] });
    }

    async setBreak(): Promise<void> {
      mocked.calls.push({ method: 'setBreak', args: [] });
    }

    async clearBreak(): Promise<void> {
      mocked.calls.push({ method: 'clearBreak', args: [] });
    }

    async close(): Promise<void> {
      mocked.calls.push({ method: 'close', args: [] });
    }
  }
  return { SerialPort };
});

import { createTauriSerialPort } from '../../src/lib/serial-port-adapter.ts';

beforeEach(() => {
  mocked.calls.splice(0);
});

test('Tauri serial adapter forwards every v3 operation to the path-scoped plugin port', async () => {
  const port = createTauriSerialPort({
    path: 'COM9',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  const handlers = { onData: vi.fn(), onDisconnect: vi.fn(), onError: vi.fn() };
  const watchOptions = { decode: false };

  await port.open();
  await port.watch(handlers, watchOptions);
  assert.equal(await port.writeBinary(new Uint8Array([1, 2, 3])), 3);
  await port.writeDataTerminalReady(true);
  await port.writeRequestToSend(false);
  await port.setBreak();
  await port.clearBreak();
  assert.deepEqual(await port.drainNativeInput?.(), {
    bytes: [0xaa, 0xbb],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  await port.yieldQueuedChannelEvents?.();
  await port.close();
  await port.forceClose?.();

  assert.deepEqual(
    mocked.calls.map((call) => call.method),
    [
      'constructor',
      'open',
      'watch',
      'writeBinary',
      'dtr',
      'rts',
      'setBreak',
      'clearBreak',
      'drain_serial_input',
      'close',
      'forceClose',
    ],
  );
  assert.equal(mocked.calls[0].args[0].path, 'COM9');
  assert.equal(mocked.calls[2].args[0], handlers);
  assert.equal(mocked.calls[2].args[1], watchOptions);
  assert.deepEqual(mocked.calls[8].args[0], { request: { path: 'COM9' } });
  assert.equal(mocked.calls.at(-1)?.args[0], 'COM9');
});
