import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type {
  HydrateWorkspaceAiMessagesRequest,
  HydrateWorkspaceCollectionsRequest,
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceSessionsRequest,
  HydrateWorkspaceWaveformRequest,
  WorkspaceMutation,
  WorkspaceSessionSnapshot,
} from '@/generated/ipc-contracts.ts';
import { IPC_LIMITS } from '@/generated/ipc-contracts.ts';
import { createSessionRecord } from '@/lib/session-persistence.ts';
import type { SerialSession } from '@/types/session.ts';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
  WorkspaceFrameMutationBuilder,
  hydrateWorkspaceFrame,
  hydrateWorkspaceSession,
  projectWorkspaceFrame,
  projectWorkspaceSessionMutations,
  stageWorkspaceHydration,
  toIpcFramePayload,
  type WorkspaceHydrationPort,
} from '@/features/workspace/adapters/index.ts';

const portConfig = {
  baudRate: 115200,
  dataBits: 8 as const,
  stopBits: 1 as const,
  parity: 'none' as const,
  flowControl: 'none' as const,
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function richSession(): SerialSession {
  return createSessionRecord('session-1', '/dev/ttyUSB0', portConfig, {
    isConnected: true,
    capturePaused: true,
    startTime: 123,
    autoLogEnabled: true,
    logPath: 'capture.log',
    droppedBytes: 99,
    sendDraft: '/drafts/AT+RESET',
    sendHistory: [{ data: '/history/AT', isHex: false }],
    quickCommands: [{ id: 'quick-1', name: 'Reset', data: '/quick/AA 55', isHex: true }],
    macros: [
      {
        id: 'macro-1',
        name: 'Boot',
        steps: [{ data: '/macro/boot', isHex: false, delayMs: 25 }],
      },
    ],
    triggers: [
      {
        id: 'trigger-1',
        name: 'Ready',
        enabled: true,
        matchMode: 'text',
        pattern: '/trigger/ready',
        response: '/response/ack',
        responseIsHex: false,
        cooldownMs: 500,
      },
    ],
    highlights: [
      {
        id: 'highlight-1',
        name: 'Errors',
        enabled: true,
        matchMode: 'text',
        pattern: '/highlight/ERROR',
        direction: 'RX',
        color: 'red',
      },
    ],
    parserState: {
      config: { kind: 'delimiter', delimiter: [13, 10], includeDelimiter: false },
      presetId: 'at-crlf',
    },
    modbusRegisters: [
      {
        id: 'register-1',
        name: 'Voltage',
        slaveAddress: 1,
        functionCode: 0x03,
        address: 10,
        quantity: 1,
        type: 'uint16',
        unit: 'V',
        waveformChannel: 0,
        value: 123,
        values: [123],
        valueTs: 999,
        periodicRead: true,
        periodicWrite: false,
      },
    ],
    modbusConfig: {
      transport: 'rtu',
      enabled: true,
      pollIntervalMs: 1000,
      writeIntervalMs: 1000,
      timeoutMs: 500,
    },
    waveformSourceMode: 'register',
    terminalAiModel: 'glm-5.1',
    logAiModel: 'glm-4.7',
    logAiContextMode: 'latest-n-frames',
    logAiFrameLimit: 400,
    logAiMessages: [
      { id: 'ai-1', role: 'user', content: '/var/log/device.log', timestamp: 1000 },
      { id: 'ai-2', role: 'assistant', content: 'looks good', timestamp: 1001 },
    ],
  });
}

function mutationOf<K extends WorkspaceMutation['kind']>(
  mutations: readonly WorkspaceMutation[],
  kind: K,
): Extract<WorkspaceMutation, { kind: K }> {
  const mutation = mutations.find((candidate) => candidate.kind === kind);
  assert.ok(mutation, `missing ${kind} mutation`);
  return mutation as Extract<WorkspaceMutation, { kind: K }>;
}

function roundTripParts(projection: ReturnType<typeof projectWorkspaceSessionMutations>) {
  const mutations = projection.mutations;
  const upsert = mutationOf(mutations, 'upsert-session');
  const features = mutations.filter(
    (mutation): mutation is Extract<WorkspaceMutation, { kind: 'upsert-feature-state' }> =>
      mutation.kind === 'upsert-feature-state',
  );
  const feature = (kind: 'preferences' | 'parser' | 'modbus' | 'waveform' | 'shell' | 'mcumgr') => {
    const found = features.find((mutation) => mutation.payload.feature === kind);
    assert.ok(found);
    return found.payload.state;
  };
  return {
    snapshot: {
      id: upsert.sessionId,
      sortOrder: upsert.payload.sortOrder,
      kind: upsert.payload.kind,
      name: upsert.payload.name,
      needsRebind: true,
      lastPortHint: upsert.payload.lastPortHint ?? null,
      portConfig: upsert.payload.portConfig,
      document: upsert.payload.document,
      displayPreferences: feature('waveform'),
      sendPreferences: feature('shell'),
      parserState: feature('parser'),
      featureState: feature('preferences'),
      modbusConfig: feature('modbus'),
      mcumgrConfig: feature('mcumgr'),
    } satisfies WorkspaceSessionSnapshot,
    collections: mutationOf(mutations, 'replace-session-collections').payload,
    aiMessages: mutations
      .filter(
        (mutation): mutation is Extract<WorkspaceMutation, { kind: 'append-ai-messages' }> =>
          mutation.kind === 'append-ai-messages',
      )
      .flatMap((mutation) => mutation.payload.messages),
    waveformChannels:
      mutations.find(
        (mutation): mutation is Extract<WorkspaceMutation, { kind: 'replace-waveform-channels' }> =>
          mutation.kind === 'replace-waveform-channels',
      )?.payload.channels ?? [],
    waveformSamples: mutations
      .filter(
        (mutation): mutation is Extract<WorkspaceMutation, { kind: 'append-waveform-samples' }> =>
          mutation.kind === 'append-waveform-samples',
      )
      .flatMap((mutation) => mutation.payload.samples),
  };
}

test('session projection covers every persisted feature and strips all runtime state', () => {
  const session = richSession();
  const projection = projectWorkspaceSessionMutations(session, {
    sequenceStart: 10,
    sortOrder: 3,
    name: 'Bench supply',
    kind: 'live',
    lastPortHint: {
      displayName: 'USB UART',
      vendorId: 0x1234,
      productId: 0x5678,
      usbSerial: 'SERIAL-1',
    },
    waveform: {
      channels: [{ channelIndex: 0, config: { label: 'Voltage', color: 'blue', visible: false } }],
      samples: [{ channelIndex: 0, seq: 0, timestampMs: 1000, value: 12.5 }],
      frameCursor: { consumed: 1, lastFrameId: 'frame-1' },
    },
  });

  assert.deepEqual(
    projection.mutations.map((mutation) => mutation.kind),
    [
      'upsert-session',
      'upsert-feature-state',
      'upsert-feature-state',
      'upsert-feature-state',
      'upsert-feature-state',
      'upsert-feature-state',
      'upsert-feature-state',
      'replace-session-collections',
      'clear-ai-messages',
      'replace-waveform-channels',
      'append-ai-messages',
      'append-waveform-samples',
    ],
  );
  assert.deepEqual(
    projection.mutations.map((mutation) => mutation.sequence),
    [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  );
  assert.equal(projection.nextSequence, 22);

  const withoutWaveformSidecar = projectWorkspaceSessionMutations(session, {
    sequenceStart: 0,
    sortOrder: 3,
    name: 'Bench supply',
  });
  assert.equal(
    withoutWaveformSidecar.mutations.some(
      (mutation) =>
        mutation.kind === 'replace-waveform-channels' ||
        mutation.kind === 'append-waveform-samples',
    ),
    false,
    'omitting the sidecar must not erase persisted waveform rows',
  );

  const serialized = JSON.stringify(projection.mutations);
  for (const forbidden of [
    '/dev/ttyUSB0',
    'isConnected',
    'capturePaused',
    'startTime',
    'logPath',
    'autoLogEnabled',
    'droppedBytes',
    'valueTs',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `runtime field leaked: ${forbidden}`);
  }
  assert.equal(serialized.includes('/var/log/device.log'), true);
  assert.equal(serialized.includes('trigger-1'), true);
  assert.equal(serialized.includes('quick-1'), true);
  assert.equal(serialized.includes('macro-1'), true);
  assert.equal(serialized.includes('highlight-1'), true);
  assert.equal(serialized.includes('register-1'), true);

  const parts = roundTripParts(projection);
  const hydrated = hydrateWorkspaceSession(parts.snapshot, {
    frames: [
      {
        seq: 0,
        id: 'frame-rx',
        direction: 'RX',
        timestampMs: 2000,
        data: [1, 2, 3],
      },
      {
        seq: 1,
        id: 'frame-tx',
        direction: 'TX',
        timestampMs: 2001,
        data: [4, 5],
        txStatus: 'complete',
        requestedBytes: 2,
      },
    ],
    collections: parts.collections,
    aiMessages: parts.aiMessages,
    waveformChannels: parts.waveformChannels.map((channel) => ({
      ...channel,
      config: { ...channel.config, visible: true },
    })),
    waveformSamples: parts.waveformSamples,
  });

  assert.equal(hydrated.session.portName, '');
  assert.equal(hydrated.session.isConnected, false);
  assert.equal(hydrated.session.capturePaused, false);
  assert.equal(hydrated.session.startTime, null);
  assert.equal(hydrated.session.logPath, null);
  assert.equal(hydrated.session.autoLogEnabled, false);
  assert.equal(hydrated.session.droppedBytes, 0);
  assert.deepEqual(hydrated.session.sendHistory, session.sendHistory);
  assert.deepEqual(hydrated.session.quickCommands, session.quickCommands);
  assert.deepEqual(hydrated.session.macros, session.macros);
  assert.deepEqual(hydrated.session.triggers, session.triggers);
  assert.deepEqual(hydrated.session.highlights, session.highlights);
  assert.deepEqual(hydrated.session.logAiMessages, session.logAiMessages);
  assert.deepEqual(hydrated.session.shellConfig, session.shellConfig);
  assert.equal(hydrated.session.modbusRegisters[0]?.value, null);
  assert.equal(hydrated.session.modbusRegisters[0]?.values, null);
  assert.equal(hydrated.session.modbusRegisters[0]?.valueTs, null);
  assert.deepEqual(
    hydrated.session.frames.map((frame) => Array.from(frame.data)),
    [
      [1, 2, 3],
      [4, 5],
    ],
  );
  assert.deepEqual(hydrated.rebind, {
    required: true,
    displayName: 'USB UART',
    kind: 'live',
    lastPortHint: {
      displayName: 'USB UART',
      vendorId: 0x1234,
      productId: 0x5678,
      usbSerial: 'SERIAL-1',
    },
  });
  assert.deepEqual(hydrated.waveform.samples, [
    { channelIndex: 0, seq: 0, timestampMs: 1000, value: 12.5 },
  ]);
  assert.equal(hydrated.waveform.channels[0]?.config.visible, false);
  assert.deepEqual(hydrated.waveform.frameCursor, { consumed: 1, lastFrameId: 'frame-1' });
});

test('legacy text waveform state forces one retained-frame rebuild', () => {
  const session = richSession();
  session.waveformSourceMode = 'text';
  const projection = projectWorkspaceSessionMutations(session, {
    sequenceStart: 0,
    sortOrder: 0,
    name: 'Legacy waveform',
  });
  const parts = roundTripParts(projection);
  const hydrated = hydrateWorkspaceSession(parts.snapshot, {
    frames: [{ seq: 0, id: 'legacy-frame', direction: 'RX', timestampMs: 1, data: [49] }],
    collections: parts.collections,
    aiMessages: parts.aiMessages,
    waveformChannels: parts.waveformChannels,
    waveformSamples: parts.waveformSamples,
  });

  assert.deepEqual(hydrated.waveform.frameCursor, { consumed: 2, lastFrameId: null });
});

test('projection preserves opaque path-like content but rejects paths in structured display/config fields', () => {
  const withSecret = richSession() as SerialSession & { apiKey?: string };
  withSecret.apiKey = 'do-not-store';
  assert.throws(
    () =>
      projectWorkspaceSessionMutations(withSecret, {
        sequenceStart: 0,
        sortOrder: 0,
        name: 'Session',
      }),
    WorkspaceAdapterValidationError,
  );

  const opaqueProjection = projectWorkspaceSessionMutations(richSession(), {
    sequenceStart: 0,
    sortOrder: 0,
    name: 'Session',
  });
  const opaqueParts = roundTripParts(opaqueProjection);
  const opaqueHydrated = hydrateWorkspaceSession(opaqueParts.snapshot, {
    frames: [],
    collections: opaqueParts.collections,
    aiMessages: opaqueParts.aiMessages,
    waveformChannels: opaqueParts.waveformChannels,
    waveformSamples: opaqueParts.waveformSamples,
  });
  assert.equal(opaqueHydrated.session.sendDraft, '/drafts/AT+RESET');
  assert.equal(opaqueHydrated.session.sendHistory[0]?.data, '/history/AT');
  assert.equal(opaqueHydrated.session.quickCommands[0]?.data, '/quick/AA 55');
  assert.equal(opaqueHydrated.session.macros[0]?.steps[0]?.data, '/macro/boot');
  assert.equal(opaqueHydrated.session.triggers[0]?.pattern, '/trigger/ready');
  assert.equal(opaqueHydrated.session.triggers[0]?.response, '/response/ack');
  assert.equal(opaqueHydrated.session.highlights[0]?.pattern, '/highlight/ERROR');
  assert.equal(opaqueHydrated.session.logAiMessages[0]?.content, '/var/log/device.log');

  const opaqueFromStorage = hydrateWorkspaceSession(
    {
      ...opaqueParts.snapshot,
      document: { ...opaqueParts.snapshot.document, sendDraft: '/storage/draft' },
    },
    {
      frames: [],
      collections: {
        ...opaqueParts.collections,
        sendHistory: [{ data: '/storage/history', isHex: false }],
        quickCommands: [
          { id: 'stored-quick', name: 'Stored', data: '/storage/quick', isHex: false },
        ],
        macros: [
          {
            id: 'stored-macro',
            name: 'Stored',
            steps: [{ data: '/storage/macro', isHex: false, delayMs: 0 }],
          },
        ],
        triggers: [
          {
            id: 'stored-trigger',
            config: {
              name: 'Stored',
              enabled: true,
              matchMode: 'text',
              pattern: '/storage/pattern',
              response: '/storage/response',
              responseIsHex: false,
              cooldownMs: 0,
            },
          },
        ],
        highlights: [],
      },
      aiMessages: [
        {
          id: 'stored-ai',
          role: 'user',
          content: '/storage/ai-content',
          timestampMs: 1,
        },
      ],
      waveformChannels: [],
      waveformSamples: [],
    },
  );
  assert.equal(opaqueFromStorage.session.sendDraft, '/storage/draft');
  assert.equal(opaqueFromStorage.session.sendHistory[0]?.data, '/storage/history');
  assert.equal(opaqueFromStorage.session.quickCommands[0]?.data, '/storage/quick');
  assert.equal(opaqueFromStorage.session.macros[0]?.steps[0]?.data, '/storage/macro');
  assert.equal(opaqueFromStorage.session.triggers[0]?.pattern, '/storage/pattern');
  assert.equal(opaqueFromStorage.session.triggers[0]?.response, '/storage/response');
  assert.equal(opaqueFromStorage.session.logAiMessages[0]?.content, '/storage/ai-content');

  assert.throws(
    () =>
      projectWorkspaceSessionMutations(richSession(), {
        sequenceStart: 0,
        sortOrder: 0,
        name: '/home/user/private.txt',
      }),
    WorkspaceAdapterValidationError,
  );

  assert.throws(
    () =>
      projectWorkspaceSessionMutations(richSession(), {
        sequenceStart: 0,
        sortOrder: 0,
        name: 'Session',
        waveform: {
          channels: [{ channelIndex: 0, config: { grantToken: 'native-grant' } }],
          samples: [],
          frameCursor: { consumed: 0, lastFrameId: null },
        },
      }),
    WorkspaceAdapterValidationError,
  );

  assert.throws(
    () =>
      hydrateWorkspaceFrame({
        seq: 0,
        id: 'unsafe-frame',
        direction: 'RX',
        timestampMs: 1,
        data: [1],
        grantToken: 'native-grant',
      } as never),
    WorkspaceAdapterValidationError,
  );

  const oversizedAi = richSession();
  oversizedAi.logAiMessages = [
    {
      id: 'oversized-ai',
      role: 'user',
      content: 'x'.repeat(IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGE_BYTES + 1),
      timestamp: 1,
    },
  ];
  assert.throws(
    () =>
      projectWorkspaceSessionMutations(oversizedAi, {
        sequenceStart: 0,
        sortOrder: 0,
        name: 'Session',
      }),
    WorkspaceAdapterValidationError,
  );

  const clean = projectWorkspaceSessionMutations(richSession(), {
    sequenceStart: 0,
    sortOrder: 0,
    name: 'Session',
  });
  const parts = roundTripParts(clean);
  assert.throws(
    () =>
      hydrateWorkspaceSession(
        { ...parts.snapshot, pluginState: { secret: 'opaque' } } as WorkspaceSessionSnapshot,
        {
          frames: [],
          collections: parts.collections,
          aiMessages: parts.aiMessages,
          waveformChannels: [],
          waveformSamples: [],
        },
      ),
    WorkspaceAdapterValidationError,
  );
});

function frame(id: string, bytes: number, timestamp = 1) {
  return {
    id,
    direction: 'RX' as const,
    timestamp,
    data: new Uint8Array(bytes).fill(1),
  };
}

test('frame projection accepts and strips runtime capture identity metadata', () => {
  const captured = {
    ...frame('captured-frame', 3, 42),
    captureSeq: 7,
    origin: 'mcumgr-trace' as const,
  };

  const projected = projectWorkspaceFrame(captured);

  assert.deepEqual(projected, {
    id: 'captured-frame',
    direction: 'RX',
    timestampMs: 42,
    data: captured.data,
  });
  assert.equal('captureSeq' in projected, false);
  assert.equal('origin' in projected, false);
});

test('frame builder flushes on time/count/bytes and rejects limits before mutating pending state', () => {
  const builder = new WorkspaceFrameMutationBuilder({
    sessionId: 'session-frames',
    startSequence: 5,
    startFrameSeq: 10,
    totals: { workspaceFrameCount: 0, sessionFrameCount: 0, workspacePayloadBytes: 0 },
    policy: { maxFrames: 2, maxPayloadBytes: 5 },
  });
  assert.equal(builder.append(frame('f1', 3), 100).mutations.length, 0);
  const boundary = builder.append(frame('f2', 3), 101);
  assert.equal(boundary.mutations.length, 1, 'byte boundary flushes the prior complete batch');
  assert.deepEqual(
    mutationOf(boundary.mutations, 'append-frames').payload.frames.map((item) => item.id),
    ['f1'],
  );
  // The single conversion site emits the base64 IPC channel, never a boxed
  // number array.
  const emitted = mutationOf(boundary.mutations, 'append-frames').payload.frames[0];
  assert.deepEqual(emitted.data, []);
  assert.equal(typeof emitted.dataB64, 'string');
  assert.equal(emitted.dataB64.length, 4, 'three payload bytes encode to one base64 group');
  const count = builder.append(frame('f3', 2), 102);
  assert.deepEqual(
    mutationOf(count.mutations, 'append-frames').payload.frames.map((item) => item.id),
    ['f2', 'f3'],
  );
  assert.deepEqual(
    count.mutations.map((mutation) => mutation.sequence),
    [6],
  );
  assert.deepEqual(builder.snapshotTotals(), {
    workspaceFrameCount: 3,
    sessionFrameCount: 3,
    workspacePayloadBytes: 8,
  });

  const timed = new WorkspaceFrameMutationBuilder({
    sessionId: 'session-timed',
    startSequence: 0,
    startFrameSeq: 0,
    totals: { workspaceFrameCount: 0, sessionFrameCount: 0, workspacePayloadBytes: 0 },
  });
  timed.append(frame('timed-1', 1), 1000);
  assert.equal(timed.flushDue(1249).mutations.length, 0);
  assert.equal(timed.flushDue(1250).mutations.length, 1);

  const large = new WorkspaceFrameMutationBuilder({
    sessionId: 'session-large',
    startSequence: 0,
    startFrameSeq: 0,
    totals: { workspaceFrameCount: 0, sessionFrameCount: 0, workspacePayloadBytes: 0 },
  });
  assert.equal(large.append(frame('large-1', 512 * 1024 + 1), 0).mutations.length, 1);
  assert.throws(
    () => large.append(frame('too-large', IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES + 1), 1),
    WorkspaceAdapterLimitError,
  );

  const full = new WorkspaceFrameMutationBuilder({
    sessionId: 'session-full',
    startSequence: 0,
    startFrameSeq: 0,
    totals: {
      workspaceFrameCount: IPC_LIMITS.MAX_WORKSPACE_FRAMES - 1,
      sessionFrameCount: 0,
      workspacePayloadBytes: 0,
    },
  });
  full.append(frame('last-frame', 1), 0);
  const totalsBeforeReject = full.snapshotTotals();
  assert.throws(() => full.append(frame('one-too-many', 1), 1), WorkspaceAdapterLimitError);
  assert.deepEqual(full.snapshotTotals(), totalsBeforeReject);
  assert.deepEqual(
    mutationOf(full.flush(), 'append-frames').payload.frames.map((item) => item.id),
    ['last-frame'],
  );
});

test('frame adapter round-trips bytes over the base64 IPC channel', () => {
  const payload = toIpcFramePayload({
    id: 'frame-b64',
    direction: 'TX',
    timestampMs: 42,
    data: new Uint8Array([0, 1, 2, 254, 255]),
    txStatus: 'complete',
    requestedBytes: 5,
  });
  assert.deepEqual(payload.data, []);
  assert.equal(payload.dataB64, 'AAEC/v8=');
  assert.equal(payload.txStatus, 'complete');

  const hydrated = hydrateWorkspaceFrame({
    seq: 0,
    id: 'frame-b64',
    direction: 'TX',
    timestampMs: 42,
    data: [],
    dataB64: payload.dataB64,
    txStatus: 'complete',
    requestedBytes: 5,
  });
  assert.deepEqual(Array.from(hydrated.data), [0, 1, 2, 254, 255]);
  assert.equal(hydrated.captureSeq, 0);

  assert.throws(
    () =>
      hydrateWorkspaceFrame({
        seq: 0,
        id: 'frame-both',
        direction: 'RX',
        timestampMs: 1,
        data: [1],
        dataB64: 'AQ==',
      }),
    WorkspaceAdapterValidationError,
  );
});

function stagedSnapshot(): WorkspaceSessionSnapshot {
  const projection = projectWorkspaceSessionMutations(richSession(), {
    sequenceStart: 0,
    sortOrder: 0,
    name: 'Staged session',
    lastPortHint: { displayName: 'USB serial', usbSerial: 'DEVICE-1' },
  });
  return roundTripParts(projection).snapshot;
}

function hydrationPort(failAiSecondPage = false): WorkspaceHydrationPort {
  const snapshot = stagedSnapshot();
  const parts = roundTripParts(
    projectWorkspaceSessionMutations(richSession(), {
      sequenceStart: 0,
      sortOrder: 0,
      name: 'Staged session',
    }),
  );
  return {
    hydrateSessions: vi.fn(async (request: HydrateWorkspaceSessionsRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      revision: 7,
      sessions: request.offset === 0 ? [snapshot] : [],
    })),
    hydrateFrames: vi.fn(async (request: HydrateWorkspaceFramesRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      frames:
        request.fromSeq === 0
          ? [{ seq: 0, id: 'stage-f1', direction: 'RX' as const, timestampMs: 1, data: [1] }]
          : [{ seq: 2, id: 'stage-f2', direction: 'RX' as const, timestampMs: 2, data: [2] }],
      ...(request.fromSeq === 0 ? { nextSeq: 2 } : {}),
    })),
    hydrateCollections: vi.fn(async (request: HydrateWorkspaceCollectionsRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      collections: parts.collections,
    })),
    hydrateAiMessages: vi.fn(async (request: HydrateWorkspaceAiMessagesRequest) => {
      if (failAiSecondPage && request.offset === 1) throw new Error('AI page failed');
      return {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: 7,
        messages: request.offset === 0 ? [parts.aiMessages[0]] : [parts.aiMessages[1]],
        ...(request.offset === 0 ? { nextOffset: 1 } : {}),
      };
    }),
    hydrateWaveform: vi.fn(async (request: HydrateWorkspaceWaveformRequest) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      revision: 7,
      channels: [{ channelIndex: 0, config: { label: 'Voltage' } }],
      samples:
        request.offset === 0
          ? [{ channelIndex: 0, seq: 0, timestampMs: 1, value: 1.5 }]
          : [{ channelIndex: 0, seq: 1, timestampMs: 2, value: 2.5 }],
      ...(request.offset === 0 ? { nextOffset: 1 } : {}),
    })),
  };
}

test('aggregate hydration stages every page and rejects the entire staging graph on one page failure', async () => {
  let requestSequence = 0;
  const port = hydrationPort();
  const staged = await stageWorkspaceHydration({
    port,
    workspaceId: 'workspace-1',
    revision: 7,
    activeSessionId: 'session-1',
    requestId: () => `request-${requestSequence++}`,
    framePageSize: 1,
    aiPageSize: 1,
    waveformPageSize: 1,
  });
  assert.equal(staged.sessions.length, 1);
  assert.equal(staged.sessions[0]?.session.frames.length, 2);
  assert.equal(staged.sessions[0]?.session.logAiMessages.length, 2);
  assert.equal(staged.sessions[0]?.waveform.samples.length, 2);
  assert.equal(staged.sessions[0]?.session.isConnected, false);
  assert.equal(staged.sessions[0]?.rebind.required, true);

  const currentState = Object.freeze({ marker: 'untouched-current-workspace' });
  const referenceBefore = currentState;
  await assert.rejects(
    stageWorkspaceHydration({
      port: hydrationPort(true),
      workspaceId: 'workspace-1',
      revision: 7,
      requestId: () => `failure-${requestSequence++}`,
      aiPageSize: 1,
      waveformPageSize: 1,
    }),
    /AI page failed/,
  );
  assert.strictEqual(
    currentState,
    referenceBefore,
    'staging has no live-state replacement callback',
  );
});

test('aggregate hydration rejects revision drift and malformed pagination cursors', async () => {
  const drifting = hydrationPort();
  drifting.hydrateCollections = async (request) => ({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    revision: 8,
    collections: roundTripParts(
      projectWorkspaceSessionMutations(richSession(), {
        sequenceStart: 0,
        sortOrder: 0,
        name: 'Session',
      }),
    ).collections,
  });
  await assert.rejects(
    stageWorkspaceHydration({
      port: drifting,
      workspaceId: 'workspace-1',
      revision: 7,
      requestId: () => crypto.randomUUID(),
    }),
    WorkspaceAdapterValidationError,
  );

  const looping = hydrationPort();
  looping.hydrateAiMessages = async (request) => ({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    revision: 7,
    messages: [],
    nextOffset: request.offset,
  });
  await assert.rejects(
    stageWorkspaceHydration({
      port: looping,
      workspaceId: 'workspace-1',
      revision: 7,
      requestId: () => crypto.randomUUID(),
    }),
    WorkspaceAdapterValidationError,
  );
});
