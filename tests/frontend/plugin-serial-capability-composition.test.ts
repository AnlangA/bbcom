import { describe, expect, test, vi } from 'vitest';

import { createPluginSerialCapabilityGateway } from '../../src/features/plugins/application/plugin-serial-capability-composition.ts';
import type {
  PluginHostV2GatewayContext,
  PluginSerialCapabilityCoordinator,
} from '../../src/features/plugins/application/plugin-serial-capability-gateway.ts';
import type {
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceFramesResponse,
  WorkspaceHydratedFrame,
} from '../../src/generated/ipc-contracts.ts';
import { bytesToBase64 } from '../../src/lib/base64.ts';
import { createSessionRecord } from '../../src/lib/session-persistence.ts';
import type { SerialSession } from '../../src/types/index.ts';

const CONTEXT: PluginHostV2GatewayContext = Object.freeze({
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.mcumgr',
  instanceId: '11',
  generation: 3,
});

const OTHER_CONTEXT: PluginHostV2GatewayContext = Object.freeze({
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.other',
  instanceId: '12',
  generation: 4,
});

const PLUGIN_CONFIG = Object.freeze({
  baudRate: 115_200,
  dataBits: 8,
  parity: 1,
  stopBits: 1,
  flowControl: 1,
});

describe('plugin serial capability production composition', () => {
  test('keeps native paths opaque and invalidates aliases across remove/reinsert', async () => {
    const harness = createCompositionHarness(['/dev/ttyUSB-secret']);
    const first = await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    expect(first).toMatchObject({
      ok: true,
      result: { kind: 'list-ports', ports: [{ displayName: 'ttyUSB-secret' }] },
    });
    expect(JSON.stringify(first)).not.toContain('/dev/');
    const firstId = resultPortId(first);

    harness.paths.splice(0, 1);
    expect(harness.gateway.refreshPortCatalog()).toBe(true);
    expect(
      await harness.gateway.invoke(CONTEXT, 2, {
        kind: 'create-session',
        request: createRequest(firstId, 'runtime'),
      }),
    ).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    harness.paths.push('/dev/ttyUSB-secret');
    expect(harness.gateway.refreshPortCatalog()).toBe(true);
    const reinserted = await harness.gateway.invoke(CONTEXT, 3, { kind: 'list-ports' });
    expect(resultPortId(reinserted)).not.toBe(firstId);
  });

  test('executes session lifecycle and bounded capture without persisting runtime sessions', async () => {
    const harness = createCompositionHarness(['/dev/ttyACM0']);
    const ports = await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const portId = resultPortId(ports);

    const created = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(portId, 'runtime'),
    });
    expect(created).toMatchObject({
      ok: true,
      result: {
        kind: 'create-session',
        session: { name: 'MCUmgr runtime', portId, connected: false, generation: 0 },
      },
    });
    const sessionId = resultSessionId(created);
    expect(harness.runtimeOnly.has(sessionId)).toBe(true);

    expect(
      await harness.gateway.invoke(CONTEXT, 3, { kind: 'connect-session', sessionId }),
    ).toMatchObject({
      ok: true,
      result: { kind: 'connect-session', session: { connected: true, generation: 1 } },
    });
    expect(
      await harness.gateway.invoke(CONTEXT, 4, { kind: 'disconnect-session', sessionId }),
    ).toMatchObject({ ok: true, result: { kind: 'disconnect-session' } });

    const session = harness.sessions.find((candidate) => candidate.id === sessionId)!;
    session.frames.push(
      { id: 'f-1', direction: 'RX', timestamp: 10, data: Uint8Array.from([1, 2]) },
      { id: 'f-2', direction: 'TX', timestamp: 11, data: Uint8Array.from([3]) },
    );
    session.rxFrames = 1;
    session.txFrames = 1;
    expect(
      await harness.gateway.invoke(CONTEXT, 5, {
        kind: 'capture-read',
        sessionId,
        fromSequence: 0,
        maxFrames: 1,
        maxBytes: 8,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        kind: 'capture-read',
        frames: [{ sequence: 0, direction: 'rx', payload: [1, 2] }],
        nextSequence: 1,
      },
    });

    session.rxFrames = 5;
    session.txFrames = 5;
    expect(
      await harness.gateway.invoke(CONTEXT, 6, {
        kind: 'capture-read',
        sessionId,
        fromSequence: 0,
        maxFrames: 1,
        maxBytes: 8,
      }),
    ).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    await expect(harness.gateway.revokeRuntime(CONTEXT)).resolves.toBeGreaterThanOrEqual(1);
    expect(harness.sessions).toHaveLength(0);
    expect(harness.disposeSession).toHaveBeenCalledWith(sessionId);
  });

  test('keeps persistent sessions on revoke while read-only workspaces admit runtime-only sessions', async () => {
    const harness = createCompositionHarness(['COM9']);
    const listed = await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const created = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(listed), 'persistent'),
    });
    expect(created).toMatchObject({ ok: true, result: { kind: 'create-session' } });
    await harness.gateway.revokeRuntime(CONTEXT);
    expect(harness.sessions).toHaveLength(1);
    expect(harness.runtimeOnly.size).toBe(0);

    const readOnly = createCompositionHarness(['COM10']);
    readOnly.workspaceState.acceptsSaves = false;
    readOnly.workspaceState.readOnly = true;
    const readOnlyPorts = await readOnly.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const readOnlyPortId = resultPortId(readOnlyPorts);
    expect(
      await readOnly.gateway.invoke(CONTEXT, 2, {
        kind: 'create-session',
        request: createRequest(readOnlyPortId, 'persistent'),
      }),
    ).toMatchObject({ ok: false, errorCode: 'unavailable' });
    const runtimeCreated = await readOnly.gateway.invoke(CONTEXT, 3, {
      kind: 'create-session',
      request: createRequest(readOnlyPortId, 'runtime'),
    });
    expect(runtimeCreated).toMatchObject({ ok: true, result: { kind: 'create-session' } });
    const runtimeSession = resultSession(runtimeCreated);
    expect(
      await readOnly.gateway.invoke(CONTEXT, 4, {
        kind: 'update-session',
        session: { ...runtimeSession, name: 'Read-only runtime' },
      }),
    ).toMatchObject({
      ok: true,
      result: { kind: 'update-session', session: { name: 'Read-only runtime' } },
    });
    expect(
      await readOnly.gateway.invoke(CONTEXT, 5, {
        kind: 'delete-session',
        sessionId: runtimeSession.sessionId,
      }),
    ).toMatchObject({ ok: true, result: { kind: 'delete-session' } });
    expect(readOnly.sessions).toHaveLength(0);
  });

  test('flushes unsaved persistent capture before paging complete SQLite history', async () => {
    const harness = createCompositionHarness(['COM12']);
    const listed = await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const created = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(listed), 'persistent'),
    });
    const sessionId = resultSessionId(created);
    harness.captureCeilings.set(sessionId, 4);
    harness.persistedFrames.push(
      hydratedFrame(0, [1, 2]),
      hydratedFrame(1, [3]),
      hydratedFrame(2, [4]),
      hydratedFrame(3, [5]),
    );
    harness.workspaceState.unsavedMutationCount = 2;
    const flush = deferred<Awaited<ReturnType<typeof harness.flushWorkspace>>>();
    harness.flushWorkspace.mockReturnValueOnce(flush.promise);

    const read = harness.gateway.invoke(CONTEXT, 3, {
      kind: 'capture-read',
      sessionId,
      fromSequence: 0,
      maxFrames: 2,
      maxBytes: 8,
    });
    await vi.waitFor(() => expect(harness.flushWorkspace).toHaveBeenCalledOnce());
    expect(harness.hydrateFrames).not.toHaveBeenCalled();
    harness.workspaceState.currentWorkspace.revision = 8;
    flush.resolve({
      outcome: 'completed',
      value: { workspaceId: CONTEXT.workspaceId, revision: 8 },
    });

    expect(await read).toMatchObject({
      ok: true,
      result: {
        kind: 'capture-read',
        frames: [
          { sequence: 0, direction: 'rx', payload: [1, 2] },
          { sequence: 1, direction: 'rx', payload: [3] },
        ],
        nextSequence: 2,
      },
    });
    expect(harness.sessions[0]?.frames).toEqual([]);
    expect(harness.hydrateFrames).toHaveBeenCalledWith({
      requestId: 'capture-1',
      workspaceId: CONTEXT.workspaceId,
      sessionId,
      fromSeq: 0,
      limit: 2,
    });
    expect(harness.flushWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      harness.hydrateFrames.mock.invocationCallOrder[0]!,
    );
  });

  test('reports trimmed persistent history as stale and enforces maxBytes without skipping rows', async () => {
    const trimmed = createCompositionHarness(['COM13']);
    const listed = await trimmed.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const created = await trimmed.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(listed), 'persistent'),
    });
    const sessionId = resultSessionId(created);
    trimmed.captureCeilings.set(sessionId, 6);
    trimmed.persistedFrames.push(hydratedFrame(4, [1]), hydratedFrame(5, [2]));
    expect(
      await trimmed.gateway.invoke(CONTEXT, 3, {
        kind: 'capture-read',
        sessionId,
        fromSequence: 0,
        maxFrames: 4,
        maxBytes: 8,
      }),
    ).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    const bounded = createCompositionHarness(['COM14']);
    const boundedPorts = await bounded.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const boundedCreated = await bounded.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(boundedPorts), 'persistent'),
    });
    const boundedId = resultSessionId(boundedCreated);
    bounded.captureCeilings.set(boundedId, 2);
    bounded.persistedFrames.push(hydratedFrame(0, [1, 2]), hydratedFrame(1, [3, 4]));
    expect(
      await bounded.gateway.invoke(CONTEXT, 3, {
        kind: 'capture-read',
        sessionId: boundedId,
        fromSequence: 0,
        maxFrames: 2,
        maxBytes: 3,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        frames: [{ sequence: 0, payload: [1, 2] }],
        nextSequence: 1,
      },
    });
    expect(
      await bounded.gateway.invoke(CONTEXT, 4, {
        kind: 'capture-read',
        sessionId: boundedId,
        fromSequence: 1,
        maxFrames: 1,
        maxBytes: 1,
      }),
    ).toMatchObject({ ok: false, errorCode: 'limit-exceeded' });
  });

  test('cancels an in-flight SQLite page and times out a stalled native read', async () => {
    const cancelled = createCompositionHarness(['COM15']);
    const ports = await cancelled.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const created = await cancelled.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(ports), 'persistent'),
    });
    const sessionId = resultSessionId(created);
    cancelled.captureCeilings.set(sessionId, 1);
    const hydration = deferred<HydrateWorkspaceFramesResponse>();
    cancelled.hydrateFrames.mockReturnValueOnce(hydration.promise);
    const read = cancelled.gateway.invoke(CONTEXT, 3, {
      kind: 'capture-read',
      sessionId,
      fromSequence: 0,
      maxFrames: 1,
      maxBytes: 8,
    });
    await vi.waitFor(() => expect(cancelled.hydrateFrames).toHaveBeenCalledOnce());
    await expect(cancelled.gateway.cancel(CONTEXT, 3)).resolves.toMatchObject({ ok: true });
    await expect(read).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });

    const timedOut = createCompositionHarness(['COM16'], { captureReadTimeoutMs: 10 });
    const timeoutPorts = await timedOut.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' });
    const timeoutCreated = await timedOut.gateway.invoke(CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(timeoutPorts), 'persistent'),
    });
    const timeoutSessionId = resultSessionId(timeoutCreated);
    timedOut.captureCeilings.set(timeoutSessionId, 1);
    timedOut.hydrateFrames.mockReturnValueOnce(new Promise(() => undefined));
    await expect(
      timedOut.gateway.invoke(CONTEXT, 3, {
        kind: 'capture-read',
        sessionId: timeoutSessionId,
        fromSequence: 0,
        maxFrames: 1,
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  test('rejects runtime session mutation from a different plugin runtime', async () => {
    const harness = createCompositionHarness(['COM11']);
    harness.workspaceState.acceptsSaves = false;
    harness.workspaceState.readOnly = true;
    const listed = await harness.gateway.invoke(OTHER_CONTEXT, 1, { kind: 'list-ports' });
    const created = await harness.gateway.invoke(OTHER_CONTEXT, 2, {
      kind: 'create-session',
      request: createRequest(resultPortId(listed), 'runtime'),
    });
    const session = resultSession(created);

    expect(
      await harness.gateway.invoke(CONTEXT, 1, {
        kind: 'update-session',
        session: { ...session, name: 'stolen' },
      }),
    ).toMatchObject({ ok: false, errorCode: 'permission-denied' });
    expect(
      await harness.gateway.invoke(CONTEXT, 2, {
        kind: 'delete-session',
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ ok: false, errorCode: 'permission-denied' });
    expect(harness.sessions).toHaveLength(1);
    expect(
      await harness.gateway.invoke(OTHER_CONTEXT, 3, {
        kind: 'delete-session',
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ ok: true, result: { kind: 'delete-session' } });
    expect(harness.sessions).toHaveLength(0);
  });
});

function createCompositionHarness(
  initialPaths: readonly string[],
  options: Readonly<{ captureReadTimeoutMs?: number }> = {},
) {
  const paths = [...initialPaths];
  const sessions: SerialSession[] = [];
  const runtimeOnly = new Set<string>();
  const runtimes = new Map<string, ReturnType<typeof createRuntime>>();
  let nextSession = 0;
  let nextPort = 0;
  const workspaceState = {
    currentWorkspace: { workspaceId: CONTEXT.workspaceId, revision: 7 },
    acceptsSaves: true,
    readOnly: false,
    unsavedMutationCount: 0,
  };
  const captureCeilings = new Map<string, number>();
  const persistedFrames: WorkspaceHydratedFrame[] = [];
  let nextCaptureRequest = 0;
  const flushWorkspace = vi.fn(async () => {
    workspaceState.unsavedMutationCount = 0;
    return {
      outcome: 'completed' as const,
      value: {
        workspaceId: workspaceState.currentWorkspace.workspaceId,
        revision: workspaceState.currentWorkspace.revision,
      },
    };
  });
  const hydrateFrames = vi.fn(
    async (request: HydrateWorkspaceFramesRequest): Promise<HydrateWorkspaceFramesResponse> => {
      const eligible = persistedFrames.filter((frame) => frame.seq >= request.fromSeq);
      const frames = eligible.slice(0, request.limit);
      return {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        revision: workspaceState.currentWorkspace.revision,
        frames,
        ...(eligible.length > frames.length ? { nextSeq: eligible[frames.length]!.seq } : {}),
      };
    },
  );
  const disposeSession = vi.fn(async (sessionId: string) => {
    runtimes.delete(sessionId);
  });
  const gateway = createPluginSerialCapabilityGateway({
    pluginCenter: {
      snapshot: () => ({
        installed: [CONTEXT, OTHER_CONTEXT].map(
          (context) =>
            ({
              enabled: true,
              status: 'running',
              effectiveCapabilities: [
                'serial.ports.read',
                'serial.sessions.manage',
                'serial.io',
                'serial.control-lines',
                'session.capture.read',
              ],
              runtime: {
                workspaceId: context.workspaceId,
                pluginId: context.pluginId,
                instanceId: Number(context.instanceId),
                generation: context.generation,
              },
            }) as never,
        ),
      }),
    } as never,
    workspace: {
      snapshot: () => workspaceState,
      captureSeqCeiling: (sessionId) => {
        const persistent = captureCeilings.get(sessionId);
        if (persistent !== undefined) return persistent;
        const session = sessions.find((candidate) => candidate.id === sessionId);
        return session ? session.frames.length + session.pausedFrames.length : null;
      },
      flush: flushWorkspace,
    },
    workspaceFrames: { hydrateFrames },
    ports: {
      get availablePorts() {
        return paths;
      },
    },
    portIdFactory: () => `opaque${++nextPort}`,
    captureRequestIdFactory: () => `capture-${++nextCaptureRequest}`,
    ...(options.captureReadTimeoutMs === undefined
      ? {}
      : { captureReadTimeoutMs: options.captureReadTimeoutMs }),
    sessions: {
      get sessions() {
        return sessions;
      },
      createSession(portName, config, options) {
        const id = `session-${++nextSession}`;
        const session = createSessionRecord(id, portName, config);
        if (options?.displayName) session.displayName = options.displayName;
        sessions.push(session);
        if (options?.lifetime === 'runtime') runtimeOnly.add(id);
        return id;
      },
      createRuntimeSession(portName, config, displayName) {
        const id = `session-${++nextSession}`;
        const session = createSessionRecord(id, portName, config);
        session.displayName = displayName;
        sessions.push(session);
        runtimeOnly.add(id);
        return id;
      },
      async removeSession(sessionId) {
        const index = sessions.findIndex((session) => session.id === sessionId);
        if (index < 0) return null;
        runtimeOnly.delete(sessionId);
        return sessions.splice(index, 1)[0];
      },
      async removeRuntimeSession(sessionId) {
        if (!runtimeOnly.has(sessionId)) return null;
        const index = sessions.findIndex((session) => session.id === sessionId);
        runtimeOnly.delete(sessionId);
        return index < 0 ? null : sessions.splice(index, 1)[0];
      },
      updateSessionConnectionSettings(sessionId, portName, config, displayName) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session || session.isConnected) return false;
        session.portName = portName;
        session.portConfig = config;
        session.displayName = displayName;
        return true;
      },
      updateRuntimeSessionConnectionSettings(sessionId, portName, config, displayName) {
        if (!runtimeOnly.has(sessionId)) return false;
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session || session.isConnected) return false;
        session.portName = portName;
        session.portConfig = config;
        session.displayName = displayName;
        return true;
      },
      isPersistentSession: (sessionId) => !runtimeOnly.has(sessionId),
    },
    runtimes: {
      get: (sessionId) => runtimes.get(sessionId),
      async ensure(session) {
        let runtime = runtimes.get(session.id);
        if (!runtime) {
          runtime = createRuntime(session);
          runtimes.set(session.id, runtime);
        }
        return runtime;
      },
      disposeSession,
    },
  });
  return {
    gateway,
    paths,
    sessions,
    runtimeOnly,
    workspaceState,
    disposeSession,
    captureCeilings,
    persistedFrames,
    flushWorkspace,
    hydrateFrames,
  };
}

function hydratedFrame(sequence: number, data: readonly number[]): WorkspaceHydratedFrame {
  return {
    seq: sequence,
    id: `frame-${sequence}`,
    direction: 'RX',
    timestampMs: 1_000 + sequence,
    data: [],
    dataB64: bytesToBase64(Uint8Array.from(data)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRuntime(session: SerialSession) {
  let connected = false;
  let generation = 0;
  const serialTransactions = {
    connectionSnapshot: () => ({ connected, generation }),
  } as unknown as PluginSerialCapabilityCoordinator;
  return {
    sessionId: session.id,
    serialTransactions,
    async connect() {
      connected = true;
      generation += 1;
      session.isConnected = true;
      return true;
    },
    async disconnect() {
      connected = false;
      session.isConnected = false;
    },
  };
}

function createRequest(portId: string, lifetime: 'persistent' | 'runtime') {
  return {
    localId: `client-${lifetime}`,
    name: 'MCUmgr runtime',
    lifetime,
    portId,
    config: PLUGIN_CONFIG,
  } as const;
}

function resultPortId(
  response: Awaited<ReturnType<ReturnType<typeof createCompositionHarness>['gateway']['invoke']>>,
): string {
  if (!response?.ok || response.result.kind !== 'list-ports') throw new Error('expected ports');
  const id = response.result.ports[0]?.portId;
  if (!id) throw new Error('expected one port');
  return id;
}

function resultSessionId(
  response: Awaited<ReturnType<ReturnType<typeof createCompositionHarness>['gateway']['invoke']>>,
): string {
  if (!response?.ok || response.result.kind !== 'create-session')
    throw new Error('expected session');
  return response.result.session.sessionId;
}

function resultSession(
  response: Awaited<ReturnType<ReturnType<typeof createCompositionHarness>['gateway']['invoke']>>,
) {
  if (
    !response?.ok ||
    (response.result.kind !== 'create-session' && response.result.kind !== 'update-session')
  ) {
    throw new Error('expected session');
  }
  return response.result.session;
}
