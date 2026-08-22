// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { WatchHandlers, WatchOptions } from 'tauri-plugin-serialplugin-api';
import {
  addDeviceProfile,
  loadDeviceProfiles,
  removeDeviceProfile,
} from '../../src/features/device-profiles/index.ts';
import {
  classifyOpenFailure,
  serialConnectionFailureMessage,
  useSerialConnection,
} from '../../src/features/sessions/application/use-serial-connection.ts';
import type {
  SerialPortAdapter,
  SerialWatchHandleAdapter,
} from '../../src/features/serial/index.ts';
import { createSessionRecord } from '../../src/lib/session-persistence.ts';
import { PortLeaseRegistry } from '../../src/features/serial/application/port-lease-registry.ts';
import { useSessionStore } from '../../src/features/sessions/store/session-store.ts';
import SessionTabs from '../../src/features/sessions/ui/SessionTabs.vue';
import SessionToolbar from '../../src/features/sessions/ui/SessionToolbar.vue';
import type { HydratedWorkspaceSession } from '../../src/features/workspace/adapters/index.ts';
import type { PortConfig, SerialSession } from '../../src/types/index.ts';

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

const sessionActions = vi.hoisted(() => ({ requestCloseSession: vi.fn() }));
vi.mock('../../src/features/sessions/application/use-session-actions', () => ({
  useSessionActions: () => sessionActions,
}));

class NoopWatch implements SerialWatchHandleAdapter {
  async unwatch(): Promise<void> {}
}

class ControlledPort implements SerialPortAdapter {
  constructor(private readonly openFailure?: unknown) {}
  handlers: WatchHandlers | null = null;
  async open(): Promise<void> {
    if (this.openFailure !== undefined) throw this.openFailure;
  }
  async watch(handlers: WatchHandlers, _options?: WatchOptions): Promise<SerialWatchHandleAdapter> {
    this.handlers = handlers;
    return new NoopWatch();
  }
  async writeBinary(data: Uint8Array): Promise<number> {
    return data.length;
  }
  async writeDataTerminalReady(): Promise<void> {}
  async writeRequestToSend(): Promise<void> {}
  async setBreak(): Promise<void> {}
  async clearBreak(): Promise<void> {}
  async close(): Promise<void> {}
}

beforeEach(() => {
  localStorage.clear();
  sessionActions.requestCloseSession.mockReset();
  setActivePinia(createPinia());
});

test('serial open failures have stable categories and never expose backend prose', () => {
  const cases: Array<[unknown, string, string]> = [
    [new Error('ENOENT: /dev/ttyGone'), 'device-missing', 'SERIAL_DISCONNECTED'],
    [new Error('EACCES secret native details'), 'permission-denied', 'IO_PERMISSION_DENIED'],
    [new Error('driver panic secret native details'), 'backend-failure', 'BUSY'],
    [{ code: 'INVALID_INPUT', message: 'raw native path' }, 'invalid-port', 'INVALID_INPUT'],
  ];
  for (const [source, category, code] of cases) {
    const failure = classifyOpenFailure(source);
    assert.equal(failure.category, category);
    assert.equal(failure.error.code, code);
    assert.doesNotMatch(
      serialConnectionFailureMessage(failure),
      /ENOENT|EACCES|panic|native path/i,
    );
  }
});

test('PORT_IN_USE blocks native open, displays its owner, and toolbar emits owner navigation', async () => {
  const leases = new PortLeaseRegistry({ platform: 'windows' });
  leases.acquire('COM8', 'owner-session', 'Scope owner');
  const store = useSessionStore();
  const contender = store.createSession('COM8', config);
  let portFactoryCalls = 0;
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(contender, 'COM8', config, undefined, {
      leaseClient: leases,
      sessionName: 'Contender',
      createPort: () => {
        portFactoryCalls += 1;
        return new ControlledPort();
      },
    }),
  );
  assert.ok(connection);
  assert.equal(await connection.start(), false);
  assert.equal(portFactoryCalls, 0);
  assert.equal(connection.connectionFailure.value?.category, 'port-in-use');
  assert.match(serialConnectionFailureMessage(connection.connectionFailure.value!), /Scope owner/);

  const toolbar = mount(SessionToolbar, {
    props: toolbarProps(store.sessions[0], connection.connectionFailure.value!.conflict),
    global: { stubs: { NButton: buttonStub(), NTag: true, AppSelect: true } },
  });
  await toolbar.get('.conflict-action').trigger('click');
  assert.deepEqual(toolbar.emitted('show-conflicting-session'), [['owner-session']]);
  scope.stop();
});

test('workspace rebind is atomic, explicit, stopped, and the next open freezes one new target', async () => {
  const store = useSessionStore();
  const persistence = useSessionStore();
  const restored = createSessionRecord('restored-session', '', config);
  const entry = hydratedEntry(restored, 'Restored board');
  store.replaceWorkspaceSessions([entry], restored.id);

  assert.equal(store.workspaceRebindBySessionId[restored.id]?.required, true);
  assert.equal(store.sessions[0].isConnected, false);
  const events: unknown[] = [];
  const detach = persistence.subscribeWorkspaceChanges((event) => events.push(event));
  const rebound = store.completeWorkspaceRebind(restored.id, 'COM12', {
    ...config,
    baudRate: 57_600,
  });
  assert.deepEqual(rebound, { ok: true });
  assert.equal(store.workspaceRebindBySessionId[restored.id], undefined);
  assert.equal(store.sessions[0].portName, 'COM12');
  assert.equal(store.sessions[0].isConnected, false);
  assert.deepEqual(events, [{ kind: 'session-changed', sessionId: restored.id }]);

  const targets: Array<{ path: string; baudRate: number }> = [];
  const scope = effectScope();
  const connection = scope.run(() =>
    useSerialConnection(
      restored.id,
      () => store.sessions[0].portName,
      () => store.sessions[0].portConfig,
      undefined,
      {
        leaseClient: new PortLeaseRegistry({ platform: 'windows' }),
        sessionName: () => store.sessions[0].portName,
        createPort: (options) => {
          targets.push({ path: options.path, baudRate: options.baudRate });
          // Changing the store after the factory proves open/watch/control all
          // retain this attempt's immutable target instead of mixing configs.
          store.sessions[0].portName = 'COM99';
          store.sessions[0].portConfig = { ...config, baudRate: 9_600, dtr: true };
          return new ControlledPort();
        },
      },
    ),
  );
  assert.ok(connection);
  assert.equal(await connection.start(), true);
  assert.deepEqual(targets, [{ path: 'COM12', baudRate: 57_600 }]);
  await connection.stop();
  detach();
  scope.stop();
});

test('workspace facade replacement validates before commit and emits no observer events', () => {
  const store = useSessionStore();
  const persistence = useSessionStore();
  const originalId = store.createSession('COM1', config);
  const observed: unknown[] = [];
  persistence.subscribeWorkspaceChanges((event) => observed.push(event));
  const duplicate = hydratedEntry(createSessionRecord('duplicate', '', config), 'One');

  assert.throws(() => store.replaceWorkspaceSessions([duplicate, duplicate], 'duplicate'));
  assert.equal(store.sessions[0].id, originalId);
  assert.deepEqual(observed, []);

  const first = hydratedEntry(createSessionRecord('first', '', config), 'First');
  const second = hydratedEntry(createSessionRecord('second', '', config), 'Second');
  store.replaceWorkspaceSessions([first, second], 'second');
  assert.deepEqual(
    store.sessions.map((session) => session.id),
    ['first', 'second'],
  );
  assert.equal(store.activeSessionId, 'second');
  assert.deepEqual(observed, []);
});

test('session, frame, capture, and catalog observers fire exactly once per successful mutation', () => {
  const store = useSessionStore();
  const persistence = useSessionStore();
  const events: Array<{ kind: string; sessionId?: string }> = [];
  const detachThrowing = persistence.subscribeWorkspaceChanges(() => {
    throw new Error('observer failure must be isolated');
  });
  persistence.subscribeWorkspaceChanges((event) => events.push(event));

  const sessionId = store.createSession('COM4', config);
  store.setSendDraft(sessionId, 'AT');
  store.addFrame(sessionId, { direction: 'RX', data: new Uint8Array([1]) });
  store.clearFrames(sessionId);

  assert.deepEqual(
    events.map((event) => event.kind),
    ['catalog-changed', 'session-changed', 'frame-added', 'capture-cleared'],
  );
  assert.ok(events.slice(1).every((event) => event.sessionId === sessionId));
  detachThrowing();
});

test('important deletion keeps a stopped undo snapshot and an ID collision never overwrites', async () => {
  const store = useSessionStore();
  const firstId = store.createSession('COM5', config);
  store.addFrame(firstId, { direction: 'RX', data: new Uint8Array([1, 2, 3]) });
  store.setConnected(firstId, true);

  const deleted = await store.removeSession(firstId);
  assert.ok(deleted);
  assert.equal(deleted.session.isConnected, false);
  assert.equal(deleted.session.frames.length, 1);
  assert.equal(store.sessions.length, 0);
  assert.deepEqual(store.undoLastRemovedSession(), { ok: true, sessionId: firstId });
  assert.equal(store.sessions[0].id, firstId);
  assert.equal(store.sessions[0].isConnected, false);

  await store.removeSession(firstId);
  const colliding = createSessionRecord(firstId, 'COM-conflict', config);
  // Simulate an external catalog reconciliation racing the undo action. The
  // public sessions array remains part of the compatibility facade, so undo
  // must still fail closed instead of overwriting the new aggregate.
  store.sessions.push(colliding);
  assert.deepEqual(store.undoLastRemovedSession(), { ok: false, reason: 'id-conflict' });
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].portName, 'COM-conflict');
});

test('SessionTabs links tabs to panels and presents a persistent undo action', async () => {
  const store = useSessionStore();
  const first = store.createSession('COM15', config);
  const wrapper = mount(SessionTabs);
  assert.equal(wrapper.get('[role="tab"]').attributes('aria-controls'), `session-panel-${first}`);

  await store.removeSession(first);
  await nextTick();
  assert.equal(wrapper.find('.undo-banner').exists(), true);
  await wrapper.get('.undo-action').trigger('click');
  assert.equal(store.sessions[0].id, first);
  assert.equal(wrapper.find('.undo-banner').exists(), false);
});

test('device profiles persist only normalized line settings and never a system path', () => {
  const profiles = addDeviceProfile([], '/dev/ttyUSB0', { ...config, baudRate: 9_600 });
  assert.equal(profiles.length, 1);
  assert.doesNotMatch(profiles[0].name, /^\//);
  assert.deepEqual(Object.keys(profiles[0].config).sort(), [
    'baudRate',
    'dataBits',
    'dtr',
    'flowControl',
    'parity',
    'rts',
    'rxFrameGapMs',
    'stopBits',
  ]);
  assert.doesNotMatch(localStorage.getItem('bbcom-device-profiles-v1') ?? '', /ttyUSB0/);
  assert.equal(loadDeviceProfiles()[0].config.baudRate, 9_600);
  assert.deepEqual(removeDeviceProfile(profiles, profiles[0].id), []);
});

function hydratedEntry(session: SerialSession, displayName: string): HydratedWorkspaceSession {
  return {
    session,
    sortOrder: 0,
    rebind: {
      required: true,
      displayName,
      kind: 'live',
      lastPortHint: { displayName },
    },
    waveform: { channels: [], samples: [], frameCursor: { consumed: 0, lastFrameId: null } },
  };
}

function toolbarProps(
  session: SerialSession,
  conflict?: { ownerSessionId: string; ownerSessionName: string; canonicalPort: string },
) {
  return {
    session,
    framesVersion: 0,
    isConnected: false,
    isConnecting: false,
    reconnecting: false,
    error: conflict ? 'conflict' : null,
    connectionConflict: conflict,
    totalDroppedBytes: 0,
    sendingBreak: false,
    isExporting: false,
    viewMode: 'terminal' as const,
  };
}

function buttonStub() {
  return {
    template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
  };
}
