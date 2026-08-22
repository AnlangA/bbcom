import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const mocked = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('@tauri-apps/api/core', async () => {
  const { createInvokeMock } = await import('@/test/helpers/invoke-mock.ts');
  return {
    invoke: createInvokeMock({
      onCall: (command, args) => {
        mocked.calls.push({ method: command, args: [args] });
      },
      responses: {
        drain_serial_input: () => ({
          bytes: [0xaa, 0xbb],
          guaranteed: true,
          completion: 'idle-gap-observed',
        }),
      },
    }),
  };
});

vi.mock('tauri-plugin-serialplugin-api', () => {
  class SerialPort {
    constructor(options: unknown) {
      mocked.calls.push({ method: 'constructor', args: [options] });
    }

    static async forceClose(path: string): Promise<void> {
      mocked.calls.push({ method: 'forceClose', args: [path] });
    }

    static async available_ports(): Promise<Record<string, unknown>> {
      mocked.calls.push({ method: 'availablePorts', args: [] });
      return { COM9: { type: 'usb' } };
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

    async readClearToSend(): Promise<boolean> {
      mocked.calls.push({ method: 'cts', args: [] });
      return true;
    }

    async readDataSetReady(): Promise<boolean> {
      mocked.calls.push({ method: 'dsr', args: [] });
      return false;
    }

    async readRingIndicator(): Promise<boolean> {
      mocked.calls.push({ method: 'ri', args: [] });
      return true;
    }

    async readCarrierDetect(): Promise<boolean> {
      mocked.calls.push({ method: 'cd', args: [] });
      return false;
    }

    async setBreak(): Promise<void> {
      mocked.calls.push({ method: 'setBreak', args: [] });
    }

    async clearBreak(): Promise<void> {
      mocked.calls.push({ method: 'clearBreak', args: [] });
    }

    async bytesToRead(): Promise<number> {
      mocked.calls.push({ method: 'bytesToRead', args: [] });
      return 7;
    }

    async bytesToWrite(): Promise<number> {
      mocked.calls.push({ method: 'bytesToWrite', args: [] });
      return 3;
    }

    async clearBuffer(selection: unknown): Promise<void> {
      mocked.calls.push({ method: 'clearBuffer', args: [selection] });
    }

    async close(): Promise<void> {
      mocked.calls.push({ method: 'close', args: [] });
    }
  }
  return {
    ClearBuffer: { Input: 'input-native', Output: 'output-native', All: 'all-native' },
    SerialPort,
  };
});

import {
  createTauriSerialPort,
  enumerateTauriSerialPorts,
} from '@/features/serial/index.ts';

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
  assert.equal(await port.readClearToSend?.(), true);
  assert.equal(await port.readDataSetReady?.(), false);
  assert.equal(await port.readRingIndicator?.(), true);
  assert.equal(await port.readCarrierDetect?.(), false);
  await port.setBreak();
  await port.clearBreak();
  assert.equal(await port.bytesToRead?.(), 7);
  assert.equal(await port.bytesToWrite?.(), 3);
  await port.clearBuffer?.('input');
  await port.clearBuffer?.('output');
  await port.clearBuffer?.('all');
  assert.deepEqual(await port.drainNativeInput?.(), {
    bytes: [0xaa, 0xbb],
    guaranteed: true,
    completion: 'idle-gap-observed',
  });
  await port.yieldQueuedChannelEvents?.();
  await port.close();
  await port.forceClose?.();
  assert.deepEqual(await enumerateTauriSerialPorts(), { COM9: { type: 'usb' } });

  assert.deepEqual(
    mocked.calls.map((call) => call.method),
    [
      'constructor',
      'open',
      'watch',
      'writeBinary',
      'dtr',
      'rts',
      'cts',
      'dsr',
      'ri',
      'cd',
      'setBreak',
      'clearBreak',
      'bytesToRead',
      'bytesToWrite',
      'clearBuffer',
      'clearBuffer',
      'clearBuffer',
      'drain_serial_input',
      'close',
      'forceClose',
      'availablePorts',
    ],
  );
  assert.equal(mocked.calls[0].args[0].path, 'COM9');
  assert.equal(mocked.calls[2].args[0], handlers);
  assert.equal(mocked.calls[2].args[1], watchOptions);
  assert.deepEqual(
    mocked.calls.filter((call) => call.method === 'clearBuffer').map((call) => call.args[0]),
    ['input-native', 'output-native', 'all-native'],
  );
  assert.deepEqual(mocked.calls.find((call) => call.method === 'drain_serial_input')?.args[0], {
    request: { path: 'COM9' },
  });
  assert.equal(mocked.calls.find((call) => call.method === 'forceClose')?.args[0], 'COM9');
});
