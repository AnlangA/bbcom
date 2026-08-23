import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type {
  HydrateWorkspaceSessionsRequest,
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceCollectionsRequest,
  HydrateWorkspaceAiMessagesRequest,
  HydrateWorkspaceWaveformRequest,
  WorkspaceHydrationPort,
} from '@/features/workspace/adapters/workspace-hydration-staging.ts';
import { stageWorkspaceHydration } from '@/features/workspace/adapters/workspace-hydration-staging.ts';
import { projectWorkspaceSessionMutations } from '@/features/workspace/adapters/workspace-session-adapter.ts';
import { createSessionRecord } from '@/lib/session-persistence.ts';

function sessionSnapshot() {
  const record = createSessionRecord('session-1', '/dev/ttyUSB0', portConfig);
  const projection = projectWorkspaceSessionMutations(record, {
    sequenceStart: 0,
    sortOrder: 0,
    name: 'Paged session',
  });
  const mutations = projection.mutations;
  const upsert = mutations.find(
    (mutation): mutation is Extract<typeof mutation, { kind: 'upsert-session' }> =>
      mutation.kind === 'upsert-session',
  );
  assert.ok(upsert);
  const featureState = (
    feature: 'preferences' | 'parser' | 'modbus' | 'waveform' | 'shell' | 'mcumgr',
  ) => {
    const found = mutations.find(
      (mutation): mutation is Extract<typeof mutation, { kind: 'upsert-feature-state' }> =>
        mutation.kind === 'upsert-feature-state' && mutation.payload.feature === feature,
    );
    assert.ok(found);
    return found.payload.state;
  };
  const collections = mutations.find(
    (mutation): mutation is Extract<typeof mutation, { kind: 'replace-session-collections' }> =>
      mutation.kind === 'replace-session-collections',
  );
  assert.ok(collections);
  return {
    collections: collections.payload,
    snapshot: {
      id: upsert.sessionId,
      sortOrder: upsert.payload.sortOrder,
      kind: upsert.payload.kind,
      name: upsert.payload.name,
      needsRebind: true,
      lastPortHint: null,
      portConfig: upsert.payload.portConfig,
      document: upsert.payload.document,
      displayPreferences: featureState('waveform'),
      sendPreferences: featureState('shell'),
      parserState: featureState('parser'),
      featureState: featureState('preferences'),
      modbusConfig: featureState('modbus'),
      mcumgrConfig: featureState('mcumgr'),
    },
  };
}

const portConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none' as const,
  flowControl: 'none' as const,
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

const TOTAL_FRAMES = 100_000;

/** Fabricates `limit`-sized frame pages until TOTAL_FRAMES are served. */
function pagingPort() {
  const { snapshot, collections } = sessionSnapshot();
  let served = 0;
  const port: WorkspaceHydrationPort = {
    hydrateSessions: vi.fn(async (request: HydrateWorkspaceSessionsRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      revision: 7,
      sessions: request.offset === 0 ? [snapshot] : [],
    })),
    hydrateFrames: vi.fn(async (request: HydrateWorkspaceFramesRequest) => {
      const pageSize = Math.min(request.limit, TOTAL_FRAMES - served);
      const frames = Array.from({ length: pageSize }, (_, index) => ({
        seq: served + index,
        id: `frame-${served + index}`,
        direction: 'RX' as const,
        timestampMs: served + index,
        data: [],
      }));
      served += pageSize;
      return {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: 7,
        frames,
        ...(served < TOTAL_FRAMES ? { nextSeq: served } : {}),
      };
    }),
    hydrateCollections: vi.fn(async (request: HydrateWorkspaceCollectionsRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      collections,
    })),
    hydrateAiMessages: vi.fn(async (request: HydrateWorkspaceAiMessagesRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      messages: [],
    })),
    hydrateWaveform: vi.fn(async (request: HydrateWorkspaceWaveformRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      channels: [],
      samples: [],
    })),
  };
  return { port, hydrateFrames: port.hydrateFrames as ReturnType<typeof vi.fn> };
}

test('default frame page size hydrates a 100k-frame session in at most 50 round trips', async () => {
  const { port, hydrateFrames } = pagingPort();
  let requestSequence = 0;
  const staged = await stageWorkspaceHydration({
    port,
    workspaceId: 'workspace-1',
    revision: 7,
    activeSessionId: 'session-1',
    requestId: () => `request-${requestSequence++}`,
  });

  const calls = hydrateFrames.mock.calls.length;
  const requestedLimits = hydrateFrames.mock.calls.map(
    (call) => (call[0] as HydrateWorkspaceFramesRequest).limit,
  );
  assert.equal(staged.sessions[0]?.session.frames.length, TOTAL_FRAMES);
  assert.ok(calls <= 50, `expected at most 50 frame round trips, used ${calls}`);
  assert.ok(
    requestedLimits.every((limit) => limit === 2048),
    `default frame page size must be 2048, saw ${[...new Set(requestedLimits)].join(',')}`,
  );
  // Math.ceil(100000 / 2048) — the byte cap never trips for empty payloads.
  assert.equal(calls, 49);
});

test('frame page size outside the raised backend bound is rejected, 2048 accepted', async () => {
  let requestSequence = 0;
  const base = {
    port: pagingPort().port,
    workspaceId: 'workspace-1',
    revision: 7,
    activeSessionId: 'session-1',
    requestId: () => `request-${requestSequence++}`,
  };
  await assert.rejects(
    stageWorkspaceHydration({ ...base, framePageSize: 4096 }),
    /framePageSize/,
    'oversized page requests must fail fast, matching existing bounds behavior',
  );
  const { port, hydrateFrames } = pagingPort();
  await stageWorkspaceHydration({ ...base, port, framePageSize: 2048 });
  const requestedLimits = hydrateFrames.mock.calls.map(
    (call) => (call[0] as HydrateWorkspaceFramesRequest).limit,
  );
  assert.ok(requestedLimits.every((limit) => limit === 2048));
});
