import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { ref } from 'vue';

const mocked = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/core', () => {
  class MockChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { invoke: mocked.invoke, Channel: MockChannel };
});

import { useSessionMcumgr } from '@/features/sessions/application/use-session-mcumgr.ts';
import { DEFAULT_MCUMGR_CONFIG } from '@/lib/mcumgr-config.ts';
import type { McumgrClientConfig, SerialSession } from '@/types.ts';
import type { McumgrProgress } from '@/generated/ipc-contracts.ts';

afterEach(() => {
  mocked.invoke.mockReset();
  vi.useRealTimers();
});

interface Harness {
  controller: ReturnType<typeof useSessionMcumgr>;
  session: ReturnType<typeof ref<SerialSession>>;
  suspends: number[];
  resumes: number[];
  patches: Partial<McumgrClientConfig>[];
  setConnected: (value: boolean) => void;
  resumeResult: { value: boolean };
}

function createHarness(options: { connected?: boolean; portName?: string } = {}): Harness {
  const session = ref({
    id: 's1',
    portName: options.portName ?? '/dev/ttyUSB0',
    portConfig: { baudRate: 115_200 },
    mcumgrConfig: { ...DEFAULT_MCUMGR_CONFIG, shellHistory: [] },
  } as SerialSession);
  const isConnected = ref(options.connected ?? true);
  const suspends: number[] = [];
  const resumes: number[] = [];
  const patches: Partial<McumgrClientConfig>[] = [];
  const resumeResult = { value: true };
  const controller = useSessionMcumgr({
    session: session as never,
    isConnected,
    suspendConnection: async () => {
      suspends.push(Date.now());
      isConnected.value = false;
    },
    resumeConnection: async () => {
      resumes.push(Date.now());
      if (resumeResult.value) isConnected.value = true;
      return resumeResult.value;
    },
    ingestTraceFrames: () => undefined,
    setConfig: (patch) => {
      patches.push(patch);
      session.value!.mcumgrConfig = { ...session.value!.mcumgrConfig, ...patch };
    },
  });
  return {
    controller,
    session: session as never,
    suspends,
    resumes,
    patches,
    setConnected: (value) => {
      isConnected.value = value;
    },
    resumeResult,
  };
}

test('busy stays true until the yielded connection is restored', async () => {
  const session = ref({
    id: 's1',
    portName: '/dev/ttyUSB0',
    portConfig: { baudRate: 115_200 },
    mcumgrConfig: { ...DEFAULT_MCUMGR_CONFIG, shellHistory: [] },
  } as SerialSession);
  const isConnected = ref(true);
  let releaseResume: (() => void) | undefined;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const controller = useSessionMcumgr({
    session: session as never,
    isConnected,
    suspendConnection: async () => {
      isConnected.value = false;
    },
    resumeConnection: async () => {
      await resumeGate;
      isConnected.value = true;
      return true;
    },
    ingestTraceFrames: () => undefined,
    setConfig: () => undefined,
  });
  mocked.invoke.mockResolvedValue({ resultJson: '{}' });

  const pending = controller.execute('echo', { kind: 'os-echo', message: 'hi' });
  await Promise.resolve();
  assert.equal(controller.busy.value, true);
  assert.equal(controller.portYielding.value, true);

  releaseResume?.();
  await pending;

  assert.equal(controller.busy.value, false);
  assert.equal(controller.portYielding.value, false);
  assert.equal(isConnected.value, true);
});

test('execute yields the port around the invoke and restores the connection', async () => {
  const harness = createHarness({ connected: true });
  mocked.invoke.mockImplementation(async (command, args) => {
    assert.equal(command, 'mcumgr_execute');
    const request = (args as { request: Record<string, unknown> }).request;
    assert.deepEqual(request.port, {
      path: '/dev/ttyUSB0',
      baudRate: 115_200,
      timeoutMs: DEFAULT_MCUMGR_CONFIG.timeoutMs,
      retries: DEFAULT_MCUMGR_CONFIG.retries,
      autoFrameSize: true,
      frameSize: DEFAULT_MCUMGR_CONFIG.frameSize,
    });
    assert.deepEqual(request.op, { kind: 'os-echo', message: 'hi' });
    // The frontend connection must already be suspended while Rust runs.
    assert.equal(harness.suspends.length, 1);
    assert.equal(harness.resumes.length, 0);
    return { resultJson: '{"r":"hi"}' };
  });

  const result = await harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });

  assert.equal(result, JSON.stringify({ r: 'hi' }, null, 2));
  assert.equal(harness.controller.lastResult.value, result);
  assert.equal(harness.resumes.length, 1);
  assert.deepEqual(harness.controller.status.value, { kind: 'idle' });
});

test('execute skips port yielding when the session is disconnected', async () => {
  const harness = createHarness({ connected: false });
  mocked.invoke.mockResolvedValue({ resultJson: '{}' });

  await harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });

  assert.equal(harness.suspends.length, 0);
  assert.equal(harness.resumes.length, 0);
  assert.deepEqual(harness.controller.status.value, { kind: 'idle' });
});

test('execute reports a noPort error without invoking when the session has no port', async () => {
  const harness = createHarness({ portName: '' });

  const result = await harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });

  assert.equal(result, null);
  assert.equal(mocked.invoke.mock.calls.length, 0);
  assert.equal(harness.controller.status.value.kind, 'error');
});

test('device errors surface localized messages and still restore the connection', async () => {
  const harness = createHarness({ connected: true });
  mocked.invoke.mockRejectedValue({
    kind: 'device',
    message: 'MGMT_ERR_ENOTSUP',
    rc: 8,
    group: 0,
  });

  const result = await harness.controller.execute('image-state', { kind: 'image-state' });

  assert.equal(result, null);
  assert.equal(harness.controller.status.value.kind, 'error');
  if (harness.controller.status.value.kind === 'error') {
    assert.match(harness.controller.status.value.message, /不支持|not supported/i);
    assert.equal(harness.controller.status.value.rc, 8);
    assert.equal(harness.controller.status.value.group, 0);
  }
  assert.match(harness.controller.lastResult.value, /镜像状态|Image state/);
  assert.equal(harness.resumes.length, 1);
});

test('timeout errors map to the timeout status', async () => {
  const harness = createHarness({ connected: false });
  mocked.invoke.mockRejectedValue({ kind: 'timeout', message: 'timed out' });

  await harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });

  assert.deepEqual(harness.controller.status.value, { kind: 'timeout' });
});

test('a second operation is rejected while one is running', async () => {
  const harness = createHarness({ connected: false });
  let release: (() => void) | undefined;
  mocked.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ resultJson: '{}' });
      }),
  );

  const first = harness.controller.execute('echo', { kind: 'os-echo', message: 'a' });
  await Promise.resolve();
  const second = await harness.controller.execute('echo', { kind: 'os-echo', message: 'b' });

  assert.equal(second, null);
  assert.equal(mocked.invoke.mock.calls.length, 1);
  release?.();
  await first;
});

test('firmware update forwards channel progress into the status', async () => {
  const harness = createHarness({ connected: false });
  const seen: McumgrProgress[] = [];
  mocked.invoke.mockImplementation(async (command, args) => {
    assert.equal(command, 'mcumgr_firmware_update');
    const { request, onProgress } = args as {
      request: Record<string, unknown>;
      onProgress: { onmessage: (progress: McumgrProgress) => void };
    };
    assert.equal(request.fileToken, 'grant-1');
    assert.equal(request.upgradeOnly, true);
    const progress: McumgrProgress = {
      phase: 'uploading',
      detail: null,
      offset: 512,
      total: 1024,
    };
    seen.push(progress);
    onProgress.onmessage(progress);
    assert.deepEqual(harness.controller.status.value, {
      kind: 'progress',
      action: 'firmware-update',
      phase: 'uploading',
      detail: undefined,
      offset: 512,
      total: 1024,
    });
    return { resultJson: '"ok"' };
  });

  const result = await harness.controller.firmwareUpdate('grant-1', { upgradeOnly: true });

  assert.equal(seen.length, 1);
  assert.equal(result, '"ok"');
  assert.deepEqual(harness.controller.status.value, { kind: 'idle' });
});

test('cancelled long operations return to idle instead of error', async () => {
  const harness = createHarness({ connected: false });
  mocked.invoke.mockRejectedValue({ kind: 'cancelled', message: 'cancelled' });

  await harness.controller.imageUpload('grant-2');

  assert.deepEqual(harness.controller.status.value, { kind: 'idle' });
});

test('resume failures after the operation surface as an error status', async () => {
  vi.useFakeTimers();
  const harness = createHarness({ connected: true });
  harness.resumeResult.value = false;
  mocked.invoke.mockResolvedValue({ resultJson: '{}' });

  const pending = harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });
  await vi.runAllTimersAsync();
  await pending;

  // All retry delays exhausted (immediate + 1s + 2.5s backoff attempts).
  assert.equal(harness.resumes.length, 3);
  assert.equal(harness.controller.status.value.kind, 'error');
});

test('cancel unblocks the UI while a hung invoke is still in flight', async () => {
  const harness = createHarness({ connected: true });
  mocked.invoke.mockImplementation(
    (command) =>
      new Promise((resolve) => {
        if (command === 'mcumgr_cancel') {
          resolve(undefined);
          return;
        }
        // Intentionally never resolve mcumgr_execute — mirrors a stuck open after
        // the OS serial permission dialog or a silent auto-frame negotiation.
      }),
  );

  const pending = harness.controller.execute('echo', { kind: 'os-echo', message: 'hi' });
  await Promise.resolve();
  assert.equal(harness.controller.busy.value, true);
  assert.equal(harness.suspends.length, 1);

  harness.controller.cancel();
  await pending;

  assert.equal(harness.controller.busy.value, false);
  assert.equal(harness.resumes.length, 1);
  assert.equal(
    mocked.invoke.mock.calls.some((call) => call[0] === 'mcumgr_cancel'),
    true,
  );
});

test('rememberShell appends deduplicated history through setConfig', () => {
  const harness = createHarness();
  harness.controller.rememberShell('kernel uptime');
  harness.controller.rememberShell('device list');
  harness.controller.rememberShell('kernel uptime');

  const history = harness.session.value!.mcumgrConfig.shellHistory;
  assert.deepEqual(history, ['device list', 'kernel uptime']);
  assert.equal(harness.patches.length, 3);
});

test('fs download reports the saved file name and byte count', async () => {
  const harness = createHarness({ connected: false });
  mocked.invoke.mockImplementation(async (command) => {
    assert.equal(command, 'mcumgr_fs_download');
    return { displayName: 'log.txt', bytes: 2048 };
  });

  const result = await harness.controller.fsDownload('/lfs/log.txt', 'save-grant');

  assert.ok(result);
  assert.match(result, /log\.txt/);
  assert.match(result, /2048/);
});
