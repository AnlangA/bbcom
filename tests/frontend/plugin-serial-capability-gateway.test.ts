import { describe, expect, test, vi } from 'vitest';
import type { SerialTransactionLeaseToken } from '../../src/features/serial';
import {
  PluginSerialCapabilityBridge,
  PluginSerialCapabilityGateway,
  type PluginHostV2GatewayContext,
  type PluginHostV2ResourceBinding,
  type PluginHostV2SerialOperation,
  type PluginHostV2SerialSession,
  type PluginSerialCapabilityAuthority,
  type PluginSerialCapabilityCoordinator,
  type PluginSerialCapabilityOutboundEvent,
  type PluginSerialCapabilitySessionRuntime,
  type PluginSerialCapabilityTransport,
} from '../../src/features/plugins/application/plugin-serial-capability-gateway';

const CONTEXT: PluginHostV2GatewayContext = Object.freeze({
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.fixture',
  instanceId: 'instance-1',
  generation: 4,
});

const OTHER_CONTEXT: PluginHostV2GatewayContext = Object.freeze({
  ...CONTEXT,
  instanceId: 'instance-2',
  generation: 5,
});

const SESSION: PluginHostV2SerialSession = Object.freeze({
  sessionId: 'session-1',
  name: 'Fixture serial session',
  portId: 'port-1',
  config: Object.freeze({
    baudRate: 115_200,
    dataBits: 8,
    parity: 1,
    stopBits: 1,
    flowControl: 1,
  }),
  connected: true,
  generation: 7,
});

describe('PluginSerialCapabilityGateway', () => {
  test('maps the generated-v2 serial request/response subset only through serialTransactions', async () => {
    const harness = createHarness();

    const listed = await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' });
    expect(listed).toEqual({
      replyTo: 1,
      context: CONTEXT,
      ok: true,
      result: { kind: 'list-sessions', sessions: [SESSION] },
    });

    const acquired = await acquire(harness, 2);
    expect(harness.coordinator.acquire).toHaveBeenCalledWith('plugin:dev.bbcom.fixture:4', {
      signal: expect.any(AbortSignal),
      rxBufferBytes: 1024 * 1024,
    });
    expect(acquired).toEqual({
      workspaceId: CONTEXT.workspaceId,
      pluginId: CONTEXT.pluginId,
      instanceId: CONTEXT.instanceId,
      generation: CONTEXT.generation,
      resourceId: 'serial-v2.opaque-resource.1',
    });
    expect(JSON.stringify(acquired)).not.toContain('coordinator-token');

    const written = await harness.gateway.invoke(CONTEXT, 3, {
      kind: 'serial-write',
      lease: acquired,
      payload: [1, 2, 3],
    });
    expect(written).toEqual({
      replyTo: 3,
      context: CONTEXT,
      ok: true,
      result: {
        kind: 'serial-write',
        requested: 3,
        sent: 3,
        outcome: 'completed',
      },
    });
    expect(harness.coordinator.write).toHaveBeenCalledWith(
      harness.token,
      Uint8Array.from([1, 2, 3]),
      expect.any(AbortSignal),
    );
    expect(harness.coordinator.write).toHaveBeenCalledTimes(1);
    expect(harness.sendBytesOutsideGate).not.toHaveBeenCalled();

    const read = await harness.gateway.invoke(CONTEXT, 4, {
      kind: 'serial-read',
      lease: acquired,
      maxBytes: 32,
      timeoutMs: 500,
    });
    expect(read).toEqual({
      replyTo: 4,
      context: CONTEXT,
      ok: true,
      result: {
        kind: 'serial-read',
        payload: [9, 8],
        timedOut: false,
        disconnected: false,
      },
    });
    expect(harness.coordinator.read).toHaveBeenCalledWith(harness.token, {
      maxBytes: 32,
      timeoutMs: 500,
      signal: expect.any(AbortSignal),
    });

    const pending = await harness.gateway.invoke(CONTEXT, 5, {
      kind: 'pending-serial-bytes',
      lease: acquired,
    });
    expect(pending).toEqual({
      replyTo: 5,
      context: CONTEXT,
      ok: true,
      result: { kind: 'pending-serial-bytes', rx: 11, tx: 2 },
    });
    expect(harness.coordinator.pendingBytes).toHaveBeenCalledWith(
      harness.token,
      expect.any(AbortSignal),
    );

    const cleared = await harness.gateway.invoke(CONTEXT, 6, {
      kind: 'clear-serial-buffers',
      lease: acquired,
    });
    expect(cleared).toEqual({
      replyTo: 6,
      context: CONTEXT,
      ok: true,
      result: { kind: 'clear-serial-buffers' },
    });
    expect(harness.coordinator.clearBuffers).toHaveBeenCalledWith(
      harness.token,
      'all',
      expect.any(AbortSignal),
    );
    expect(harness.coordinator.clearBuffers).toHaveBeenCalledTimes(1);

    const released = await harness.gateway.invoke(CONTEXT, 7, {
      kind: 'release-serial-lease',
      lease: acquired,
    });
    expect(released).toEqual({
      replyTo: 7,
      context: CONTEXT,
      ok: true,
      result: { kind: 'release-serial-lease' },
    });
    expect(harness.coordinator.release).toHaveBeenCalledWith(harness.token);
  });

  test('routes the complete typed port, session, control-line, and capture capability surface', async () => {
    const harness = createHarness();

    expect(await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-ports' })).toMatchObject({
      ok: true,
      result: {
        kind: 'list-ports',
        ports: [{ portId: 'port-1', displayName: 'USB UART' }],
      },
    });
    const request = {
      localId: 'mcumgr',
      name: 'MCUmgr',
      lifetime: 'runtime' as const,
      portId: 'port-1',
      config: SESSION.config,
    };
    expect(
      await harness.gateway.invoke(CONTEXT, 2, { kind: 'create-session', request }),
    ).toMatchObject({ ok: true, result: { kind: 'create-session', session: SESSION } });
    expect(harness.createSessionSource).toHaveBeenCalledWith(
      CONTEXT,
      request,
      expect.any(AbortSignal),
    );

    expect(
      await harness.gateway.invoke(CONTEXT, 3, { kind: 'update-session', session: SESSION }),
    ).toMatchObject({ ok: true, result: { kind: 'update-session', session: SESSION } });
    expect(
      await harness.gateway.invoke(CONTEXT, 4, {
        kind: 'connect-session',
        sessionId: SESSION.sessionId,
      }),
    ).toMatchObject({ ok: true, result: { kind: 'connect-session', session: SESSION } });
    expect(
      await harness.gateway.invoke(CONTEXT, 5, {
        kind: 'disconnect-session',
        sessionId: SESSION.sessionId,
      }),
    ).toMatchObject({ ok: true, result: { kind: 'disconnect-session' } });
    expect(
      await harness.gateway.invoke(CONTEXT, 6, {
        kind: 'delete-session',
        sessionId: SESSION.sessionId,
      }),
    ).toMatchObject({ ok: true, result: { kind: 'delete-session' } });

    expect(
      await harness.gateway.invoke(CONTEXT, 7, {
        kind: 'capture-read',
        sessionId: SESSION.sessionId,
        fromSequence: 40,
        maxFrames: 4,
        maxBytes: 64,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        kind: 'capture-read',
        frames: [{ sequence: 40, timestampMs: 1_234, direction: 'rx', payload: [1, 2, 3] }],
        nextSequence: 41,
      },
    });

    const lease = await acquire(harness, 8);
    expect(
      await harness.gateway.invoke(CONTEXT, 9, {
        kind: 'set-output-lines',
        lease,
        lines: { dtr: true, rts: false, breakActive: true },
      }),
    ).toMatchObject({ ok: true, result: { kind: 'set-output-lines' } });
    expect(harness.coordinator.setOutputLines).toHaveBeenCalledWith(
      harness.token,
      { dtr: true, rts: false, breakActive: true },
      expect.any(AbortSignal),
    );
    expect(
      await harness.gateway.invoke(CONTEXT, 10, { kind: 'read-input-lines', lease }),
    ).toMatchObject({
      ok: true,
      result: {
        kind: 'read-input-lines',
        lines: { cts: true, dsr: false, ri: false, cd: true },
      },
    });
  });

  test('binds opaque resources to every runtime field, the resident session object, and generation', async () => {
    const harness = createHarness();
    harness.authorityState.active.add(contextKey(OTHER_CONTEXT));
    const lease = await acquire(harness, 1);

    const crossRuntime = await harness.gateway.invoke(OTHER_CONTEXT, 1, {
      kind: 'serial-write',
      lease,
      payload: [1],
    });
    expect(crossRuntime).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    const forgedGeneration = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'serial-read',
      lease: { ...lease, generation: lease.generation + 1 },
      maxBytes: 1,
      timeoutMs: 1,
    });
    expect(forgedGeneration).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    const forgedResource = await harness.gateway.invoke(CONTEXT, 3, {
      kind: 'serial-write',
      lease: { ...lease, resourceId: 'serial-v2.forged.1' },
      payload: [1],
    });
    expect(forgedResource).toMatchObject({ ok: false, errorCode: 'stale-handle' });
    expect(harness.coordinator.write).not.toHaveBeenCalled();
    expect(harness.coordinator.read).not.toHaveBeenCalled();

    harness.currentRuntime.value = {
      sessionId: 'session-1',
      serialTransactions: createCoordinator().coordinator,
    };
    const replacedRuntime = await harness.gateway.invoke(CONTEXT, 4, {
      kind: 'serial-read',
      lease,
      maxBytes: 1,
      timeoutMs: 1,
    });
    expect(replacedRuntime).toMatchObject({ ok: false, errorCode: 'stale-handle' });
    expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token);
  });

  test('allows one lease per plugin runtime and enforces monotonic nonzero message ids', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);

    const second = await harness.gateway.invoke(CONTEXT, 2, acquireOperation());
    expect(second).toMatchObject({ ok: false, errorCode: 'busy' });
    expect(harness.coordinator.acquire).toHaveBeenCalledTimes(1);

    const replay = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'serial-read',
      lease,
      maxBytes: 1,
      timeoutMs: 1,
    });
    expect(replay).toMatchObject({ ok: false, errorCode: 'protocol-error' });
    expect(await harness.gateway.invoke(CONTEXT, 0, { kind: 'list-sessions' })).toBeNull();

    await harness.gateway.invoke(CONTEXT, 3, {
      kind: 'release-serial-lease',
      lease,
    });
    await acquire(harness, 4);
    expect(harness.coordinator.acquire).toHaveBeenCalledTimes(2);
  });

  test('cancel maps Envelope.Cancel to request abort and coordinator lease revocation', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    const readStarted = deferred<void>();
    harness.coordinator.read.mockImplementation(async (_token, options) => {
      readStarted.resolve();
      await aborted(options.signal);
      throw codedError('cancelled');
    });

    const read = harness.gateway.invoke(CONTEXT, 2, {
      kind: 'serial-read',
      lease,
      maxBytes: 64,
      timeoutMs: 5_000,
    });
    await readStarted.promise;
    const duplicate = await harness.gateway.invoke(CONTEXT, 2, {
      kind: 'serial-read',
      lease,
      maxBytes: 64,
      timeoutMs: 5_000,
    });
    expect(duplicate).toBeNull();

    const cancelled = await harness.gateway.cancel(CONTEXT, 2);
    expect(cancelled).toEqual({ ok: true, context: CONTEXT, targetMessageId: 2 });
    expect(await read).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token);
    expect(await harness.gateway.cancel(CONTEXT, 99)).toMatchObject({
      ok: false,
      errorCode: 'not-found',
    });
  });

  test('reclaims only the exact late acquire binding and treats duplicate discard as a no-op', async () => {
    const harness = createHarness();
    const response = await harness.gateway.invoke(CONTEXT, 1, acquireOperation());
    expect(response).toMatchObject({ ok: true, result: { kind: 'acquire-serial-lease' } });
    if (!response?.ok || response.result.kind !== 'acquire-serial-lease') {
      throw new Error('expected acquired serial lease');
    }
    const { lease, sessionGeneration } = response.result;

    await expect(
      harness.gateway.revokeLease(OTHER_CONTEXT, lease, sessionGeneration),
    ).resolves.toBe(false);
    await expect(
      harness.gateway.revokeLease(
        CONTEXT,
        { ...lease, generation: lease.generation + 1 },
        sessionGeneration,
      ),
    ).resolves.toBe(false);
    await expect(harness.gateway.revokeLease(CONTEXT, lease, sessionGeneration + 1)).resolves.toBe(
      false,
    );
    expect(harness.coordinator.cancel).not.toHaveBeenCalled();

    await expect(harness.gateway.revokeLease(CONTEXT, lease, sessionGeneration)).resolves.toBe(
      true,
    );
    await expect(harness.gateway.revokeLease(CONTEXT, lease, sessionGeneration)).resolves.toBe(
      false,
    );
    expect(harness.coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token);
  });

  test('revokes on workspace/runtime authority changes and reports unknown write outcome', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    const writeResult = deferred<{
      outcome: 'complete';
      requestedBytes: number;
      sentBytes: number;
    }>();
    harness.coordinator.write.mockReturnValue(writeResult.promise);

    const write = harness.gateway.invoke(CONTEXT, 2, {
      kind: 'serial-write',
      lease,
      payload: [1, 2],
    });
    await vi.waitFor(() => expect(harness.coordinator.write).toHaveBeenCalledOnce());
    harness.authorityState.workspaceId = 'workspace-2';
    writeResult.resolve({ outcome: 'complete', requestedBytes: 2, sentBytes: 2 });
    expect(await write).toMatchObject({ ok: false, errorCode: 'unknown-outcome' });
    expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token);

    harness.authorityState.mainWindow = false;
    expect(await harness.gateway.invoke(CONTEXT, 3, { kind: 'list-sessions' })).toBeNull();
  });

  test('denies missing capabilities and rejects malformed source data without leaking it', async () => {
    const harness = createHarness();
    harness.authorityState.capabilities.delete('serial.sessions.manage');
    expect(await harness.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'permission-denied',
    });

    harness.authorityState.capabilities.add('serial.sessions.manage');
    harness.listSessions.mockReturnValue([SESSION, SESSION]);
    expect(await harness.gateway.invoke(CONTEXT, 2, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'protocol-error',
    });
    expect(await harness.gateway.invoke(CONTEXT, 3, { kind: 'unknown' })).toBeNull();
    expect(
      await harness.gateway.invoke({ ...CONTEXT, instanceId: '../escape' }, 4, {
        kind: 'list-sessions',
      }),
    ).toBeNull();

    expect(
      await harness.gateway.invoke(CONTEXT, 4, {
        kind: 'create-session',
        request: {
          localId: 'unsupported-lines',
          name: 'Unsupported framing',
          lifetime: 'runtime',
          config: { ...SESSION.config, parity: 4, stopBits: 2 },
        },
      }),
    ).toBeNull();
  });

  test('bridges only in the main window and revokes an acquired handle when response delivery fails', async () => {
    const nonMain = createHarness();
    nonMain.authorityState.mainWindow = false;
    const unusedTransport = createTransport();
    const unusedBridge = new PluginSerialCapabilityBridge(nonMain.gateway, unusedTransport.port);
    await expect(unusedBridge.start()).resolves.toBe(false);
    expect(unusedTransport.listen).not.toHaveBeenCalled();

    const harness = createHarness();
    const transport = createTransport();
    transport.respond.mockRejectedValueOnce(new Error('native uplink unavailable'));
    const bridge = new PluginSerialCapabilityBridge(harness.gateway, transport.port);
    await expect(bridge.start()).resolves.toBe(true);
    transport.emit({
      kind: 'request',
      context: CONTEXT,
      messageId: 1,
      operation: acquireOperation(),
    });
    await vi.waitFor(() => expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token));
    expect(transport.respond).toHaveBeenCalledWith({
      kind: 'response',
      response: expect.objectContaining({ ok: true }),
    });
    await bridge.stop();
    expect(transport.unlisten).toHaveBeenCalledOnce();
  });

  test('does not respond when main-window authority is lost during acquisition', async () => {
    const harness = createHarness();
    const grant = deferred<{ token: SerialTransactionLeaseToken; generation: number }>();
    harness.coordinator.acquire.mockReturnValue(grant.promise);
    const transport = createTransport();
    const bridge = new PluginSerialCapabilityBridge(harness.gateway, transport.port);
    await bridge.start();
    transport.emit({
      kind: 'request',
      context: CONTEXT,
      messageId: 1,
      operation: acquireOperation(),
    });
    await vi.waitFor(() => expect(harness.coordinator.acquire).toHaveBeenCalledOnce());
    harness.authorityState.mainWindow = false;
    grant.resolve({ token: harness.token, generation: SESSION.generation });
    await vi.waitFor(() => expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token));
    expect(transport.respond).not.toHaveBeenCalled();
    harness.authorityState.mainWindow = true;
    await bridge.stop();
  });

  test('fails closed for unavailable authority, invalid lifecycle calls, and runtime revocation', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    harness.authorityState.workspaceId = null;
    expect(await harness.gateway.invoke(CONTEXT, 2, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'unavailable',
    });
    expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token);

    expect(await harness.gateway.revokeRuntime({ nope: true })).toBe(0);
    expect(await harness.gateway.cancel({ nope: true }, 1)).toBeNull();
    expect(await harness.gateway.cancel(CONTEXT, 0)).toBeNull();

    const revoked = createHarness();
    await acquire(revoked, 1);
    await expect(revoked.gateway.revokeRuntime(CONTEXT)).resolves.toBe(1);
    expect(revoked.coordinator.cancel).toHaveBeenCalledWith(revoked.token);
    expect(
      await revoked.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-read',
        lease,
        maxBytes: 1,
        timeoutMs: 1,
      }),
    ).toMatchObject({ ok: false, errorCode: 'stale-handle' });

    const throwingAuthority = createHarness({ throwWindowSnapshot: true });
    expect(throwingAuthority.gateway.canRespond()).toBe(false);
    expect(
      await throwingAuthority.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' }),
    ).toBeNull();

    const inactive = createHarness();
    inactive.authorityState.active.clear();
    expect(await inactive.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'stale-handle',
    });
  });

  test('maps source, acquisition, resource-factory, and coordinator failures to stable v2 errors', async () => {
    const missing = createHarness({ runtimeMissing: true });
    expect(await missing.gateway.invoke(CONTEXT, 1, acquireOperation())).toMatchObject({
      ok: false,
      errorCode: 'not-found',
    });

    const sourceFailure = createHarness();
    sourceFailure.listSessions.mockImplementation(() => {
      throw new Error('catalog unavailable');
    });
    expect(await sourceFailure.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' })).toMatchObject(
      {
        ok: false,
        errorCode: 'unavailable',
      },
    );

    const tooMany = createHarness();
    tooMany.listSessions.mockReturnValue(Array.from({ length: 1_025 }, () => SESSION));
    expect(await tooMany.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'limit-exceeded',
    });

    const malformed = createHarness();
    malformed.listSessions.mockReturnValue([{ ...SESSION, name: 'bad\nname' }]);
    expect(await malformed.gateway.invoke(CONTEXT, 1, { kind: 'list-sessions' })).toMatchObject({
      ok: false,
      errorCode: 'protocol-error',
    });

    const invalidGrant = createHarness();
    invalidGrant.coordinator.acquire.mockResolvedValue({
      token: invalidGrant.token,
      ownerId: 'owner',
      generation: 0,
    });
    expect(await invalidGrant.gateway.invoke(CONTEXT, 1, acquireOperation())).toMatchObject({
      ok: false,
      errorCode: 'protocol-error',
    });
    expect(invalidGrant.coordinator.cancel).toHaveBeenCalledWith(invalidGrant.token);

    const resourceFailure = createHarness({ resourceIdFactory: () => '../not-opaque' });
    expect(await resourceFailure.gateway.invoke(CONTEXT, 1, acquireOperation())).toMatchObject({
      ok: false,
      errorCode: 'unavailable',
    });
    expect(resourceFailure.coordinator.cancel).toHaveBeenCalledWith(resourceFailure.token);
  });

  test('maps partial and uncertain physical writes without inventing completion', async () => {
    const partial = createHarness();
    const partialLease = await acquire(partial, 1);
    partial.coordinator.write.mockResolvedValue({
      outcome: 'partial',
      requestedBytes: 3,
      sentBytes: 2,
    });
    expect(
      await partial.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-write',
        lease: partialLease,
        payload: [1, 2, 3],
      }),
    ).toMatchObject({
      ok: true,
      result: { kind: 'serial-write', requested: 3, sent: 2, outcome: 'partial-write' },
    });

    const failed = createHarness();
    const failedLease = await acquire(failed, 1);
    failed.coordinator.write.mockResolvedValue({
      outcome: 'failed',
      requestedBytes: 2,
      sentBytes: 0,
    });
    expect(
      await failed.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-write',
        lease: failedLease,
        payload: [1, 2],
      }),
    ).toMatchObject({ ok: false, errorCode: 'io-error' });

    const uncertain = createHarness();
    const uncertainLease = await acquire(uncertain, 1);
    uncertain.coordinator.write.mockResolvedValue({
      outcome: 'cancelled',
      requestedBytes: 2,
      sentBytes: 1,
    });
    expect(
      await uncertain.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-write',
        lease: uncertainLease,
        payload: [1, 2],
      }),
    ).toMatchObject({ ok: false, errorCode: 'unknown-outcome' });

    const oversizedRead = createHarness();
    const oversizedLease = await acquire(oversizedRead, 1);
    oversizedRead.coordinator.read.mockResolvedValue(Uint8Array.from([1, 2]));
    expect(
      await oversizedRead.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-read',
        lease: oversizedLease,
        maxBytes: 1,
        timeoutMs: 1,
      }),
    ).toMatchObject({ ok: false, errorCode: 'protocol-error' });
  });

  test('reports a failed post-lease control-line restoration', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    harness.coordinator.release.mockResolvedValue({
      reason: 'released',
      generation: SESSION.generation,
      restoredAutomations: 0,
      restoreFailures: ['serial.control-lines'],
      restoreSkipped: true,
      drainFailed: false,
    });

    expect(
      await harness.gateway.invoke(CONTEXT, 2, {
        kind: 'release-serial-lease',
        lease,
      }),
    ).toMatchObject({ ok: false, errorCode: 'io-error' });
  });

  test('surfaces an RX mirror overflow instead of leaving a stale lease silently active', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    harness.coordinator.snapshot.mockReturnValue({
      phase: 'idle',
      ownerId: null,
      generation: null,
      bufferedRxBytes: 0,
      bufferedRxChunks: 0,
      manualWritesInFlight: 0,
      manualWriteAllowed: true,
      registeredAutomations: 0,
      faultCode: 'limit-exceeded',
    } as never);

    expect(
      await harness.gateway.invoke(CONTEXT, 2, {
        kind: 'serial-read',
        lease,
        maxBytes: 1,
        timeoutMs: 1,
      }),
    ).toMatchObject({ ok: false, errorCode: 'limit-exceeded' });
    expect(harness.coordinator.read).not.toHaveBeenCalled();
  });

  test('fails closed for malformed pending-byte counts and uncertain buffer clearing', async () => {
    const malformed = createHarness();
    const malformedLease = await acquire(malformed, 1);
    malformed.coordinator.pendingBytes.mockResolvedValue({ rx: -1, tx: 0 });
    expect(
      await malformed.gateway.invoke(CONTEXT, 2, {
        kind: 'pending-serial-bytes',
        lease: malformedLease,
      }),
    ).toMatchObject({ ok: false, errorCode: 'protocol-error' });

    const uncertain = createHarness();
    const uncertainLease = await acquire(uncertain, 1);
    const clearResult = deferred<void>();
    uncertain.coordinator.clearBuffers.mockReturnValue(clearResult.promise);
    const clearing = uncertain.gateway.invoke(CONTEXT, 2, {
      kind: 'clear-serial-buffers',
      lease: uncertainLease,
    });
    await vi.waitFor(() => expect(uncertain.coordinator.clearBuffers).toHaveBeenCalledOnce());
    uncertain.authorityState.workspaceId = 'workspace-2';
    clearResult.resolve();
    expect(await clearing).toMatchObject({ ok: false, errorCode: 'unknown-outcome' });
  });

  test('returns typed cancel results through the transport and handles authority loss during start', async () => {
    const harness = createHarness();
    const lease = await acquire(harness, 1);
    const readStarted = deferred<void>();
    harness.coordinator.read.mockImplementation(async (_token, options) => {
      readStarted.resolve();
      await aborted(options.signal);
      throw codedError('cancelled');
    });
    const transport = createTransport();
    const bridge = new PluginSerialCapabilityBridge(harness.gateway, transport.port);
    await bridge.start();
    transport.emit({
      kind: 'request',
      context: CONTEXT,
      messageId: 2,
      operation: {
        kind: 'serial-read',
        lease,
        maxBytes: 8,
        timeoutMs: 1_000,
      },
    });
    await readStarted.promise;
    transport.emit({ kind: 'cancel', context: CONTEXT, targetMessageId: 2 });
    await vi.waitFor(() =>
      expect(transport.respond).toHaveBeenCalledWith({
        kind: 'cancel-result',
        context: CONTEXT,
        targetMessageId: 2,
        ok: true,
      }),
    );
    transport.emit({ bad: true });
    await expect(bridge.start()).resolves.toBe(true);
    await bridge.stop();

    const lost = createHarness();
    const lostTransport = createTransport(() => {
      lost.authorityState.mainWindow = false;
    });
    const lostBridge = new PluginSerialCapabilityBridge(lost.gateway, lostTransport.port);
    await expect(lostBridge.start()).resolves.toBe(false);
    expect(lostTransport.unlisten).toHaveBeenCalledOnce();
  });

  test('reclaims an acquire that settles before cancel but is discarded after response delivery', async () => {
    const harness = createHarness();
    const deliveryStarted = deferred<PluginSerialCapabilityOutboundEvent>();
    const releaseDelivery = deferred<void>();
    const transport = createTransport();
    transport.respond.mockImplementation(async (event) => {
      if (
        event.kind === 'response' &&
        event.response.ok &&
        event.response.result?.kind === 'acquire-serial-lease'
      ) {
        deliveryStarted.resolve(event);
        await releaseDelivery.promise;
      }
    });
    const bridge = new PluginSerialCapabilityBridge(harness.gateway, transport.port);
    await bridge.start();

    transport.emit({
      kind: 'request',
      context: CONTEXT,
      messageId: 1,
      operation: acquireOperation(),
    });
    const delivered = await deliveryStarted.promise;
    if (
      delivered.kind !== 'response' ||
      !delivered.response.ok ||
      delivered.response.result?.kind !== 'acquire-serial-lease'
    ) {
      throw new Error('expected successful acquire response');
    }
    const { lease, sessionGeneration } = delivered.response.result;

    // The renderer invocation has settled and dropped its active cancellation
    // entry, while the successful response is still in flight to native.
    transport.emit({ kind: 'cancel', context: CONTEXT, targetMessageId: 1 });
    await vi.waitFor(() =>
      expect(transport.respond).toHaveBeenCalledWith({
        kind: 'cancel-result',
        context: CONTEXT,
        targetMessageId: 1,
        ok: false,
        errorCode: 'not-found',
      }),
    );
    expect(harness.coordinator.cancel).not.toHaveBeenCalled();

    releaseDelivery.resolve();
    transport.emit({
      kind: 'revoke-lease',
      context: CONTEXT,
      lease,
      sessionGeneration,
    });
    await vi.waitFor(() => expect(harness.coordinator.cancel).toHaveBeenCalledWith(harness.token));
    // A duplicate delivered while the first close is still settling joins the
    // same closeTask; a later duplicate observes the detached binding.
    await expect(harness.gateway.revokeLease(CONTEXT, lease, sessionGeneration)).resolves.toBe(
      true,
    );
    await expect(harness.gateway.revokeLease(CONTEXT, lease, sessionGeneration)).resolves.toBe(
      false,
    );
    expect(harness.coordinator.cancel).toHaveBeenCalledTimes(1);

    await bridge.stop();
  });

  test('applies native runtime and global revocation events without sending a reply', async () => {
    const harness = createHarness();
    const transport = createTransport();
    const bridge = new PluginSerialCapabilityBridge(harness.gateway, transport.port);
    await bridge.start();

    await acquire(harness, 1);
    transport.emit({ kind: 'revoke-runtime', context: CONTEXT });
    await vi.waitFor(() => expect(harness.coordinator.cancel).toHaveBeenCalledOnce());
    expect(transport.respond).not.toHaveBeenCalled();
    await bridge.stop();

    const global = createHarness();
    const globalTransport = createTransport();
    const globalBridge = new PluginSerialCapabilityBridge(global.gateway, globalTransport.port);
    await globalBridge.start();
    await acquire(global, 1);
    globalTransport.emit({ kind: 'revoke-all' });
    await vi.waitFor(() => expect(global.coordinator.cancel).toHaveBeenCalledOnce());
    expect(globalTransport.respond).not.toHaveBeenCalled();

    globalTransport.emit({ kind: 'revoke-runtime', context: { ...CONTEXT, generation: 0 } });
    globalTransport.emit({ kind: 'revoke-everything' });
    await Promise.resolve();
    expect(global.coordinator.cancel).toHaveBeenCalledOnce();
    await globalBridge.stop();
  });
});

function acquireOperation(): PluginHostV2SerialOperation {
  return {
    kind: 'acquire-serial-lease',
    sessionId: 'session-1',
    options: { pauseAutomation: true, rxBufferBytes: 1024 * 1024 },
  };
}

async function acquire(
  harness: ReturnType<typeof createHarness>,
  messageId: number,
): Promise<PluginHostV2ResourceBinding> {
  const response = await harness.gateway.invoke(CONTEXT, messageId, acquireOperation());
  expect(response).toMatchObject({ ok: true, result: { kind: 'acquire-serial-lease' } });
  if (!response?.ok || response.result.kind !== 'acquire-serial-lease') {
    throw new Error('expected acquired serial lease');
  }
  return response.result.lease;
}

function createHarness(
  options: {
    throwWindowSnapshot?: boolean;
    runtimeMissing?: boolean;
    resourceIdFactory?: () => string;
  } = {},
) {
  const token = 'coordinator-token' as SerialTransactionLeaseToken;
  const coordinatorHarness = createCoordinator(token);
  const sendBytesOutsideGate = vi.fn();
  const runtime: PluginSerialCapabilitySessionRuntime & { sendBytes: typeof sendBytesOutsideGate } =
    {
      sessionId: 'session-1',
      serialTransactions: coordinatorHarness.coordinator,
      sendBytes: sendBytesOutsideGate,
    };
  const currentRuntime = { value: runtime as PluginSerialCapabilitySessionRuntime };
  const listSessions = vi.fn((): readonly PluginHostV2SerialSession[] => [SESSION]);
  const createSessionSource = vi.fn(async () => SESSION);
  const updateSessionSource = vi.fn(async () => SESSION);
  const connectSessionSource = vi.fn(async () => SESSION);
  const disconnectSessionSource = vi.fn(async () => undefined);
  const deleteSessionSource = vi.fn(async () => undefined);
  const captureReadSource = vi.fn(async () => ({
    frames: [{ sequence: 40, timestampMs: 1_234, direction: 'rx' as const, payload: [1, 2, 3] }],
    nextSequence: 41,
  }));
  const authorityState = {
    mainWindow: true,
    workspaceId: CONTEXT.workspaceId as string | null,
    active: new Set([contextKey(CONTEXT)]),
    capabilities: new Set([
      'serial.ports.read',
      'serial.sessions.manage',
      'serial.io',
      'serial.control-lines',
      'session.capture.read',
    ]),
  };
  const authority: PluginSerialCapabilityAuthority = {
    windowSnapshot: () => {
      if (options.throwWindowSnapshot) throw new Error('window authority unavailable');
      return {
        mainWindow: authorityState.mainWindow,
        workspaceId: authorityState.workspaceId,
      };
    },
    isRuntimeActive: (context) => authorityState.active.has(contextKey(context)),
    hasCapability: (_context, capability) => authorityState.capabilities.has(capability),
  };
  const gateway = new PluginSerialCapabilityGateway({
    authority,
    sessions: {
      listSessions,
      runtimeForSession: (sessionId) =>
        !options.runtimeMissing && sessionId === 'session-1' ? currentRuntime.value : undefined,
      createSession: createSessionSource,
      updateSession: updateSessionSource,
      connectSession: connectSessionSource,
      disconnectSession: disconnectSessionSource,
      deleteSession: deleteSessionSource,
      captureRead: captureReadSource,
    },
    ports: {
      listPorts: () => [{ portId: 'port-1', displayName: 'USB UART' }],
    },
    resourceIdFactory: options.resourceIdFactory ?? (() => 'opaque-resource'),
  });
  return {
    gateway,
    authorityState,
    currentRuntime,
    listSessions,
    createSessionSource,
    updateSessionSource,
    connectSessionSource,
    disconnectSessionSource,
    deleteSessionSource,
    captureReadSource,
    token,
    sendBytesOutsideGate,
    ...coordinatorHarness,
  };
}

function createCoordinator(token = 'coordinator-token' as SerialTransactionLeaseToken) {
  const state: {
    phase: 'idle' | 'active';
    ownerId: string | null;
    generation: number | null;
  } = { phase: 'idle', ownerId: null, generation: null };
  const snapshot = vi.fn(() => ({
    phase: state.phase,
    ownerId: state.ownerId,
    generation: state.generation,
    bufferedRxBytes: 0,
    bufferedRxChunks: 0,
    manualWritesInFlight: 0,
    manualWriteAllowed: state.phase === 'idle',
    registeredAutomations: 4,
  }));
  const connectionSnapshot = vi.fn(() => ({
    generation: SESSION.generation,
    connected: SESSION.connected,
  }));
  const acquire = vi.fn(
    async (ownerId: string, options?: { signal?: AbortSignal; rxBufferBytes?: number }) => {
      if (options?.signal?.aborted) throw codedError('cancelled');
      state.phase = 'active';
      state.ownerId = ownerId;
      state.generation = SESSION.generation;
      return { token, ownerId, generation: SESSION.generation };
    },
  );
  const write = vi.fn(async (_token, payload: Uint8Array) => ({
    outcome: 'complete' as const,
    requestedBytes: payload.length,
    sentBytes: payload.length,
  }));
  const read = vi.fn(async () => Uint8Array.from([9, 8]));
  const clearBuffers = vi.fn(async () => undefined);
  const pendingBytes = vi.fn(async () => ({ rx: 11, tx: 2 }));
  const setOutputLines = vi.fn(async () => undefined);
  const readInputLines = vi.fn(async () => ({ cts: true, dsr: false, ri: false, cd: true }));
  const close = async (reason: 'released' | 'cancelled') => {
    state.phase = 'idle' as const;
    state.ownerId = null;
    state.generation = null;
    return {
      reason,
      generation: SESSION.generation,
      restoredAutomations: 4,
      restoreFailures: [],
      restoreSkipped: false,
      drainFailed: false,
    } as const;
  };
  const release = vi.fn(async () => close('released'));
  const cancel = vi.fn(async () => close('cancelled'));
  const coordinator = {
    snapshot,
    connectionSnapshot,
    acquire,
    write,
    read,
    clearBuffers,
    pendingBytes,
    setOutputLines,
    readInputLines,
    release,
    cancel,
  } as unknown as PluginSerialCapabilityCoordinator;
  return {
    coordinator,
    snapshot,
    connectionSnapshot,
    acquire,
    write,
    read,
    clearBuffers,
    pendingBytes,
    setOutputLines,
    readInputLines,
    release,
    cancel,
  };
}

function createTransport(afterListen?: () => void) {
  let listener: ((event: unknown) => void) | null = null;
  const unlisten = vi.fn(() => {
    listener = null;
  });
  const listen = vi.fn(async (next: (event: unknown) => void) => {
    listener = next;
    afterListen?.();
    return unlisten;
  });
  const respond = vi.fn(async (_event: PluginSerialCapabilityOutboundEvent) => undefined);
  const port: PluginSerialCapabilityTransport = { listen, respond };
  return {
    port,
    listen,
    respond,
    unlisten,
    emit(event: unknown): void {
      listener?.(event);
    },
  };
}

function contextKey(context: PluginHostV2GatewayContext): string {
  return `${context.workspaceId}:${context.pluginId}:${context.instanceId}:${context.generation}`;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal?.addEventListener('abort', () => resolve(), { once: true }),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}
