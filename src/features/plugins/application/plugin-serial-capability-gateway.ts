import type {
  PluginGatewayContextV2,
  PluginResourceBindingV2,
  PluginSerialCapabilityInboundV2,
  PluginSerialCapabilityOperationV2,
  PluginSerialCapabilityOutboundV2,
  PluginSerialCapabilityResponseV2,
  PluginSerialCapabilityResultV2,
  PluginSerialCaptureFrameV2,
  PluginSerialConfigV2,
  PluginSerialCreateSessionV2,
  PluginSerialPortV2,
  PluginSerialSessionV2,
  SerialSendResult,
} from '../../../generated/ipc-contracts';
import {
  SERIAL_TRANSACTION_LEASE_LIMITS,
  type SerialTransactionLeaseCoordinator,
  type SerialTransactionLeaseErrorCode,
  type SerialTransactionLeaseReleaseResult,
  type SerialTransactionLeaseToken,
} from '../../serial';

export const PLUGIN_SERIAL_CAPABILITY_LIMITS = Object.freeze({
  identityCharacters: 128,
  displayNameCharacters: 512,
  resourceIdCharacters: 256,
  sessionCount: 1_024,
  portCount: 1_024,
  captureFrames: 1_024,
  captureBytes: 256 * 1024,
  writeBytes: SERIAL_TRANSACTION_LEASE_LIMITS.writeBytes,
  readBytes: SERIAL_TRANSACTION_LEASE_LIMITS.readBytes,
  readTimeoutMs: SERIAL_TRANSACTION_LEASE_LIMITS.readTimeoutMs,
});

export type PluginSerialCapabilityName =
  | 'serial.ports.read'
  | 'serial.sessions.manage'
  | 'serial.io'
  | 'serial.control-lines'
  | 'session.capture.read';

/** Read-only application views of the Rust-generated v2 renderer contracts. */
export type PluginHostV2GatewayContext = Readonly<PluginGatewayContextV2>;
export type PluginHostV2ResourceBinding = Readonly<PluginResourceBindingV2>;
export type PluginHostV2SerialConfig = Readonly<PluginSerialConfigV2>;
export type PluginHostV2SerialPort = Readonly<PluginSerialPortV2>;
export type PluginHostV2SerialSession = Readonly<PluginSerialSessionV2>;

/**
 * Closed projection of the serial subset of `generated_v2::request::Operation`.
 * The eventual native adapter performs the mechanical Protobuf conversion.
 */
export type PluginHostV2SerialOperation = Readonly<PluginSerialCapabilityOperationV2>;

/** Closed projection of the matching `generated_v2::response::Result` variants. */
export type PluginHostV2SerialResult = Readonly<PluginSerialCapabilityResultV2>;

export type PluginSerialCapabilityRequestEvent = Readonly<
  Extract<PluginSerialCapabilityInboundV2, { kind: 'request' }>
>;

export type PluginSerialCapabilityCancelEvent = Readonly<
  Extract<PluginSerialCapabilityInboundV2, { kind: 'cancel' }>
>;

export type PluginSerialCapabilityInboundEvent = Readonly<PluginSerialCapabilityInboundV2>;

export type PluginSerialCapabilityResponse =
  | Readonly<
      Omit<PluginSerialCapabilityResponseV2, 'ok' | 'result' | 'errorCode'> & {
        ok: true;
        result: PluginHostV2SerialResult;
        errorCode?: never;
      }
    >
  | Readonly<
      Omit<PluginSerialCapabilityResponseV2, 'ok' | 'result' | 'errorCode'> & {
        ok: false;
        errorCode: SerialTransactionLeaseErrorCode;
        result?: never;
      }
    >;

export type PluginSerialCapabilityOutboundEvent = Readonly<PluginSerialCapabilityOutboundV2>;

export type PluginSerialCapabilityCoordinator = Pick<
  SerialTransactionLeaseCoordinator<SerialSendResult>,
  | 'snapshot'
  | 'connectionSnapshot'
  | 'acquire'
  | 'write'
  | 'read'
  | 'clearBuffers'
  | 'pendingBytes'
  | 'setOutputLines'
  | 'readInputLines'
  | 'release'
  | 'cancel'
>;

export interface PluginSerialCapabilitySessionRuntime {
  readonly sessionId: string;
  readonly serialTransactions: PluginSerialCapabilityCoordinator;
}

export interface PluginSerialCapabilitySessionSource {
  listSessions(): readonly PluginHostV2SerialSession[];
  runtimeForSession(sessionId: string): PluginSerialCapabilitySessionRuntime | undefined;
  createSession?(
    context: PluginHostV2GatewayContext,
    request: Readonly<PluginSerialCreateSessionV2>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialSession>;
  updateSession?(
    context: PluginHostV2GatewayContext,
    session: PluginHostV2SerialSession,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialSession>;
  connectSession?(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialSession>;
  disconnectSession?(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void>;
  deleteSession?(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void>;
  captureRead?(
    context: PluginHostV2GatewayContext,
    request: Readonly<{
      sessionId: string;
      fromSequence: number;
      maxFrames: number;
      maxBytes: number;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ frames: readonly PluginSerialCaptureFrameV2[]; nextSequence?: number }>>;
  /** Removes only runtime-lifetime sessions owned by this exact runtime. */
  revokeRuntime?(context: PluginHostV2GatewayContext): Promise<number>;
  /** Removes every runtime-lifetime plugin session; persistent sessions remain. */
  revokeAll?(): Promise<number>;
}

export interface PluginSerialCapabilityPortSource {
  listPorts(): readonly PluginHostV2SerialPort[];
  /** Refreshes opaque aliases and returns true only when physical membership changed. */
  refresh?(): boolean;
}

export interface PluginSerialCapabilityWindowSnapshot {
  readonly mainWindow: boolean;
  readonly workspaceId: string | null;
}

/** Must be backed by native runtime state, never request fields alone. */
export interface PluginSerialCapabilityAuthority {
  windowSnapshot(): PluginSerialCapabilityWindowSnapshot;
  isRuntimeActive(context: PluginHostV2GatewayContext): boolean;
  hasCapability(
    context: PluginHostV2GatewayContext,
    capability: PluginSerialCapabilityName,
  ): boolean;
}

export interface PluginSerialCapabilityTransport {
  listen(listener: (event: unknown) => void): Promise<() => void>;
  respond(event: PluginSerialCapabilityOutboundEvent): Promise<void>;
}

export interface PluginSerialCapabilityGatewayOptions {
  readonly authority: PluginSerialCapabilityAuthority;
  readonly sessions: PluginSerialCapabilitySessionSource;
  readonly ports?: PluginSerialCapabilityPortSource;
  /** Test seam; production uses `crypto.randomUUID`. */
  readonly resourceIdFactory?: () => string;
}

interface ParsedInvocation {
  readonly context: PluginHostV2GatewayContext;
  readonly messageId: number;
  readonly operation: PluginHostV2SerialOperation;
}

interface ActiveInvocation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

interface LeaseBinding {
  readonly binding: PluginHostV2ResourceBinding;
  readonly contextKey: string;
  readonly sessionId: string;
  readonly runtime: PluginSerialCapabilitySessionRuntime;
  readonly coordinator: PluginSerialCapabilityCoordinator;
  readonly ownerId: string;
  readonly token: SerialTransactionLeaseToken;
  readonly sessionGeneration: number;
  closeTask: Promise<SerialTransactionLeaseReleaseResult> | null;
}

type Authorization =
  | Readonly<{ status: 'authorized' }>
  | Readonly<{ status: 'silent' }>
  | Readonly<{ status: 'error'; code: SerialTransactionLeaseErrorCode }>;

const ERROR_CODES = new Set<SerialTransactionLeaseErrorCode>([
  'invalid-input',
  'permission-denied',
  'unavailable',
  'busy',
  'not-found',
  'stale-handle',
  'disconnected',
  'timeout',
  'cancelled',
  'limit-exceeded',
  'partial-write',
  'unknown-outcome',
  'protocol-error',
  'io-error',
]);

class GatewayFailure extends Error {
  constructor(readonly code: SerialTransactionLeaseErrorCode) {
    super(`plugin serial capability failed: ${code}`);
    this.name = 'GatewayFailure';
  }
}

/**
 * Main-WebView application gateway for the serial portion of protocol v2.
 * Resource IDs are opaque aliases; coordinator lease tokens never cross IPC.
 */
export class PluginSerialCapabilityGateway {
  private readonly authority: PluginSerialCapabilityAuthority;
  private readonly sessions: PluginSerialCapabilitySessionSource;
  private readonly ports?: PluginSerialCapabilityPortSource;
  private readonly resourceIdFactory: () => string;
  private readonly handles = new Map<string, LeaseBinding>();
  private readonly handleByRuntime = new Map<string, LeaseBinding>();
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  private readonly lastMessageByRuntime = new Map<string, number>();
  private resourceSequence = 0;

  constructor(options: PluginSerialCapabilityGatewayOptions) {
    this.authority = options.authority;
    this.sessions = options.sessions;
    this.ports = options.ports;
    this.resourceIdFactory = options.resourceIdFactory ?? secureResourceNonce;
  }

  canRespond(): boolean {
    try {
      return this.authority.windowSnapshot().mainWindow === true;
    } catch {
      return false;
    }
  }

  refreshPortCatalog(): boolean {
    try {
      return this.ports?.refresh?.() === true;
    } catch {
      return false;
    }
  }

  /** Maps directly to `PluginCapabilityGateway::invoke(context, message_id, operation)`. */
  async invoke(
    contextValue: unknown,
    messageIdValue: unknown,
    operationValue: unknown,
  ): Promise<PluginSerialCapabilityResponse | null> {
    const invocation = parseInvocation(contextValue, messageIdValue, operationValue);
    if (!invocation) return null;
    const { context, messageId, operation } = invocation;
    const initial = this.authorize(context, capabilityFor(operation));
    if (initial.status === 'silent') {
      await this.revokeAll();
      return null;
    }
    if (initial.status === 'error') {
      await this.revokeRuntime(context);
      return failureResponse(invocation, initial.code);
    }

    const key = contextKey(context);
    const previous = this.lastMessageByRuntime.get(key) ?? 0;
    const invocationKey = messageKey(key, messageId);
    if (this.activeInvocations.has(invocationKey)) return null;
    if (messageId <= previous) return failureResponse(invocation, 'protocol-error');
    this.lastMessageByRuntime.set(key, messageId);

    const active = deferredInvocation();
    this.activeInvocations.set(invocationKey, active);
    try {
      let result: PluginHostV2SerialResult;
      try {
        result = await this.execute(context, operation, active.controller.signal);
      } catch (error) {
        return failureResponse(invocation, classifyError(error));
      }

      const finalAuthorization = this.authorize(context, capabilityFor(operation));
      if (finalAuthorization.status === 'silent') {
        await this.revokeRuntimeInternal(context, invocationKey);
        return null;
      }
      if (finalAuthorization.status === 'error') {
        await this.revokeRuntimeInternal(context, invocationKey);
        return failureResponse(
          invocation,
          operation.kind === 'serial-write' ||
            operation.kind === 'clear-serial-buffers' ||
            operation.kind === 'set-output-lines'
            ? 'unknown-outcome'
            : finalAuthorization.code,
        );
      }
      return successResponse(invocation, result);
    } finally {
      this.activeInvocations.delete(invocationKey);
      active.settle();
    }
  }

  /** Maps directly to `PluginCapabilityGateway::cancel(context, target_message_id)`. */
  async cancel(
    contextValue: unknown,
    targetMessageIdValue: unknown,
  ): Promise<
    | Readonly<{ ok: true; context: PluginHostV2GatewayContext; targetMessageId: number }>
    | Readonly<{
        ok: false;
        context: PluginHostV2GatewayContext;
        targetMessageId: number;
        errorCode: SerialTransactionLeaseErrorCode;
      }>
    | null
  > {
    const context = parseContext(contextValue);
    if (!context || !validMessageId(targetMessageIdValue)) return null;
    const authorization = this.authorize(context, 'serial.io');
    if (authorization.status === 'silent') {
      await this.revokeAll();
      return null;
    }
    if (authorization.status === 'error') {
      await this.revokeRuntime(context);
      return {
        ok: false,
        context,
        targetMessageId: targetMessageIdValue,
        errorCode: authorization.code,
      };
    }

    const key = contextKey(context);
    const active = this.activeInvocations.get(messageKey(key, targetMessageIdValue));
    if (!active) {
      return { ok: false, context, targetMessageId: targetMessageIdValue, errorCode: 'not-found' };
    }
    active.controller.abort();
    const binding = this.handleByRuntime.get(key);
    if (binding) await this.closeBinding(binding, 'cancel');
    await active.settled;
    return { ok: true, context, targetMessageId: targetMessageIdValue };
  }

  /** Runtime shutdown/disable must call this even when no request is active. */
  async revokeRuntime(contextValue: unknown): Promise<number> {
    const context = parseContext(contextValue);
    if (!context) return 0;
    return this.revokeRuntimeInternal(context);
  }

  private async revokeRuntimeInternal(
    context: PluginHostV2GatewayContext,
    excludedInvocationKey?: string,
  ): Promise<number> {
    const key = contextKey(context);
    const active = [...this.activeInvocations.entries()].filter(
      ([entry]) => entry !== excludedInvocationKey && entry.startsWith(`${key}\u0000`),
    );
    for (const [, invocation] of active) invocation.controller.abort();
    const binding = this.handleByRuntime.get(key);
    if (binding) await this.closeBinding(binding, 'cancel');
    if (excludedInvocationKey === undefined) {
      await Promise.allSettled(active.map(([, invocation]) => invocation.settled));
    }
    let removedRuntimeSessions = 0;
    if (this.sessions.revokeRuntime) {
      try {
        removedRuntimeSessions = await this.sessions.revokeRuntime(context);
      } catch {
        // Runtime teardown remains best-effort here; native lifecycle retries
        // revoke on the workspace/plugin shutdown boundary.
      }
    }
    this.lastMessageByRuntime.delete(key);
    return active.length + (binding ? 1 : 0) + removedRuntimeSessions;
  }

  async revokeAll(): Promise<number> {
    const active = [...this.activeInvocations.values()];
    for (const invocation of active) invocation.controller.abort();
    const bindings = [...this.handles.values()];
    await Promise.allSettled(bindings.map((binding) => this.closeBinding(binding, 'cancel')));
    await Promise.allSettled(active.map((invocation) => invocation.settled));
    let removedRuntimeSessions = 0;
    if (this.sessions.revokeAll) {
      try {
        removedRuntimeSessions = await this.sessions.revokeAll();
      } catch {
        // The surrounding workspace/application lifecycle also reconciles the
        // session catalog; never retain tokens merely because cleanup failed.
      }
    }
    this.lastMessageByRuntime.clear();
    return active.length + bindings.length + removedRuntimeSessions;
  }

  async abandonResponse(response: PluginSerialCapabilityResponse): Promise<void> {
    if (!response.ok || response.result.kind !== 'acquire-serial-lease') return;
    await this.revokeLease(
      response.context,
      response.result.lease,
      response.result.sessionGeneration,
    );
  }

  /**
   * Reclaims one renderer lease whose successful acquire result never became
   * guest-owned. This intentionally bypasses current runtime authorization:
   * cleanup must still work after cancellation, while the complete opaque
   * binding and serial generation prevent a stale event from closing another
   * runtime's lease.
   */
  async revokeLease(
    contextValue: unknown,
    resourceValue: unknown,
    sessionGenerationValue: unknown,
  ): Promise<boolean> {
    const context = parseContext(contextValue);
    const resource = parseResource(resourceValue);
    if (
      !context ||
      !resource ||
      !validPositiveInteger(sessionGenerationValue) ||
      !resourceBinds(context, resource)
    ) {
      return false;
    }
    const binding = this.handles.get(resource.resourceId);
    if (
      !binding ||
      binding.contextKey !== contextKey(context) ||
      !sameResourceBinding(binding.binding, resource) ||
      binding.sessionGeneration !== sessionGenerationValue
    ) {
      return false;
    }
    try {
      await this.closeBinding(binding, 'cancel');
      return true;
    } catch {
      // `closeBinding` detaches in a finally block. A failed coordinator close
      // cannot leave an opaque token addressable or make a duplicate event act
      // on a later binding.
      return false;
    }
  }

  private authorize(
    _context: PluginHostV2GatewayContext,
    _capability?: PluginSerialCapabilityName,
  ): Authorization {
    try {
      if (!this.authority.windowSnapshot().mainWindow) return { status: 'silent' };
    } catch {
      return { status: 'silent' };
    }
    // Native already owns the plugin instance and capability set before it
    // emits this main-window-only request. Re-validating a renderer snapshot
    // here created a lifecycle cycle: a starting plugin could not call the
    // host, while it could not become running until that call completed.
    return { status: 'authorized' };
  }

  private execute(
    context: PluginHostV2GatewayContext,
    operation: PluginHostV2SerialOperation,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    switch (operation.kind) {
      case 'list-ports':
        return Promise.resolve({ kind: 'list-ports', ports: [...this.portSummaries()] });
      case 'list-sessions':
        return Promise.resolve({ kind: 'list-sessions', sessions: [...this.sessionSummaries()] });
      case 'create-session':
        return this.createSession(context, operation.request, signal);
      case 'update-session':
        return this.updateSession(context, operation.session, signal);
      case 'connect-session':
        return this.connectSession(context, operation.sessionId, signal);
      case 'disconnect-session':
        return this.disconnectSession(context, operation.sessionId, signal);
      case 'delete-session':
        return this.deleteSession(context, operation.sessionId, signal);
      case 'acquire-serial-lease':
        return this.acquire(context, operation, signal);
      case 'release-serial-lease':
        return this.release(context, operation.lease);
      case 'serial-read':
        return this.read(context, operation, signal);
      case 'serial-write':
        return this.write(context, operation, signal);
      case 'clear-serial-buffers':
        return this.clearBuffers(context, operation, signal);
      case 'pending-serial-bytes':
        return this.pendingBytes(context, operation, signal);
      case 'set-output-lines':
        return this.setOutputLines(context, operation, signal);
      case 'read-input-lines':
        return this.readInputLines(context, operation, signal);
      case 'capture-read':
        return this.captureRead(context, operation, signal);
    }
  }

  private portSummaries(): readonly PluginHostV2SerialPort[] {
    if (!this.ports) throw new GatewayFailure('unavailable');
    let ports: readonly PluginHostV2SerialPort[];
    try {
      ports = this.ports.listPorts();
    } catch {
      throw new GatewayFailure('unavailable');
    }
    if (!Array.isArray(ports)) throw new GatewayFailure('protocol-error');
    if (ports.length > PLUGIN_SERIAL_CAPABILITY_LIMITS.portCount) {
      throw new GatewayFailure('limit-exceeded');
    }
    const seen = new Set<string>();
    return Object.freeze(
      ports.map((value) => {
        const port = normalizePort(value);
        if (seen.has(port.portId)) throw new GatewayFailure('protocol-error');
        seen.add(port.portId);
        return port;
      }),
    );
  }

  private sessionSummaries(): readonly PluginHostV2SerialSession[] {
    let sessions: readonly PluginHostV2SerialSession[];
    try {
      sessions = this.sessions.listSessions();
    } catch {
      throw new GatewayFailure('unavailable');
    }
    if (!Array.isArray(sessions)) throw new GatewayFailure('protocol-error');
    if (sessions.length > PLUGIN_SERIAL_CAPABILITY_LIMITS.sessionCount) {
      throw new GatewayFailure('limit-exceeded');
    }
    const seen = new Set<string>();
    return Object.freeze(
      sessions.map((value) => {
        const session = normalizeSession(value);
        if (seen.has(session.sessionId)) throw new GatewayFailure('protocol-error');
        seen.add(session.sessionId);
        return session;
      }),
    );
  }

  private async createSession(
    context: PluginHostV2GatewayContext,
    request: Readonly<PluginSerialCreateSessionV2>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.createSession) throw new GatewayFailure('unavailable');
    throwIfAborted(signal);
    const session = normalizeSession(await this.sessions.createSession(context, request, signal));
    throwIfAborted(signal);
    return { kind: 'create-session', session };
  }

  private async updateSession(
    context: PluginHostV2GatewayContext,
    requested: PluginHostV2SerialSession,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.updateSession) throw new GatewayFailure('unavailable');
    this.assertSessionUnleased(requested.sessionId);
    throwIfAborted(signal);
    const session = normalizeSession(await this.sessions.updateSession(context, requested, signal));
    throwIfAborted(signal);
    return { kind: 'update-session', session };
  }

  private async connectSession(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.connectSession) throw new GatewayFailure('unavailable');
    this.assertSessionUnleased(sessionId);
    throwIfAborted(signal);
    const session = normalizeSession(
      await this.sessions.connectSession(context, sessionId, signal),
    );
    throwIfAborted(signal);
    return { kind: 'connect-session', session };
  }

  private async disconnectSession(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.disconnectSession) throw new GatewayFailure('unavailable');
    this.assertSessionUnleased(sessionId);
    throwIfAborted(signal);
    await this.sessions.disconnectSession(context, sessionId, signal);
    throwIfAborted(signal);
    return { kind: 'disconnect-session' };
  }

  private async deleteSession(
    context: PluginHostV2GatewayContext,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.deleteSession) throw new GatewayFailure('unavailable');
    this.assertSessionUnleased(sessionId);
    throwIfAborted(signal);
    await this.sessions.deleteSession(context, sessionId, signal);
    throwIfAborted(signal);
    return { kind: 'delete-session' };
  }

  private assertSessionUnleased(sessionId: string): void {
    if ([...this.handles.values()].some((binding) => binding.sessionId === sessionId)) {
      throw new GatewayFailure('busy');
    }
  }

  private async acquire(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'acquire-serial-lease' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const key = contextKey(context);
    if (this.handleByRuntime.has(key)) throw new GatewayFailure('busy');
    let runtime: PluginSerialCapabilitySessionRuntime | undefined;
    try {
      runtime = this.sessions.runtimeForSession(operation.sessionId);
    } catch {
      throw new GatewayFailure('unavailable');
    }
    if (!runtime) throw new GatewayFailure('not-found');
    if (runtime.sessionId !== operation.sessionId || !runtime.serialTransactions) {
      throw new GatewayFailure('protocol-error');
    }
    const ownerId = pluginOwnerId(context);
    const grant = await runtime.serialTransactions.acquire(ownerId, {
      signal,
      rxBufferBytes: operation.options.rxBufferBytes,
    });
    if (signal.aborted) {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw new GatewayFailure('cancelled');
    }
    if (!validPositiveInteger(grant.generation)) {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw new GatewayFailure('protocol-error');
    }
    let currentRuntime: PluginSerialCapabilitySessionRuntime | undefined;
    try {
      currentRuntime = this.sessions.runtimeForSession(operation.sessionId);
    } catch {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw new GatewayFailure('unavailable');
    }
    if (currentRuntime !== runtime) {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw new GatewayFailure('stale-handle');
    }
    const authorization = this.authorize(context, 'serial.io');
    if (authorization.status !== 'authorized') {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw new GatewayFailure(
        authorization.status === 'error' ? authorization.code : 'stale-handle',
      );
    }

    let resourceId: string;
    try {
      resourceId = this.issueResourceId();
    } catch (error) {
      await safeCancel(runtime.serialTransactions, grant.token);
      throw error;
    }
    const resource = Object.freeze({ ...context, resourceId });
    const binding: LeaseBinding = {
      binding: resource,
      contextKey: key,
      sessionId: operation.sessionId,
      runtime,
      coordinator: runtime.serialTransactions,
      ownerId,
      token: grant.token,
      sessionGeneration: grant.generation,
      closeTask: null,
    };
    this.handles.set(resourceId, binding);
    this.handleByRuntime.set(key, binding);
    return {
      kind: 'acquire-serial-lease',
      lease: resource,
      sessionGeneration: grant.generation,
    };
  }

  private async write(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'serial-write' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    let result: SerialSendResult;
    try {
      result = await binding.coordinator.write(
        binding.token,
        Uint8Array.from(operation.payload),
        signal,
      );
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
    return normalizeWriteResult(operation.payload.length, result);
  }

  private async read(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'serial-read' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    let payload: Uint8Array;
    try {
      payload = await binding.coordinator.read(binding.token, {
        maxBytes: operation.maxBytes,
        timeoutMs: operation.timeoutMs,
        signal,
      });
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
    if (!(payload instanceof Uint8Array) || payload.length > operation.maxBytes) {
      throw new GatewayFailure('protocol-error');
    }
    return {
      kind: 'serial-read',
      payload: Array.from(payload),
      timedOut: false,
      disconnected: false,
    };
  }

  private async clearBuffers(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'clear-serial-buffers' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    try {
      await binding.coordinator.clearBuffers(binding.token, 'all', signal);
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
    return { kind: 'clear-serial-buffers' };
  }

  private async pendingBytes(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'pending-serial-bytes' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    let pending: { readonly rx: number; readonly tx: number };
    try {
      pending = await binding.coordinator.pendingBytes(binding.token, signal);
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
    if (!validCounter(pending.rx) || !validCounter(pending.tx)) {
      throw new GatewayFailure('protocol-error');
    }
    return { kind: 'pending-serial-bytes', rx: pending.rx, tx: pending.tx };
  }

  private async setOutputLines(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'set-output-lines' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    try {
      await binding.coordinator.setOutputLines(binding.token, operation.lines, signal);
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
    return { kind: 'set-output-lines' };
  }

  private async readInputLines(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'read-input-lines' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, operation.lease);
    try {
      const lines = await binding.coordinator.readInputLines(binding.token, signal);
      if (!validInputLines(lines)) throw new GatewayFailure('protocol-error');
      return { kind: 'read-input-lines', lines: Object.freeze({ ...lines }) };
    } catch (error) {
      if (terminalError(classifyError(error))) this.detachBinding(binding);
      throw error;
    }
  }

  private async captureRead(
    context: PluginHostV2GatewayContext,
    operation: Extract<PluginHostV2SerialOperation, { kind: 'capture-read' }>,
    signal: AbortSignal,
  ): Promise<PluginHostV2SerialResult> {
    if (!this.sessions.captureRead) throw new GatewayFailure('unavailable');
    throwIfAborted(signal);
    const page = await this.sessions.captureRead(context, operation, signal);
    throwIfAborted(signal);
    return normalizeCapturePage(operation, page);
  }

  private async release(
    context: PluginHostV2GatewayContext,
    resource: PluginHostV2ResourceBinding,
  ): Promise<PluginHostV2SerialResult> {
    const binding = await this.resolveBinding(context, resource);
    const result = await this.closeBinding(binding, 'release');
    validateReleaseResult(binding, result);
    if (result.drainFailed || result.restoreFailures.length > 0) {
      throw new GatewayFailure('io-error');
    }
    if (result.restoreSkipped) throw new GatewayFailure('stale-handle');
    return { kind: 'release-serial-lease' };
  }

  private async resolveBinding(
    context: PluginHostV2GatewayContext,
    resource: PluginHostV2ResourceBinding,
  ): Promise<LeaseBinding> {
    if (!resourceBinds(context, resource)) throw new GatewayFailure('stale-handle');
    const binding = this.handles.get(resource.resourceId);
    if (!binding || binding.contextKey !== contextKey(context)) {
      throw new GatewayFailure('stale-handle');
    }
    if (binding.closeTask) throw new GatewayFailure('busy');

    let currentRuntime: PluginSerialCapabilitySessionRuntime | undefined;
    try {
      currentRuntime = this.sessions.runtimeForSession(binding.sessionId);
    } catch {
      await this.closeBinding(binding, 'cancel');
      throw new GatewayFailure('unavailable');
    }
    if (currentRuntime !== binding.runtime) {
      await this.closeBinding(binding, 'cancel');
      throw new GatewayFailure('stale-handle');
    }
    let snapshot: ReturnType<PluginSerialCapabilityCoordinator['snapshot']>;
    try {
      snapshot = binding.coordinator.snapshot();
    } catch {
      await this.closeBinding(binding, 'cancel');
      throw new GatewayFailure('unavailable');
    }
    if (snapshot.faultCode !== undefined) {
      this.detachBinding(binding);
      if (!ERROR_CODES.has(snapshot.faultCode as SerialTransactionLeaseErrorCode)) {
        throw new GatewayFailure('protocol-error');
      }
      throw new GatewayFailure(snapshot.faultCode as SerialTransactionLeaseErrorCode);
    }
    if (
      snapshot.phase !== 'active' ||
      snapshot.ownerId !== binding.ownerId ||
      snapshot.generation !== binding.sessionGeneration
    ) {
      this.detachBinding(binding);
      throw new GatewayFailure('stale-handle');
    }
    return binding;
  }

  private closeBinding(
    binding: LeaseBinding,
    mode: 'release' | 'cancel',
  ): Promise<SerialTransactionLeaseReleaseResult> {
    if (binding.closeTask) return binding.closeTask;
    binding.closeTask = (async () => {
      try {
        return mode === 'release'
          ? await binding.coordinator.release(binding.token)
          : await binding.coordinator.cancel(binding.token);
      } finally {
        this.detachBinding(binding);
      }
    })();
    return binding.closeTask;
  }

  private detachBinding(binding: LeaseBinding): void {
    if (this.handles.get(binding.binding.resourceId) === binding) {
      this.handles.delete(binding.binding.resourceId);
    }
    if (this.handleByRuntime.get(binding.contextKey) === binding) {
      this.handleByRuntime.delete(binding.contextKey);
    }
  }

  private issueResourceId(): string {
    let nonce: string;
    try {
      nonce = this.resourceIdFactory();
    } catch {
      throw new GatewayFailure('unavailable');
    }
    if (!validResourcePart(nonce)) throw new GatewayFailure('unavailable');
    this.resourceSequence += 1;
    if (!Number.isSafeInteger(this.resourceSequence)) throw new GatewayFailure('limit-exceeded');
    const resourceId = `serial-v2.${nonce}.${this.resourceSequence.toString(36)}`;
    if (
      resourceId.length > PLUGIN_SERIAL_CAPABILITY_LIMITS.resourceIdCharacters ||
      this.handles.has(resourceId)
    ) {
      throw new GatewayFailure('unavailable');
    }
    return resourceId;
  }
}

/** Transport lifecycle wrapper; concrete Tauri event/command names remain native-owned. */
export class PluginSerialCapabilityBridge {
  private unlisten: (() => void) | null = null;
  private readonly active = new Set<Promise<void>>();
  private stopTask: Promise<void> | null = null;

  constructor(
    private readonly gateway: PluginSerialCapabilityGateway,
    private readonly transport: PluginSerialCapabilityTransport,
  ) {}

  async start(): Promise<boolean> {
    if (this.unlisten) return true;
    if (!this.gateway.canRespond()) return false;
    const unlisten = await this.transport.listen((event) => this.accept(event));
    if (!this.gateway.canRespond()) {
      unlisten();
      await this.gateway.revokeAll();
      return false;
    }
    this.unlisten = unlisten;
    return true;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = (async () => {
      this.unlisten?.();
      this.unlisten = null;
      await this.gateway.revokeAll();
      await Promise.allSettled([...this.active]);
      this.stopTask = null;
    })();
    return this.stopTask;
  }

  private accept(value: unknown): void {
    if (
      !isRecord(value) ||
      !['request', 'cancel', 'revoke-lease', 'revoke-runtime', 'revoke-all'].includes(
        String(value.kind),
      )
    ) {
      return;
    }
    const task = this.answer(value).finally(() => this.active.delete(task));
    this.active.add(task);
  }

  private async answer(event: Record<string, unknown>): Promise<void> {
    if (event.kind === 'request') {
      const response = await this.gateway.invoke(event.context, event.messageId, event.operation);
      if (!response) return;
      if (!this.gateway.canRespond()) {
        await this.gateway.abandonResponse(response);
        return;
      }
      try {
        await this.transport.respond({ kind: 'response', response });
      } catch {
        await this.gateway.abandonResponse(response);
      }
      return;
    }

    if (event.kind === 'revoke-runtime') {
      await this.gateway.revokeRuntime(event.context);
      return;
    }
    if (event.kind === 'revoke-lease') {
      await this.gateway.revokeLease(event.context, event.lease, event.sessionGeneration);
      return;
    }
    if (event.kind === 'revoke-all') {
      await this.gateway.revokeAll();
      return;
    }

    const result = await this.gateway.cancel(event.context, event.targetMessageId);
    if (!result || !this.gateway.canRespond()) return;
    await this.transport
      .respond({
        kind: 'cancel-result',
        context: result.context,
        targetMessageId: result.targetMessageId,
        ...(result.ok
          ? { ok: true as const }
          : { ok: false as const, errorCode: result.errorCode }),
      })
      .catch(() => undefined);
  }
}

function parseInvocation(
  contextValue: unknown,
  messageIdValue: unknown,
  operationValue: unknown,
): ParsedInvocation | null {
  const context = parseContext(contextValue);
  const operation = parseOperation(operationValue);
  if (!context || !validMessageId(messageIdValue) || !operation) return null;
  return { context, messageId: messageIdValue, operation };
}

function parseContext(value: unknown): PluginHostV2GatewayContext | null {
  if (!isRecord(value)) return null;
  if (
    !validIdentity(value.workspaceId) ||
    !validIdentity(value.pluginId) ||
    !validIdentity(value.instanceId) ||
    !validPositiveInteger(value.generation)
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId: value.workspaceId,
    pluginId: value.pluginId,
    instanceId: value.instanceId,
    generation: value.generation,
  });
}

function parseOperation(value: unknown): PluginHostV2SerialOperation | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'list-ports':
      return { kind: 'list-ports' };
    case 'list-sessions':
      return { kind: 'list-sessions' };
    case 'create-session': {
      const request = parseCreateSession(value.request);
      return request ? { kind: 'create-session', request } : null;
    }
    case 'update-session': {
      const session = parseSession(value.session);
      return session ? { kind: 'update-session', session } : null;
    }
    case 'connect-session':
    case 'disconnect-session':
    case 'delete-session':
      return validIdentity(value.sessionId)
        ? { kind: value.kind, sessionId: value.sessionId }
        : null;
    case 'acquire-serial-lease': {
      if (!validIdentity(value.sessionId) || !isRecord(value.options)) return null;
      if (
        value.options.pauseAutomation !== true ||
        !validRxBufferSize(value.options.rxBufferBytes)
      ) {
        return null;
      }
      return {
        kind: 'acquire-serial-lease',
        sessionId: value.sessionId,
        options: {
          pauseAutomation: true,
          rxBufferBytes: value.options.rxBufferBytes,
        },
      };
    }
    case 'release-serial-lease': {
      const lease = parseResource(value.lease);
      return lease ? { kind: 'release-serial-lease', lease } : null;
    }
    case 'serial-read': {
      const lease = parseResource(value.lease);
      if (
        !lease ||
        !validBoundedInteger(value.maxBytes, PLUGIN_SERIAL_CAPABILITY_LIMITS.readBytes) ||
        !validBoundedInteger(value.timeoutMs, PLUGIN_SERIAL_CAPABILITY_LIMITS.readTimeoutMs)
      ) {
        return null;
      }
      return {
        kind: 'serial-read',
        lease,
        maxBytes: value.maxBytes,
        timeoutMs: value.timeoutMs,
      };
    }
    case 'serial-write': {
      const lease = parseResource(value.lease);
      if (!lease || !validBytes(value.payload)) return null;
      if (value.payload.length > PLUGIN_SERIAL_CAPABILITY_LIMITS.writeBytes) return null;
      return { kind: 'serial-write', lease, payload: [...value.payload] };
    }
    case 'clear-serial-buffers': {
      const lease = parseResource(value.lease);
      return lease ? { kind: 'clear-serial-buffers', lease } : null;
    }
    case 'pending-serial-bytes': {
      const lease = parseResource(value.lease);
      return lease ? { kind: 'pending-serial-bytes', lease } : null;
    }
    case 'set-output-lines': {
      const lease = parseResource(value.lease);
      if (!lease || !validOutputLines(value.lines)) return null;
      return { kind: 'set-output-lines', lease, lines: { ...value.lines } };
    }
    case 'read-input-lines': {
      const lease = parseResource(value.lease);
      return lease ? { kind: 'read-input-lines', lease } : null;
    }
    case 'capture-read':
      if (
        !validIdentity(value.sessionId) ||
        !validCounter(value.fromSequence) ||
        !validBoundedInteger(value.maxFrames, PLUGIN_SERIAL_CAPABILITY_LIMITS.captureFrames) ||
        !validBoundedInteger(value.maxBytes, PLUGIN_SERIAL_CAPABILITY_LIMITS.captureBytes)
      ) {
        return null;
      }
      return {
        kind: 'capture-read',
        sessionId: value.sessionId,
        fromSequence: value.fromSequence,
        maxFrames: value.maxFrames,
        maxBytes: value.maxBytes,
      };
    default:
      return null;
  }
}

function parseResource(value: unknown): PluginHostV2ResourceBinding | null {
  const context = parseContext(value);
  if (!context || !isRecord(value) || !validResourceId(value.resourceId)) return null;
  return Object.freeze({ ...context, resourceId: value.resourceId });
}

function capabilityFor(operation: PluginHostV2SerialOperation): PluginSerialCapabilityName {
  switch (operation.kind) {
    case 'list-ports':
      return 'serial.ports.read';
    case 'list-sessions':
    case 'create-session':
    case 'update-session':
    case 'connect-session':
    case 'disconnect-session':
    case 'delete-session':
      return 'serial.sessions.manage';
    case 'set-output-lines':
    case 'read-input-lines':
      return 'serial.control-lines';
    case 'capture-read':
      return 'session.capture.read';
    case 'acquire-serial-lease':
    case 'release-serial-lease':
    case 'serial-read':
    case 'serial-write':
    case 'clear-serial-buffers':
    case 'pending-serial-bytes':
      return 'serial.io';
  }
}

function parseCreateSession(value: unknown): PluginSerialCreateSessionV2 | null {
  if (
    !isRecord(value) ||
    !validIdentity(value.localId) ||
    !safeText(value.name, PLUGIN_SERIAL_CAPABILITY_LIMITS.displayNameCharacters) ||
    (value.lifetime !== 'persistent' && value.lifetime !== 'runtime') ||
    (value.portId !== undefined && !validIdentity(value.portId))
  ) {
    return null;
  }
  const config = parseSerialConfig(value.config);
  if (!config) return null;
  return Object.freeze({
    localId: value.localId,
    name: value.name,
    lifetime: value.lifetime,
    ...(value.portId === undefined ? {} : { portId: value.portId }),
    config,
  });
}

function parseSession(value: unknown): PluginHostV2SerialSession | null {
  try {
    return normalizeSession(value);
  } catch {
    return null;
  }
}

function parseSerialConfig(value: unknown): PluginHostV2SerialConfig | null {
  if (
    !isRecord(value) ||
    !validPositiveInteger(value.baudRate) ||
    value.baudRate > 0xffff_ffff ||
    !validDataBits(value.dataBits) ||
    !validParity(value.parity) ||
    !validStopBits(value.stopBits) ||
    !validFlowControl(value.flowControl)
  ) {
    return null;
  }
  return Object.freeze({
    baudRate: value.baudRate,
    dataBits: value.dataBits,
    parity: value.parity,
    stopBits: value.stopBits,
    flowControl: value.flowControl,
  });
}

function normalizePort(value: unknown): PluginHostV2SerialPort {
  if (
    !isRecord(value) ||
    !validIdentity(value.portId) ||
    !safeText(value.displayName, PLUGIN_SERIAL_CAPABILITY_LIMITS.displayNameCharacters) ||
    !validOptionalU16(value.usbVendorId) ||
    !validOptionalU16(value.usbProductId) ||
    (value.serialNumber !== undefined &&
      !safeText(value.serialNumber, PLUGIN_SERIAL_CAPABILITY_LIMITS.displayNameCharacters))
  ) {
    throw new GatewayFailure('protocol-error');
  }
  return Object.freeze({
    portId: value.portId,
    displayName: value.displayName,
    ...(value.usbVendorId === undefined ? {} : { usbVendorId: value.usbVendorId }),
    ...(value.usbProductId === undefined ? {} : { usbProductId: value.usbProductId }),
    ...(value.serialNumber === undefined ? {} : { serialNumber: value.serialNumber }),
  });
}

function normalizeSession(value: unknown): PluginHostV2SerialSession {
  if (!isRecord(value)) throw new GatewayFailure('protocol-error');
  const config = parseSerialConfig(value.config);
  if (
    !config ||
    !validIdentity(value.sessionId) ||
    !safeText(value.name, PLUGIN_SERIAL_CAPABILITY_LIMITS.displayNameCharacters) ||
    (value.portId !== undefined && !validIdentity(value.portId)) ||
    typeof value.connected !== 'boolean' ||
    !validGeneration(value.generation)
  ) {
    throw new GatewayFailure('protocol-error');
  }
  return Object.freeze({
    sessionId: value.sessionId,
    name: value.name,
    ...(value.portId === undefined ? {} : { portId: value.portId }),
    config,
    connected: value.connected,
    generation: value.generation,
  });
}

function normalizeWriteResult(
  requested: number,
  value: SerialSendResult,
): PluginHostV2SerialResult {
  if (!isRecord(value)) throw new GatewayFailure('protocol-error');
  if (
    !validCounter(value.requestedBytes) ||
    !validCounter(value.sentBytes) ||
    value.requestedBytes !== requested ||
    value.sentBytes > requested
  ) {
    throw new GatewayFailure('protocol-error');
  }
  if (value.outcome === 'complete' && value.sentBytes === requested) {
    return { kind: 'serial-write', requested, sent: value.sentBytes, outcome: 'completed' };
  }
  if (value.outcome === 'partial' && value.sentBytes > 0 && value.sentBytes < requested) {
    return { kind: 'serial-write', requested, sent: value.sentBytes, outcome: 'partial-write' };
  }
  if (value.outcome === 'cancelled') {
    throw new GatewayFailure(value.sentBytes > 0 ? 'unknown-outcome' : 'cancelled');
  }
  if (value.outcome === 'failed') {
    throw new GatewayFailure(value.sentBytes > 0 ? 'unknown-outcome' : 'io-error');
  }
  throw new GatewayFailure('protocol-error');
}

function normalizeCapturePage(
  request: Readonly<{
    fromSequence: number;
    maxFrames: number;
    maxBytes: number;
  }>,
  value: unknown,
): PluginHostV2SerialResult {
  if (!isRecord(value) || !Array.isArray(value.frames)) {
    throw new GatewayFailure('protocol-error');
  }
  if (value.frames.length > request.maxFrames) throw new GatewayFailure('protocol-error');
  const frames: PluginSerialCaptureFrameV2[] = [];
  let previous = request.fromSequence - 1;
  let totalBytes = 0;
  for (const candidate of value.frames) {
    if (
      !isRecord(candidate) ||
      !validCounter(candidate.sequence) ||
      candidate.sequence < request.fromSequence ||
      candidate.sequence <= previous ||
      !validCounter(candidate.timestampMs) ||
      (candidate.direction !== 'rx' && candidate.direction !== 'tx') ||
      !validByteArray(candidate.payload, true)
    ) {
      throw new GatewayFailure('protocol-error');
    }
    totalBytes += candidate.payload.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > request.maxBytes) {
      throw new GatewayFailure('protocol-error');
    }
    previous = candidate.sequence;
    frames.push(
      Object.freeze({
        sequence: candidate.sequence,
        timestampMs: candidate.timestampMs,
        direction: candidate.direction,
        payload: [...candidate.payload],
      }),
    );
  }
  if (
    value.nextSequence !== undefined &&
    (!validCounter(value.nextSequence) || frames.length === 0 || value.nextSequence <= previous)
  ) {
    throw new GatewayFailure('protocol-error');
  }
  return {
    kind: 'capture-read',
    frames,
    ...(value.nextSequence === undefined ? {} : { nextSequence: value.nextSequence }),
  };
}

function validateReleaseResult(
  binding: LeaseBinding,
  value: SerialTransactionLeaseReleaseResult,
): void {
  if (
    !isRecord(value) ||
    value.generation !== binding.sessionGeneration ||
    !validGeneration(value.generation) ||
    !validCounter(value.restoredAutomations) ||
    !Array.isArray(value.restoreFailures) ||
    !value.restoreFailures.every(validAutomationId) ||
    typeof value.restoreSkipped !== 'boolean' ||
    typeof value.drainFailed !== 'boolean'
  ) {
    throw new GatewayFailure('protocol-error');
  }
}

function successResponse(
  invocation: ParsedInvocation,
  result: PluginHostV2SerialResult,
): PluginSerialCapabilityResponse {
  return Object.freeze({
    replyTo: invocation.messageId,
    context: invocation.context,
    ok: true,
    result,
  });
}

function failureResponse(
  invocation: ParsedInvocation,
  errorCode: SerialTransactionLeaseErrorCode,
): PluginSerialCapabilityResponse {
  return Object.freeze({
    replyTo: invocation.messageId,
    context: invocation.context,
    ok: false,
    errorCode,
  });
}

function classifyError(error: unknown): SerialTransactionLeaseErrorCode {
  if (error instanceof GatewayFailure) return error.code;
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as SerialTransactionLeaseErrorCode;
    if (ERROR_CODES.has(code)) return code;
  }
  return 'io-error';
}

function terminalError(code: SerialTransactionLeaseErrorCode): boolean {
  return ['stale-handle', 'disconnected', 'cancelled', 'unknown-outcome'].includes(code);
}

function contextKey(context: PluginHostV2GatewayContext): string {
  return `${context.workspaceId}\u0000${context.pluginId}\u0000${context.instanceId}\u0000${context.generation}`;
}

function messageKey(context: string, messageId: number): string {
  return `${context}\u0000${messageId}`;
}

function resourceBinds(
  context: PluginHostV2GatewayContext,
  resource: PluginHostV2ResourceBinding,
): boolean {
  return contextKey(context) === contextKey(resource) && validResourceId(resource.resourceId);
}

function sameResourceBinding(
  left: PluginHostV2ResourceBinding,
  right: PluginHostV2ResourceBinding,
): boolean {
  return left.resourceId === right.resourceId && contextKey(left) === contextKey(right);
}

function pluginOwnerId(context: PluginHostV2GatewayContext): string {
  return `plugin:${context.pluginId}:${context.generation}`;
}

function deferredInvocation(): ActiveInvocation {
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { controller: new AbortController(), settled, settle };
}

function secureResourceNonce(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new GatewayFailure('unavailable');
  return globalThis.crypto.randomUUID();
}

async function safeCancel(
  coordinator: PluginSerialCapabilityCoordinator,
  token: SerialTransactionLeaseToken,
): Promise<void> {
  try {
    await coordinator.cancel(token);
  } catch {
    // A concurrent runtime revocation may already own cancellation.
  }
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PLUGIN_SERIAL_CAPABILITY_LIMITS.identityCharacters &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function validResourceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PLUGIN_SERIAL_CAPABILITY_LIMITS.resourceIdCharacters &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function validResourcePart(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 192 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validMessageId(value: unknown): value is number {
  return validPositiveInteger(value);
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validBoundedInteger(value: unknown, maximum: number): value is number {
  return validPositiveInteger(value) && value <= maximum;
}

function validRxBufferSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= SERIAL_TRANSACTION_LEASE_LIMITS.rxBytes
  );
}

function validBytes(value: unknown): value is number[] {
  return validByteArray(value, false);
}

function validByteArray(value: unknown, allowEmpty: boolean): value is number[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function safeText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function validDataBits(value: unknown): value is number {
  return typeof value === 'number' && [5, 6, 7, 8].includes(value);
}

function validParity(value: unknown): value is PluginHostV2SerialConfig['parity'] {
  return typeof value === 'number' && [1, 2, 3].includes(value);
}

function validStopBits(value: unknown): value is PluginHostV2SerialConfig['stopBits'] {
  return typeof value === 'number' && [1, 3].includes(value);
}

function validFlowControl(value: unknown): value is PluginHostV2SerialConfig['flowControl'] {
  return typeof value === 'number' && [1, 2, 3].includes(value);
}

function validOptionalU16(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65_535)
  );
}

function validOutputLines(
  value: unknown,
): value is Readonly<{ dtr: boolean; rts: boolean; breakActive: boolean }> {
  return (
    isRecord(value) &&
    typeof value.dtr === 'boolean' &&
    typeof value.rts === 'boolean' &&
    typeof value.breakActive === 'boolean'
  );
}

function validInputLines(
  value: unknown,
): value is Readonly<{ cts: boolean; dsr: boolean; ri: boolean; cd: boolean }> {
  return (
    isRecord(value) &&
    typeof value.cts === 'boolean' &&
    typeof value.dsr === 'boolean' &&
    typeof value.ri === 'boolean' &&
    typeof value.cd === 'boolean'
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GatewayFailure('cancelled');
}

function validAutomationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SERIAL_TRANSACTION_LEASE_LIMITS.automationIdCharacters
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
