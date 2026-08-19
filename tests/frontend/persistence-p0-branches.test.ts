import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { computed, ref } from 'vue';
import { test } from 'vitest';

import { SessionMutationRevisionTracker } from '../../src/features/sessions/persistence/session-mutation-revision-tracker.ts';
import { SessionApplicationService } from '../../src/features/sessions/session-application-service.ts';
import {
  createSessionRecord,
  hydrateSession,
  migratePersistedFile,
  normalizePersistedMruSessionIds,
} from '../../src/lib/session-persistence.ts';
import {
  appendFrameToSession,
  appendIdentifiedItem,
  flushPausedFramesToLive,
  trimSessionsToGlobalByteLimit,
} from '../../src/lib/session-store-helpers.ts';
import { useSessionCoreStore } from '../../src/stores/session-core.ts';
import type { PortConfig } from '../../src/types/index.ts';
import { frame } from './helpers/frames.ts';

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

test('portable persistence preserves owned contributions and exhausts bounded MRU input', () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({ id: `session-${index}` }));
  assert.equal(
    normalizePersistedMruSessionIds(
      sessions,
      null,
      sessions.map((session) => session.id),
    ).length,
    8,
  );
  assert.deepEqual(
    migratePersistedFile({
      version: 2,
      activeSessionId: null,
      mruSessionIds: [7, 'session'],
      sessions: [{ id: 'session', portName: 'COM-migrated', portConfig: config }],
    }).mruSessionIds,
    ['session'],
  );

  const hydrated = hydrateSession(
    {
      id: 'owned',
      portName: 'COM-owned',
      quickCommands: [
        {
          id: 'plugin:dev.bbcom.fixture:quick',
          ownerPluginId: 'dev.bbcom.fixture',
          name: 'Quick',
          data: 'AA',
        },
      ],
      macros: [
        {
          id: 'plugin:dev.bbcom.fixture:macro',
          ownerPluginId: 'dev.bbcom.fixture',
          name: 'Macro',
          steps: [{ data: 'BB' }],
        },
      ],
      highlights: [{ id: 'highlight', name: 'Highlight', pattern: 'ok', color: 'unsupported' }],
    },
    { createId: () => 'generated', now: () => 1 },
  );
  assert.ok(hydrated);
  assert.equal(hydrated.quickCommands[0].ownerPluginId, 'dev.bbcom.fixture');
  assert.equal(hydrated.macros[0].ownerPluginId, 'dev.bbcom.fixture');
  assert.equal(hydrated.highlights[0].color, 'amber');
});

test('frame trimming terminates safely when supplied byte totals exceed retained buffers', () => {
  const appended = createSessionRecord('append', 'COM-append', config);
  assert.deepEqual(
    appendFrameToSession(appended, frame('incoming', 'RX', [1]), -1, {
      trimThreshold: 0,
      currentBytes: 10,
      maxBytes: 0,
    }),
    { retainedBytes: 10, droppedBytes: 1, droppedFrames: 1 },
  );
  assert.deepEqual(appended.frames, []);

  const paused = createSessionRecord('paused', 'COM-paused', config, {
    pausedFrames: [frame('held', 'RX', [1])],
  });
  assert.deepEqual(flushPausedFramesToLive(paused, 10, { currentBytes: 10, maxBytes: 0 }), {
    retainedBytes: 9,
    droppedBytes: 1,
    droppedFrames: 1,
  });

  const empty = createSessionRecord('empty', 'COM-empty', config);
  assert.deepEqual(trimSessionsToGlobalByteLimit([empty], 1, 0), {
    retainedBytes: 0,
    droppedBytesBySession: new Map(),
    droppedFramesBySession: new Map(),
  });

  const invalidTimestamp = createSessionRecord('nan', 'COM-nan', config, {
    frames: [{ ...frame('nan-frame', 'RX', [1]), timestamp: Number.NaN }],
  });
  assert.equal(trimSessionsToGlobalByteLimit([invalidTimestamp], 1, 0).retainedBytes, 0);

  const identified: Array<{ id: string; title: string }> = [];
  const id = appendIdentifiedItem(identified, { title: 'generated' });
  assert.equal(identified[0].id, id);
});

test('revision tracker exposes both aggregate and per-session durability branches', () => {
  const tracker = new SessionMutationRevisionTracker();
  assert.equal(tracker.currentRevision(), 0);
  assert.equal(tracker.isDirty(), false);
  assert.equal(tracker.markDirty(), 1);
  assert.equal(tracker.isDirty(), false);
  assert.equal(tracker.markDirty('session'), 2);
  assert.equal(tracker.currentRevision(), 2);
  assert.equal(tracker.isDirty(), true);
  assert.equal(tracker.isDirty('session'), true);
  tracker.clearDirty('session');
  assert.equal(tracker.isDirty('session'), false);
  tracker.markDirty('session');
  tracker.markDurable();
  assert.equal(tracker.isDirty(), false);
  tracker.markDirty('session');
  tracker.reset();
  assert.equal(tracker.isDirty(), false);
});

test('session application service fails closed for disabled or missing capture mutations', async () => {
  const allowed = ref(false);
  const session = createSessionRecord('session', 'COM-session', config);
  const sessions = ref([session]);
  let clearCalls = 0;
  let createCalls = 0;
  let removeCalls = 0;
  const captureSession = ref<typeof session | null>(session);
  const service = new SessionApplicationService({
    catalog: {
      sessions,
      create: () => {
        createCalls += 1;
        return 'created';
      },
      remove: async () => {
        removeCalls += 1;
        return null;
      },
    } as never,
    mutationPolicy: { userMutationsAllowed: allowed } as never,
    captureFor: () =>
      ({
        session: computed(() => captureSession.value),
        clear: () => {
          clearCalls += 1;
        },
      }) as never,
    documentFor: () => ({ isDirty: computed(() => false) }) as never,
    runtimeIsImportant: () => false,
  });

  assert.equal(service.createSession('', config), null);
  assert.equal(service.createSession('COM-blocked', config), null);
  assert.equal(await service.remove('session'), false);
  assert.equal(service.clearCapture('session'), false);
  assert.equal(createCalls, 0);
  assert.equal(removeCalls, 0);
  assert.equal(clearCalls, 0);

  allowed.value = true;
  assert.equal(service.createSession('COM-created', config), 'created');
  assert.equal(createCalls, 1);
  assert.equal(await service.remove('session'), false);
  assert.equal(removeCalls, 1);
  assert.equal(service.clearCapture('session'), false);
  captureSession.value = null;
  assert.equal(service.clearCapture('session'), false);

  captureSession.value = session;
  session.frames.push(frame('captured', 'RX', [1]));
  assert.equal(service.clearCapture('session'), true);
  assert.equal(clearCalls, 1);
});

test('runtime-only sessions use the dedicated creation and teardown paths', async () => {
  setActivePinia(createPinia());
  const sessions = useSessionCoreStore();
  const id = sessions.createRuntimeSession('COM-runtime', config, 'Runtime');
  assert.ok(id);
  assert.equal(sessions.isPersistentSession(id), false);
  assert.ok(await sessions.removeRuntimeSession(id));
  assert.equal(
    sessions.sessions.some((session) => session.id === id),
    false,
  );
  assert.equal(await sessions.removeRuntimeSession(id), null);
});
