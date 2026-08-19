import type {
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceFramesResponse,
  PluginSerialCaptureFrameV2,
  PluginSerialCreateSessionV2,
  PluginSerialPortV2,
  PluginSerialSessionV2,
} from '../../../generated/ipc-contracts';
import type { DataFrame, PortConfig, SerialSession } from '../../../types';
import { base64ToBytes } from '../../../lib/base64';
import { DEFAULT_RX_FRAME_GAP_MS } from '../../../lib/serial-framing';
import type { PluginCenterService } from '../plugin-center-service';
import {
  PluginSerialCapabilityGateway,
  type PluginHostV2GatewayContext,
  type PluginHostV2SerialPort,
  type PluginHostV2SerialSession,
  type PluginSerialCapabilitySessionRuntime,
  type PluginSerialCapabilitySessionSource,
} from './plugin-serial-capability-gateway';

export interface PluginSerialCapabilityManagedRuntime extends PluginSerialCapabilitySessionRuntime {
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface PluginSerialCapabilityRuntimeRegistry {
  get(sessionId: string): PluginSerialCapabilityManagedRuntime | undefined;
  ensure(session: SerialSession): Promise<PluginSerialCapabilityManagedRuntime>;
  disposeSession(sessionId: string): Promise<void>;
}

export interface PluginSerialCapabilityWorkspaceSource {
  snapshot(): Readonly<{
    currentWorkspace: Readonly<{ workspaceId: string; revision: number }> | null;
    acceptsSaves: boolean;
    readOnly: boolean;
    unsavedMutationCount: number;
  }>;
  captureSeqCeiling(sessionId: string): number | null;
  flush(): Promise<
    | Readonly<{
        outcome: 'completed';
        value: Readonly<{ workspaceId: string; revision: number }>;
      }>
    | Readonly<{ outcome: 'cancelled' | 'stale' }>
    | Readonly<{ outcome: 'failed'; messageKey: string; code?: string }>
  >;
}

export interface PluginSerialCapabilityCaptureHydrationPort {
  hydrateFrames(request: HydrateWorkspaceFramesRequest): Promise<HydrateWorkspaceFramesResponse>;
}

export interface PluginSerialCapabilitySessionCatalog {
  readonly sessions: readonly SerialSession[];
  createSession(
    portName: string,
    portConfig: PortConfig,
    options?: Readonly<{ lifetime?: 'persistent' | 'runtime'; displayName?: string }>,
  ): string | null;
  createRuntimeSession(
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): string | null;
  removeSession(sessionId: string): Promise<unknown>;
  removeRuntimeSession(sessionId: string): Promise<unknown>;
  updateSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean;
  updateRuntimeSessionConnectionSettings(
    sessionId: string,
    portName: string,
    portConfig: PortConfig,
    displayName?: string,
  ): boolean;
  isPersistentSession(sessionId: string): boolean;
}

export interface PluginSerialCapabilityPhysicalPortSource {
  readonly availablePorts: readonly string[];
}

export interface PluginSerialCapabilityCompositionOptions {
  readonly pluginCenter: Pick<PluginCenterService, 'snapshot'>;
  readonly workspace: PluginSerialCapabilityWorkspaceSource;
  readonly sessions: PluginSerialCapabilitySessionCatalog;
  readonly runtimes: PluginSerialCapabilityRuntimeRegistry;
  readonly ports: PluginSerialCapabilityPhysicalPortSource;
  /** Narrow native read port; it never exposes a project path or grant. */
  readonly workspaceFrames: PluginSerialCapabilityCaptureHydrationPort;
  /** Test seam; production uses a cryptographically random opaque alias. */
  readonly portIdFactory?: () => string;
  /** Test seam; production uses the protocol-v2 ordinary-call deadline. */
  readonly captureReadTimeoutMs?: number;
  /** Test seam; production uses a cryptographically random correlation ID. */
  readonly captureRequestIdFactory?: () => string;
}

const PERSISTED_CAPTURE_READ_TIMEOUT_MS = 2_000;
const PERSISTED_CAPTURE_FRAME_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Builds the one main-WebView serial gateway from application-owned authorities.
 * Session port paths are deliberately omitted from the plugin projection.
 */
export function createPluginSerialCapabilityGateway(
  options: PluginSerialCapabilityCompositionOptions,
): PluginSerialCapabilityGateway {
  const ports = new OpaquePluginSerialPortCatalog(options.ports, options.portIdFactory);
  const sessions = createManagedSessionSource(options, ports);
  return new PluginSerialCapabilityGateway({
    authority: {
      windowSnapshot: () => ({
        mainWindow: true,
        workspaceId: options.workspace.snapshot().currentWorkspace?.workspaceId ?? null,
      }),
      isRuntimeActive: (context) => activePlugin(options.pluginCenter, context) !== undefined,
      hasCapability: (context, capability) =>
        activePlugin(options.pluginCenter, context)?.effectiveCapabilities.includes(capability) ===
        true,
    },
    ports,
    sessions,
  });
}

class SerialCapabilityCompositionFailure extends Error {
  constructor(readonly code: string) {
    super(`plugin serial composition failed: ${code}`);
    this.name = 'SerialCapabilityCompositionFailure';
  }
}

/**
 * Memory-only bidirectional alias table. A removed path drops both mappings,
 * so reattaching the same device receives a new port ID and every stale guest
 * reference fails closed. Neither the aliases nor returned records contain a
 * native device path.
 */
class OpaquePluginSerialPortCatalog {
  private readonly idByPath = new Map<string, string>();
  private readonly pathById = new Map<string, string>();
  private readonly idFactory: () => string;
  private paths: readonly string[] = Object.freeze([]);

  constructor(
    private readonly source: PluginSerialCapabilityPhysicalPortSource,
    idFactory?: () => string,
  ) {
    this.idFactory = idFactory ?? securePortNonce;
    this.refresh();
  }

  refresh(): boolean {
    const next = Object.freeze(
      [...new Set(this.source.availablePorts.filter(validPhysicalPortPath))].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    const changed =
      next.length !== this.paths.length || next.some((path, index) => path !== this.paths[index]);
    if (!changed) return false;

    const live = new Set(next);
    for (const [path, id] of this.idByPath) {
      if (live.has(path)) continue;
      this.idByPath.delete(path);
      this.pathById.delete(id);
    }
    for (const path of next) {
      if (this.idByPath.has(path)) continue;
      const id = this.issueId();
      this.idByPath.set(path, id);
      this.pathById.set(id, path);
    }
    this.paths = next;
    return true;
  }

  listPorts(): readonly PluginHostV2SerialPort[] {
    this.refresh();
    return Object.freeze(
      this.paths.map((path) =>
        Object.freeze<PluginSerialPortV2>({
          portId: this.idByPath.get(path)!,
          displayName: serialPortDisplayName(path),
        }),
      ),
    );
  }

  resolve(portId: string): string | undefined {
    this.refresh();
    return this.pathById.get(portId);
  }

  idForPath(path: string): string | undefined {
    this.refresh();
    return this.idByPath.get(path);
  }

  private issueId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const nonce = this.idFactory().replaceAll('-', '');
      const id = `port:${nonce}`;
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !this.pathById.has(id)) return id;
    }
    throw new SerialCapabilityCompositionFailure('unavailable');
  }
}

function createManagedSessionSource(
  options: PluginSerialCapabilityCompositionOptions,
  ports: OpaquePluginSerialPortCatalog,
): PluginSerialCapabilitySessionSource {
  const runtimeSessions = new Map<string, Set<string>>();
  const localSessions = new Map<string, string>();

  const summary = (session: SerialSession): PluginHostV2SerialSession =>
    sessionSummary(session, options.runtimes, ports);

  const source: PluginSerialCapabilitySessionSource = {
    listSessions: () => options.sessions.sessions.map(summary),
    runtimeForSession: (sessionId) => options.runtimes.get(sessionId),
    async createSession(context, request, signal) {
      if (request.lifetime === 'persistent') assertWritableWorkspace(options.workspace, context);
      else assertCurrentWorkspace(options.workspace, context);
      throwIfAborted(signal);
      if (options.sessions.sessions.length >= 1_024) fail('limit-exceeded');
      const key = localSessionKey(context, request);
      const existingId = localSessions.get(key);
      if (existingId) {
        const existing = sessionById(options.sessions, existingId);
        if (existing) return summary(existing);
        localSessions.delete(key);
      }
      const portName = resolveOptionalPort(ports, request.portId);
      const id =
        request.lifetime === 'runtime'
          ? options.sessions.createRuntimeSession(
              portName,
              fromPluginConfig(request.config),
              request.name,
            )
          : options.sessions.createSession(portName, fromPluginConfig(request.config), {
              lifetime: 'persistent',
              displayName: request.name,
            });
      if (!id) fail('unavailable');
      localSessions.set(key, id);
      if (request.lifetime === 'runtime') {
        const owner = runtimeContextKey(context);
        const owned = runtimeSessions.get(owner) ?? new Set<string>();
        owned.add(id);
        runtimeSessions.set(owner, owned);
      }
      const created = sessionById(options.sessions, id);
      if (!created) fail('protocol-error');
      return summary(created);
    },
    async updateSession(context, requested, signal) {
      assertCurrentWorkspace(options.workspace, context);
      throwIfAborted(signal);
      const current = sessionById(options.sessions, requested.sessionId);
      if (!current) fail('not-found');
      const persistent = options.sessions.isPersistentSession(current.id);
      if (persistent) assertWritableWorkspace(options.workspace, context);
      else assertRuntimeOwner(runtimeSessions, context, current.id);
      const currentSummary = summary(current);
      if (
        currentSummary.generation !== requested.generation ||
        currentSummary.connected !== requested.connected
      ) {
        fail('stale-handle');
      }
      if (currentSummary.connected) fail('busy');
      const portName = resolveOptionalPort(ports, requested.portId);
      const updatedSettings = persistent
        ? options.sessions.updateSessionConnectionSettings(
            current.id,
            portName,
            fromPluginConfig(requested.config),
            requested.name,
          )
        : options.sessions.updateRuntimeSessionConnectionSettings(
            current.id,
            portName,
            fromPluginConfig(requested.config),
            requested.name,
          );
      if (!updatedSettings) fail('unavailable');
      const updated = sessionById(options.sessions, current.id);
      if (!updated) fail('protocol-error');
      return summary(updated);
    },
    async connectSession(_context, sessionId, signal) {
      throwIfAborted(signal);
      const session = sessionById(options.sessions, sessionId);
      if (!session) fail('not-found');
      if (!session.portName || !ports.idForPath(session.portName)) fail('unavailable');
      const runtime = await options.runtimes.ensure(session);
      throwIfAborted(signal);
      const connected = await runtime.connect();
      if (!connected) fail('io-error');
      if (signal.aborted) {
        await runtime.disconnect().catch(() => undefined);
        fail('cancelled');
      }
      return summary(session);
    },
    async disconnectSession(_context, sessionId, signal) {
      throwIfAborted(signal);
      const session = sessionById(options.sessions, sessionId);
      if (!session) fail('not-found');
      const runtime = options.runtimes.get(sessionId);
      if (runtime) await runtime.disconnect();
      throwIfAborted(signal);
    },
    async deleteSession(context, sessionId, signal) {
      assertCurrentWorkspace(options.workspace, context);
      throwIfAborted(signal);
      const session = sessionById(options.sessions, sessionId);
      if (!session) fail('not-found');
      const persistent = options.sessions.isPersistentSession(session.id);
      if (persistent) assertWritableWorkspace(options.workspace, context);
      else assertRuntimeOwner(runtimeSessions, context, session.id);
      await options.runtimes.disposeSession(sessionId);
      const removed = persistent
        ? await options.sessions.removeSession(sessionId)
        : await options.sessions.removeRuntimeSession(sessionId);
      if (!removed) fail('unavailable');
      forgetManagedSession(localSessions, runtimeSessions, sessionId);
    },
    async captureRead(context, request, signal) {
      assertCurrentWorkspace(options.workspace, context);
      throwIfAborted(signal);
      const session = sessionById(options.sessions, request.sessionId);
      if (!session) fail('not-found');
      return options.sessions.isPersistentSession(session.id)
        ? persistedCapturePage(options, context, session, request, signal)
        : captureMemoryPage(session, request, signal);
    },
    async revokeRuntime(context) {
      const owner = runtimeContextKey(context);
      const owned = [...(runtimeSessions.get(owner) ?? [])];
      runtimeSessions.delete(owner);
      let removed = 0;
      for (const sessionId of owned) {
        await options.runtimes.disposeSession(sessionId).catch(() => undefined);
        if (await options.sessions.removeRuntimeSession(sessionId)) removed += 1;
        forgetManagedSession(localSessions, runtimeSessions, sessionId);
      }
      return removed;
    },
    async revokeAll() {
      const ids = [...new Set([...runtimeSessions.values()].flatMap((owned) => [...owned]))];
      runtimeSessions.clear();
      let removed = 0;
      for (const sessionId of ids) {
        await options.runtimes.disposeSession(sessionId).catch(() => undefined);
        if (await options.sessions.removeRuntimeSession(sessionId)) removed += 1;
        forgetManagedSession(localSessions, runtimeSessions, sessionId);
      }
      return removed;
    },
  };
  return source;
}

function activePlugin(
  pluginCenter: Pick<PluginCenterService, 'snapshot'>,
  context: PluginHostV2GatewayContext,
) {
  return pluginCenter.snapshot().installed.find((plugin) => {
    const runtime = plugin.runtime;
    return (
      plugin.enabled &&
      plugin.status === 'running' &&
      runtime !== null &&
      runtime.workspaceId === context.workspaceId &&
      runtime.pluginId === context.pluginId &&
      String(runtime.instanceId) === context.instanceId &&
      runtime.generation === context.generation
    );
  });
}

function sessionSummary(
  session: SerialSession,
  runtimes: PluginSerialCapabilityRuntimeRegistry,
  ports: OpaquePluginSerialPortCatalog,
): PluginHostV2SerialSession {
  const runtime = runtimes.get(session.id);
  const connection = runtime?.serialTransactions.connectionSnapshot() ?? {
    generation: 0,
    connected: false,
  };
  const portId = session.portName ? ports.idForPath(session.portName) : undefined;
  return Object.freeze({
    sessionId: session.id,
    name: session.displayName?.trim() || serialPortDisplayName(session.portName),
    ...(portId === undefined ? {} : { portId }),
    config: Object.freeze({
      baudRate: session.portConfig.baudRate,
      dataBits: session.portConfig.dataBits,
      parity: parityValue(session.portConfig.parity),
      stopBits: session.portConfig.stopBits === 1 ? 1 : 3,
      flowControl: flowControlValue(session.portConfig.flowControl),
    }),
    connected: connection.connected,
    generation: connection.generation,
  });
}

function sessionById(
  sessions: PluginSerialCapabilitySessionCatalog,
  sessionId: string,
): SerialSession | undefined {
  return sessions.sessions.find((session) => session.id === sessionId);
}

function resolveOptionalPort(
  ports: OpaquePluginSerialPortCatalog,
  portId: string | undefined,
): string {
  if (portId === undefined) return '';
  const path = ports.resolve(portId);
  if (!path) fail('stale-handle');
  return path;
}

function fromPluginConfig(config: PluginSerialSessionV2['config']): PortConfig {
  const parity =
    config.parity === 1
      ? 'none'
      : config.parity === 2
        ? 'odd'
        : config.parity === 3
          ? 'even'
          : null;
  const stopBits = config.stopBits === 1 ? 1 : config.stopBits === 3 ? 2 : null;
  const flowControl =
    config.flowControl === 1
      ? 'none'
      : config.flowControl === 2
        ? 'software'
        : config.flowControl === 3
          ? 'hardware'
          : null;
  if (
    !Number.isSafeInteger(config.baudRate) ||
    config.baudRate < 1 ||
    config.baudRate > 0xffff_ffff ||
    ![5, 6, 7, 8].includes(config.dataBits) ||
    !parity ||
    !stopBits ||
    !flowControl
  ) {
    fail('invalid-input');
  }
  return {
    baudRate: config.baudRate,
    dataBits: config.dataBits as PortConfig['dataBits'],
    parity,
    stopBits,
    flowControl,
    rxFrameGapMs: DEFAULT_RX_FRAME_GAP_MS,
    dtr: false,
    rts: false,
  };
}

function captureMemoryPage(
  session: SerialSession,
  request: Readonly<{
    fromSequence: number;
    maxFrames: number;
    maxBytes: number;
  }>,
  signal: AbortSignal,
): Readonly<{ frames: readonly PluginSerialCaptureFrameV2[]; nextSequence?: number }> {
  const retained: readonly DataFrame[] = [...session.frames, ...session.pausedFrames];
  const ceiling = session.txFrames + session.rxFrames;
  if (!Number.isSafeInteger(ceiling) || ceiling < retained.length) {
    fail('unavailable');
  }
  const firstSequence = ceiling - retained.length;
  if (request.fromSequence < firstSequence) fail('stale-handle');
  let index = Math.max(0, request.fromSequence - firstSequence);
  const frames: PluginSerialCaptureFrameV2[] = [];
  let bytes = 0;
  while (index < retained.length && frames.length < request.maxFrames) {
    throwIfAborted(signal);
    const frame = retained[index]!;
    if (!(frame.data instanceof Uint8Array)) fail('protocol-error');
    if (bytes + frame.data.byteLength > request.maxBytes) {
      if (frames.length === 0) fail('limit-exceeded');
      break;
    }
    const sequence = firstSequence + index;
    if (
      !Number.isSafeInteger(sequence) ||
      !Number.isSafeInteger(frame.timestamp) ||
      frame.timestamp < 0
    ) {
      fail('protocol-error');
    }
    frames.push(
      Object.freeze({
        sequence,
        timestampMs: frame.timestamp,
        direction: frame.direction === 'RX' ? 'rx' : 'tx',
        payload: Array.from(frame.data),
      }),
    );
    bytes += frame.data.byteLength;
    index += 1;
  }
  return Object.freeze({
    frames: Object.freeze(frames),
    ...(index < retained.length ? { nextSequence: firstSequence + index } : {}),
  });
}

async function persistedCapturePage(
  options: PluginSerialCapabilityCompositionOptions,
  context: PluginHostV2GatewayContext,
  session: SerialSession,
  request: Readonly<{
    fromSequence: number;
    maxFrames: number;
    maxBytes: number;
  }>,
  parentSignal: AbortSignal,
): Promise<Readonly<{ frames: readonly PluginSerialCaptureFrameV2[]; nextSequence?: number }>> {
  const timeoutMs = captureReadTimeout(options.captureReadTimeoutMs);
  return withCaptureDeadline(parentSignal, timeoutMs, async (signal) => {
    assertCurrentWorkspace(options.workspace, context);
    const barrierCeiling = options.workspace.captureSeqCeiling(session.id);
    if (barrierCeiling === null || !Number.isSafeInteger(barrierCeiling) || barrierCeiling < 0) {
      fail('unavailable');
    }

    const before = options.workspace.snapshot();
    const beforeWorkspace = before.currentWorkspace;
    if (!beforeWorkspace || beforeWorkspace.workspaceId !== context.workspaceId) {
      fail('stale-handle');
    }
    let barrierRevision = beforeWorkspace.revision;
    if (!validRevision(barrierRevision) || !Number.isSafeInteger(before.unsavedMutationCount)) {
      fail('unavailable');
    }

    // A read-only workspace cannot acquire a native write flush, but with no
    // queued mutations it already is a stable durability barrier.
    if (before.readOnly) {
      if (before.unsavedMutationCount !== 0) fail('unavailable');
    } else {
      if (!before.acceptsSaves) fail('unavailable');
      const flushed = await awaitCaptureStep(options.workspace.flush(), signal);
      switch (flushed.outcome) {
        case 'completed':
          if (flushed.value.workspaceId !== context.workspaceId) fail('stale-handle');
          if (!validRevision(flushed.value.revision)) fail('protocol-error');
          barrierRevision = flushed.value.revision;
          break;
        case 'cancelled':
          return fail('cancelled');
        case 'stale':
          return fail('stale-handle');
        case 'failed':
          return fail(flushed.code === 'WORKSPACE_READ_ONLY' ? 'unavailable' : 'io-error');
      }
    }

    throwIfAborted(signal);
    assertCurrentWorkspace(options.workspace, context);
    if (request.fromSequence >= barrierCeiling) {
      return Object.freeze({ frames: Object.freeze([]) });
    }

    const requestId = captureRequestId(options.captureRequestIdFactory);
    const hydrateRequest: HydrateWorkspaceFramesRequest = {
      requestId,
      workspaceId: context.workspaceId,
      sessionId: session.id,
      fromSeq: request.fromSequence,
      limit: request.maxFrames,
    };
    const response = await awaitCaptureStep(
      options.workspaceFrames.hydrateFrames(hydrateRequest),
      signal,
    );
    throwIfAborted(signal);
    assertCurrentWorkspace(options.workspace, context);
    return mapPersistedCapturePage(
      response,
      hydrateRequest,
      barrierRevision,
      barrierCeiling,
      request.maxBytes,
    );
  });
}

function mapPersistedCapturePage(
  response: HydrateWorkspaceFramesResponse,
  request: HydrateWorkspaceFramesRequest,
  barrierRevision: number,
  barrierCeiling: number,
  maxBytes: number,
): Readonly<{ frames: readonly PluginSerialCaptureFrameV2[]; nextSequence?: number }> {
  if (
    !response ||
    response.requestId !== request.requestId ||
    response.workspaceId !== request.workspaceId ||
    response.sessionId !== request.sessionId ||
    !validRevision(response.revision) ||
    response.revision < barrierRevision ||
    !Array.isArray(response.frames) ||
    response.frames.length > request.limit
  ) {
    fail('protocol-error');
  }
  if (response.frames.length === 0) fail('stale-handle');
  const lastResponseFrame = response.frames.at(-1);
  if (
    response.nextSeq !== undefined &&
    (!Number.isSafeInteger(response.nextSeq) ||
      !lastResponseFrame ||
      response.nextSeq <= lastResponseFrame.seq)
  ) {
    fail('protocol-error');
  }
  const first = response.frames[0];
  if (!first || !Number.isSafeInteger(first.seq) || first.seq < request.fromSeq) {
    fail('protocol-error');
  }
  if (first.seq > request.fromSeq) fail('stale-handle');

  const frames: PluginSerialCaptureFrameV2[] = [];
  let expected = request.fromSeq;
  let bytes = 0;
  let nextSequence: number | undefined;
  for (const persisted of response.frames) {
    if (!Number.isSafeInteger(persisted.seq) || persisted.seq !== expected) {
      fail('protocol-error');
    }
    if (persisted.seq >= barrierCeiling) break;
    const frame = decodePersistedCaptureFrame(persisted);
    if (bytes + frame.data.byteLength > maxBytes) {
      if (frames.length === 0) fail('limit-exceeded');
      nextSequence = persisted.seq;
      break;
    }
    frames.push(
      Object.freeze({
        sequence: persisted.seq,
        timestampMs: frame.timestamp,
        direction: frame.direction === 'RX' ? 'rx' : 'tx',
        payload: Array.from(frame.data),
      }),
    );
    bytes += frame.data.byteLength;
    expected += 1;
  }

  if (nextSequence === undefined && expected < barrierCeiling) {
    if (response.nextSeq === undefined) fail('protocol-error');
    if (!Number.isSafeInteger(response.nextSeq) || response.nextSeq !== expected) {
      fail('protocol-error');
    }
    nextSequence = response.nextSeq;
  }
  if (nextSequence !== undefined && nextSequence >= barrierCeiling) nextSequence = undefined;
  return Object.freeze({
    frames: Object.freeze(frames),
    ...(nextSequence === undefined ? {} : { nextSequence }),
  });
}

function decodePersistedCaptureFrame(frame: HydrateWorkspaceFramesResponse['frames'][number]): {
  readonly timestamp: number;
  readonly direction: 'RX' | 'TX';
  readonly data: Uint8Array;
} {
  if (
    typeof frame.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frame.id) ||
    (frame.direction !== 'RX' && frame.direction !== 'TX') ||
    !Number.isSafeInteger(frame.timestampMs) ||
    frame.timestampMs < 0 ||
    (frame.txStatus !== undefined &&
      frame.txStatus !== 'complete' &&
      frame.txStatus !== 'partial-unknown') ||
    !optionalCounter(frame.requestedBytes) ||
    !optionalCounter(frame.omittedBytes) ||
    (frame.direction === 'RX' &&
      (frame.txStatus !== undefined || frame.requestedBytes !== undefined))
  ) {
    fail('protocol-error');
  }

  let data: Uint8Array;
  if (frame.dataB64 !== undefined) {
    if (
      typeof frame.dataB64 !== 'string' ||
      frame.dataB64.length > Math.ceil(PERSISTED_CAPTURE_FRAME_MAX_BYTES / 3) * 4 ||
      !Array.isArray(frame.data) ||
      frame.data.length !== 0
    ) {
      fail('protocol-error');
    }
    try {
      data = base64ToBytes(frame.dataB64);
    } catch {
      fail('protocol-error');
    }
  } else {
    if (
      !Array.isArray(frame.data) ||
      frame.data.length > PERSISTED_CAPTURE_FRAME_MAX_BYTES ||
      !frame.data.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xff)
    ) {
      fail('protocol-error');
    }
    data = Uint8Array.from(frame.data);
  }
  if (
    data.byteLength > PERSISTED_CAPTURE_FRAME_MAX_BYTES ||
    (frame.requestedBytes !== undefined && frame.requestedBytes < data.byteLength)
  ) {
    fail('protocol-error');
  }
  return Object.freeze({ timestamp: frame.timestampMs, direction: frame.direction, data });
}

function optionalCounter(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

async function withCaptureDeadline<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  parentSignal.addEventListener('abort', cancel, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await runCaptureRace(run(controller.signal), controller.signal, () =>
      timedOut ? 'timeout' : 'cancelled',
    );
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}

function awaitCaptureStep<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return runCaptureRace(promise, signal, () => 'cancelled');
}

function runCaptureRace<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortCode: () => 'cancelled' | 'timeout',
): Promise<T> {
  if (signal.aborted) fail(abortCode());
  let remove: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = () => reject(new SerialCapabilityCompositionFailure(abortCode()));
    signal.addEventListener('abort', listener, { once: true });
    remove = () => signal.removeEventListener('abort', listener);
  });
  return Promise.race([promise, aborted]).finally(remove);
}

function captureReadTimeout(value: number | undefined): number {
  const timeout = value ?? PERSISTED_CAPTURE_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > PERSISTED_CAPTURE_READ_TIMEOUT_MS
  ) {
    fail('invalid-input');
  }
  return timeout;
}

function captureRequestId(factory: (() => string) | undefined): string {
  const value = factory?.() ?? globalThis.crypto?.randomUUID?.();
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('unavailable');
  }
  return value;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function localSessionKey(
  context: PluginHostV2GatewayContext,
  request: Readonly<PluginSerialCreateSessionV2>,
): string {
  const scope =
    request.lifetime === 'runtime'
      ? runtimeContextKey(context)
      : `${context.workspaceId}\u0000${context.pluginId}`;
  return `${scope}\u0000${request.lifetime}\u0000${request.localId}`;
}

function runtimeContextKey(context: PluginHostV2GatewayContext): string {
  return `${context.workspaceId}\u0000${context.pluginId}\u0000${context.instanceId}\u0000${context.generation}`;
}

function assertRuntimeOwner(
  runtimeSessions: ReadonlyMap<string, ReadonlySet<string>>,
  context: PluginHostV2GatewayContext,
  sessionId: string,
): void {
  if (runtimeSessions.get(runtimeContextKey(context))?.has(sessionId) !== true) {
    fail('permission-denied');
  }
}

function forgetManagedSession(
  localSessions: Map<string, string>,
  runtimeSessions: Map<string, Set<string>>,
  sessionId: string,
): void {
  for (const [key, value] of localSessions) {
    if (value === sessionId) localSessions.delete(key);
  }
  for (const [owner, ids] of runtimeSessions) {
    ids.delete(sessionId);
    if (ids.size === 0) runtimeSessions.delete(owner);
  }
}

function assertCurrentWorkspace(
  workspace: PluginSerialCapabilityWorkspaceSource,
  context: PluginHostV2GatewayContext,
): void {
  if (workspace.snapshot().currentWorkspace?.workspaceId !== context.workspaceId) {
    fail('stale-handle');
  }
}

function assertWritableWorkspace(
  workspace: PluginSerialCapabilityWorkspaceSource,
  context: PluginHostV2GatewayContext,
): void {
  assertCurrentWorkspace(workspace, context);
  const snapshot = workspace.snapshot();
  if (!snapshot.acceptsSaves || snapshot.readOnly) fail('unavailable');
}

function validPhysicalPortPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1_024) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function securePortNonce(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('unavailable');
  return globalThis.crypto.randomUUID();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) fail('cancelled');
}

function fail(code: string): never {
  throw new SerialCapabilityCompositionFailure(code);
}

function serialPortDisplayName(portName: string): string {
  const normalized = portName.trim().replaceAll('\\', '/');
  const displayName = normalized.split('/').filter(Boolean).at(-1)?.trim();
  return displayName || 'Serial session';
}

function parityValue(value: SerialSession['portConfig']['parity']): number {
  if (value === 'odd') return 2;
  if (value === 'even') return 3;
  return 1;
}

function flowControlValue(value: SerialSession['portConfig']['flowControl']): number {
  if (value === 'software') return 2;
  if (value === 'hardware') return 3;
  return 1;
}
