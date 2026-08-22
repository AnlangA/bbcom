import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AiActivityCancelledError,
  AiActivityCenter,
  applyAiAuthorityEnvelope,
  createAiBridgeEnvelope,
  parseAiBridgeEnvelope,
} from '../../src/features/ai-activity/index.ts';
import { OperationRegistry } from '../../src/features/platform/application/operation-registry.ts';
import { useAiWindowSession } from '../../src/features/ai/application/use-ai-window-session.ts';
import type { AiKeyStatus } from '../../src/generated/ipc-contracts.ts';
import type { AiSessionSummary } from '../../src/types/index.ts';

const SESSION: AiSessionSummary = {
  id: 'session-a',
  portName: 'COM1',
  baudRate: 115200,
  isConnected: false,
  txBytes: 0,
  rxBytes: 0,
  txFrames: 0,
  rxFrames: 0,
  terminalAiModel: 'glm-4.5-air',
  logAiModel: 'glm-4.5-air',
  logAiContextMode: 'latest-10k',
  logAiFrameLimit: 200,
};

test('AI bridge rejects old or partially correlated cross-window messages', () => {
  assert.equal(parseAiBridgeEnvelope({ sessionId: 'session-a' }, 'main'), null);
  assert.equal(
    parseAiBridgeEnvelope(
      {
        schemaVersion: 1,
        workspaceId: 'application',
        revision: 1,
        origin: 'main',
        sessionId: 'session-a',
        payload: { kind: 'session-snapshot' },
      },
      'main',
    ),
    null,
    'requestId is mandatory',
  );
});

test('AI window accepts monotonic correlated snapshots and rejects stale revisions', () => {
  const bridge = useAiWindowSession({
    emit: async () => undefined,
    strictProtocol: true,
    requestId: () => 'request-window',
  });
  const current = createAiBridgeEnvelope({
    workspaceId: 'workspace-a',
    revision: 3,
    origin: 'main',
    requestId: 'request-3',
    sessionId: SESSION.id,
    payload: { kind: 'session-snapshot', session: SESSION },
  });
  assert.equal(bridge.receiveSessionSnapshot(current), true);
  assert.equal(bridge.session.value?.id, SESSION.id);
  assert.equal(bridge.revision.value, 3);

  const stale = createAiBridgeEnvelope({
    workspaceId: 'workspace-a',
    revision: 2,
    origin: 'main',
    requestId: 'request-2',
    sessionId: 'session-b',
    payload: { kind: 'session-snapshot', session: { ...SESSION, id: 'session-b' } },
  });
  assert.equal(bridge.receiveSessionSnapshot(stale), false);
  assert.equal(bridge.session.value?.id, SESSION.id);
});

test('AI webview cannot submit an assistant chat message', async () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const bridge = useAiWindowSession({
    emit: async (event, payload) => {
      emitted.push({ event, payload });
    },
    strictProtocol: true,
    requestId: () => 'request-a',
  });
  bridge.receiveSessionSnapshot(
    createAiBridgeEnvelope({
      workspaceId: 'workspace-a',
      revision: 5,
      origin: 'main',
      requestId: 'snapshot-a',
      sessionId: SESSION.id,
      payload: { kind: 'session-snapshot', session: SESSION },
    }),
  );
  const binding = bridge.createRequestBinding('request-ai');
  if (!binding) throw new Error('expected a request binding');

  bridge.receiveSessionSnapshot(
    createAiBridgeEnvelope({
      workspaceId: 'workspace-a',
      revision: 6,
      origin: 'main',
      requestId: 'snapshot-b',
      sessionId: 'session-b',
      payload: { kind: 'session-snapshot', session: { ...SESSION, id: 'session-b' } },
    }),
  );
  await assert.rejects(
    bridge.addLogAiMessage({ role: 'assistant', content: 'answer for A' }, binding),
    /committed only by the main window/,
  );
  assert.equal(emitted.length, 0);
});

test('terminal apply and explicit release retain the immutable request binding', async () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const bridge = useAiWindowSession({
    emit: async (event, payload) => {
      emitted.push({ event, payload });
    },
    strictProtocol: true,
  });
  bridge.receiveSessionSnapshot(
    createAiBridgeEnvelope({
      workspaceId: 'workspace-a',
      revision: 9,
      origin: 'main',
      requestId: 'snapshot-a',
      sessionId: SESSION.id,
      payload: { kind: 'session-snapshot', session: SESSION },
    }),
  );
  const binding = bridge.createRequestBinding('terminal-a');
  if (!binding) throw new Error('expected terminal request binding');

  await bridge.applyCommand('pwd', binding);
  await bridge.releaseRequestBinding(binding);

  const apply = parseAiBridgeEnvelope(emitted[0]?.payload, 'ai-assistant');
  const release = parseAiBridgeEnvelope(emitted[1]?.payload, 'ai-assistant');
  assert.equal(emitted[0]?.event, 'ai-command-apply');
  assert.equal(emitted[1]?.event, 'ai-activity-cancel');
  assert.deepEqual(
    [apply?.workspaceId, apply?.sessionId, apply?.revision, apply?.requestId],
    ['workspace-a', SESSION.id, 9, 'terminal-a'],
  );
  assert.deepEqual(
    [release?.workspaceId, release?.sessionId, release?.revision, release?.requestId],
    ['workspace-a', SESSION.id, 9, 'terminal-a'],
  );
});

test('AI window delegates native work to main authority and rejects a cross-workspace result', async () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const bridge = useAiWindowSession({
    emit: async (event, payload) => {
      emitted.push({ event, payload });
    },
    strictProtocol: true,
  });
  bridge.receiveSessionSnapshot(
    createAiBridgeEnvelope({
      workspaceId: 'workspace-a',
      revision: 7,
      origin: 'main',
      requestId: 'snapshot-a',
      sessionId: SESSION.id,
      payload: { kind: 'session-snapshot', session: SESSION },
    }),
  );
  const binding = bridge.createRequestBinding('request-main-owned');
  if (!binding) throw new Error('expected a real workspace binding');
  const result = bridge.runRequest(
    { requestId: binding.requestId, kind: 'terminal', prompt: 'pwd' },
    binding,
  );
  const requestEnvelope = parseAiBridgeEnvelope(emitted.at(-1)?.payload, 'ai-assistant');
  assert.equal(emitted.at(-1)?.event, 'ai-activity-run');
  assert.equal(requestEnvelope?.workspaceId, 'workspace-a');

  assert.equal(
    bridge.receiveActivityResult(
      createAiBridgeEnvelope({
        workspaceId: 'workspace-b',
        revision: binding.revision,
        origin: 'main',
        requestId: binding.requestId,
        sessionId: binding.sessionId,
        payload: {
          kind: 'activity-result',
          outcome: 'completed',
          result: { kind: 'terminal', command: 'pwd', explanation: 'wrong', risk: 'safe' },
        },
      }),
    ),
    false,
  );
  assert.equal(
    bridge.receiveActivityResult(
      createAiBridgeEnvelope({
        workspaceId: binding.workspaceId,
        revision: binding.revision,
        origin: 'main',
        requestId: binding.requestId,
        sessionId: binding.sessionId,
        payload: {
          kind: 'activity-result',
          outcome: 'completed',
          result: { kind: 'terminal', command: 'pwd', explanation: 'current', risk: 'safe' },
        },
      }),
    ),
    true,
  );
  assert.equal((await result).result.kind, 'terminal');
});

test('application operation quiesce interrupts native AI exactly once', async () => {
  let release!: (value: never) => void;
  const native = new Promise<never>((resolve) => {
    release = resolve;
  });
  const cancelled: string[] = [];
  const operations = new OperationRegistry();
  const center = new AiActivityCenter({
    operations,
    run: () => native,
    cancel: async (requestId) => {
      cancelled.push(requestId);
    },
  });
  const task = center.run({
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    revision: 4,
    requestId: 'request-cancel',
    request: { requestId: 'request-cancel', kind: 'terminal', prompt: 'ls' },
  });
  assert.equal(center.snapshot()[0].status, 'running');
  const [cancelledRecord] = await operations.interruptActive();
  assert.equal(cancelledRecord.status, 'interrupted');
  assert.deepEqual(cancelled, ['request-cancel']);
  release(undefined as never);
  await assert.rejects(task, AiActivityCancelledError);
});

test('AI activity center stores work only in the supplied application registry', () => {
  const operations = new OperationRegistry();
  const center = new AiActivityCenter({
    operations,
    run: async () => ({ kind: 'terminal', command: '', explanation: '', risk: 'safe' }),
  });
  const task = center.run({
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    revision: 1,
    requestId: 'request-owned',
    request: { requestId: 'request-owned', kind: 'terminal', prompt: 'pwd' },
  });
  assert.equal(center.operations, operations);
  assert.equal(operations.get('request-owned')?.status, 'running');
  return task;
});

test('main authority applies theme, locale and key state only at a non-stale revision', () => {
  const applied: string[] = [];
  let key: AiKeyStatus = { configured: false, durability: 'missing' };
  const target = {
    setTheme: (theme: 'dark' | 'light') => applied.push(`theme:${theme}`),
    setLocale: (locale: 'en' | 'zh') => applied.push(`locale:${locale}`),
    get aiKeyStatus() {
      return key;
    },
    set aiKeyStatus(value: AiKeyStatus) {
      key = value;
    },
  };
  const authority = createAiBridgeEnvelope({
    revision: 8,
    origin: 'main',
    requestId: 'authority-8',
    sessionId: 'no-session',
    payload: {
      kind: 'authority-snapshot',
      theme: 'light',
      locale: 'en',
      aiKeyStatus: { configured: true, durability: 'session' },
    },
  });
  assert.equal(applyAiAuthorityEnvelope(authority, 7, target), 8);
  assert.deepEqual(applied, ['theme:light', 'locale:en']);
  assert.deepEqual(key, { configured: true, durability: 'session' });
  assert.equal(applyAiAuthorityEnvelope(authority, 9, target), null);
});
