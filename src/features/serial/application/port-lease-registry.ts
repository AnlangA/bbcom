import type {
  PortLeaseConflict,
  PortLeaseGrant,
  PortLeaseOwner,
  PortLeaseState,
} from '../../../generated/ipc-contracts';

export type PortPlatform = 'windows' | 'unix' | 'other';
export type PortCanonicalizer = (port: string) => string;
export type HeldPortLeaseState = Exclude<PortLeaseState, 'idle'>;

export type FrozenPortLeaseGrant = Readonly<Omit<PortLeaseGrant, 'owner'>> & {
  readonly owner: Readonly<PortLeaseOwner>;
};

export const PORT_LEASE_LIMITS = Object.freeze({
  canonicalPortCharacters: 512,
  sessionIdCharacters: 256,
  sessionNameCharacters: 128,
  leaseIdCharacters: 128,
});

export interface PortLeaseRegistryOptions {
  /** Explicit platform policy. Mutually exclusive with `canonicalizer`. */
  readonly platform?: PortPlatform;
  /** Custom platform policy for hosts with non-standard serial identifiers. */
  readonly canonicalizer?: PortCanonicalizer;
  /** Injectable only so ownership races and identifier failures are deterministic in tests. */
  readonly leaseIdFactory?: () => string;
}

/** Minimum ownership boundary required by a serial connection runtime. */
export interface PortLeaseClient {
  acquire(canonicalPort: string, sessionId: string, sessionName: string): FrozenPortLeaseGrant;
  transition(leaseId: string, sessionId: string, state: HeldPortLeaseState): FrozenPortLeaseGrant;
  release(leaseId: string, sessionId: string): boolean;
}

export type PortLeaseRegistryListener = (leases: readonly FrozenPortLeaseGrant[]) => void;

export class PortLeaseInUseError extends Error {
  readonly conflict: Readonly<PortLeaseConflict>;

  constructor(conflict: PortLeaseConflict) {
    super('serial port is already leased by another session');
    this.name = 'PortLeaseInUseError';
    this.conflict = Object.freeze({ ...conflict });
  }
}

export class InvalidPortLeaseTransitionError extends Error {
  constructor(
    readonly from: HeldPortLeaseState,
    readonly to: HeldPortLeaseState,
  ) {
    super(`illegal port lease transition: ${from} -> ${to}`);
    this.name = 'InvalidPortLeaseTransitionError';
  }
}

export class PortLeaseOwnershipError extends Error {
  constructor() {
    super('port lease does not belong to the requesting session');
    this.name = 'PortLeaseOwnershipError';
  }
}

export class PortLeaseRegistryShutdownError extends Error {
  constructor() {
    super('port lease registry is shut down');
    this.name = 'PortLeaseRegistryShutdownError';
  }
}

export class PortLeaseIdCollisionError extends Error {
  constructor() {
    super('port lease identifier is already active');
    this.name = 'PortLeaseIdCollisionError';
  }
}

interface StoredPortLease {
  readonly leaseId: string;
  readonly owner: PortLeaseOwner;
  state: HeldPortLeaseState;
  readonly sequence: number;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WINDOWS_COM_PORT = /^(?:\\\\\.\\)?COM([1-9]\d{0,4})$/i;

const ALLOWED_TRANSITIONS: Readonly<Record<HeldPortLeaseState, ReadonlySet<HeldPortLeaseState>>> = {
  opening: new Set(['connected', 'failed', 'closing']),
  connected: new Set(['reconnecting', 'failed', 'closing']),
  reconnecting: new Set(['connected', 'failed', 'closing']),
  failed: new Set(),
  closing: new Set(),
};

/**
 * Convert a host serial identifier into an in-memory ownership key.
 * Canonical values are registry implementation details and must not be saved
 * into a workspace as a replacement for the user-visible port identifier.
 */
export function canonicalizePort(
  port: string,
  platform: PortPlatform = detectPortPlatform(),
): string {
  const input = validatePortText(port);
  switch (platform) {
    case 'windows':
      return canonicalizeWindowsPort(input);
    case 'unix':
      return canonicalizeUnixPort(input);
    case 'other':
      return canonicalizeOtherPort(input);
  }
}

/** Runtime detection is only a default; native integration should inject its known platform. */
export function detectPortPlatform(): PortPlatform {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (
    ['mac', 'linux', 'unix', 'bsd', 'sunos', 'aix', 'android'].some((name) =>
      platform.includes(name),
    )
  ) {
    return 'unix';
  }
  return 'other';
}

/**
 * Application-process ownership for serial ports. Every mutating operation is
 * synchronous, so no second caller can observe an acquisition before its port
 * index is committed.
 */
export class PortLeaseRegistry {
  private readonly leasesByPort = new Map<string, StoredPortLease>();
  private readonly leasesById = new Map<string, StoredPortLease>();
  private readonly listeners = new Set<PortLeaseRegistryListener>();
  private readonly canonicalizer: PortCanonicalizer;
  private readonly leaseIdFactory: () => string;
  private sequence = 0;
  private shutDown = false;

  constructor(options: PortLeaseRegistryOptions = {}) {
    if (options.platform !== undefined && options.canonicalizer !== undefined) {
      throw new TypeError('platform and canonicalizer are mutually exclusive');
    }
    const customCanonicalizer = options.canonicalizer;
    this.canonicalizer = customCanonicalizer
      ? (port) => validateCanonicalPort(customCanonicalizer(validatePortText(port)))
      : (port) => canonicalizePort(port, options.platform ?? detectPortPlatform());
    this.leaseIdFactory = options.leaseIdFactory ?? defaultLeaseId;
  }

  get isShutdown(): boolean {
    return this.shutDown;
  }

  get size(): number {
    return this.leasesByPort.size;
  }

  acquire(canonicalPort: string, sessionId: string, sessionName: string): FrozenPortLeaseGrant {
    this.assertOpen();
    const port = this.canonicalizer(canonicalPort);
    const ownerId = validateOpaqueId(sessionId, 'sessionId', PORT_LEASE_LIMITS.sessionIdCharacters);
    const ownerName = validateSessionName(sessionName);
    const existing = this.leasesByPort.get(port);
    if (existing) {
      if (existing.owner.sessionId === ownerId) return freezeGrant(existing);
      throw new PortLeaseInUseError({
        ownerSessionId: existing.owner.sessionId,
        ownerSessionName: existing.owner.sessionName,
        canonicalPort: existing.owner.canonicalPort,
      });
    }

    const leaseId = validateOpaqueId(
      this.leaseIdFactory(),
      'leaseId',
      PORT_LEASE_LIMITS.leaseIdCharacters,
    );
    if (this.leasesById.has(leaseId)) throw new PortLeaseIdCollisionError();
    const lease: StoredPortLease = {
      leaseId,
      owner: { sessionId: ownerId, sessionName: ownerName, canonicalPort: port },
      state: 'opening',
      sequence: this.sequence++,
    };
    this.leasesByPort.set(port, lease);
    this.leasesById.set(leaseId, lease);
    this.notify();
    return freezeGrant(lease);
  }

  transition(leaseId: string, sessionId: string, state: HeldPortLeaseState): FrozenPortLeaseGrant {
    this.assertOpen();
    const lease = this.requireOwnedLease(leaseId, sessionId);
    if (!ALLOWED_TRANSITIONS[lease.state].has(state)) {
      throw new InvalidPortLeaseTransitionError(lease.state, state);
    }
    lease.state = state;
    this.notify();
    return freezeGrant(lease);
  }

  /** A mismatched lease/session pair is a no-op and can never release another owner. */
  release(leaseId: string, sessionId: string): boolean {
    const normalizedLeaseId = validateOpaqueId(
      leaseId,
      'leaseId',
      PORT_LEASE_LIMITS.leaseIdCharacters,
    );
    const normalizedSessionId = validateOpaqueId(
      sessionId,
      'sessionId',
      PORT_LEASE_LIMITS.sessionIdCharacters,
    );
    const lease = this.leasesById.get(normalizedLeaseId);
    if (!lease || lease.owner.sessionId !== normalizedSessionId) return false;
    this.leasesById.delete(normalizedLeaseId);
    this.leasesByPort.delete(lease.owner.canonicalPort);
    this.notify();
    return true;
  }

  releaseSession(sessionId: string): number {
    const normalizedSessionId = validateOpaqueId(
      sessionId,
      'sessionId',
      PORT_LEASE_LIMITS.sessionIdCharacters,
    );
    const owned = Array.from(this.leasesById.values()).filter(
      (lease) => lease.owner.sessionId === normalizedSessionId,
    );
    for (const lease of owned) {
      this.leasesById.delete(lease.leaseId);
      this.leasesByPort.delete(lease.owner.canonicalPort);
    }
    if (owned.length > 0) this.notify();
    return owned.length;
  }

  getByPort(port: string): FrozenPortLeaseGrant | undefined {
    const lease = this.leasesByPort.get(this.canonicalizer(port));
    return lease ? freezeGrant(lease) : undefined;
  }

  getBySession(sessionId: string): readonly FrozenPortLeaseGrant[] {
    const normalizedSessionId = validateOpaqueId(
      sessionId,
      'sessionId',
      PORT_LEASE_LIMITS.sessionIdCharacters,
    );
    return Object.freeze(
      Array.from(this.leasesById.values())
        .filter((lease) => lease.owner.sessionId === normalizedSessionId)
        .sort((left, right) => left.sequence - right.sequence)
        .map(freezeGrant),
    );
  }

  snapshot(): readonly FrozenPortLeaseGrant[] {
    return Object.freeze(
      Array.from(this.leasesById.values())
        .sort((left, right) => left.sequence - right.sequence)
        .map(freezeGrant),
    );
  }

  subscribe(listener: PortLeaseRegistryListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // An observer cannot change ownership or make a transition fail.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove every lease as the application-level final safety net. */
  shutdown(): number {
    if (this.shutDown) return 0;
    this.shutDown = true;
    const released = this.leasesById.size;
    this.leasesById.clear();
    this.leasesByPort.clear();
    if (released > 0) this.notify();
    this.listeners.clear();
    return released;
  }

  private requireOwnedLease(leaseId: string, sessionId: string): StoredPortLease {
    const normalizedLeaseId = validateOpaqueId(
      leaseId,
      'leaseId',
      PORT_LEASE_LIMITS.leaseIdCharacters,
    );
    const normalizedSessionId = validateOpaqueId(
      sessionId,
      'sessionId',
      PORT_LEASE_LIMITS.sessionIdCharacters,
    );
    const lease = this.leasesById.get(normalizedLeaseId);
    if (!lease || lease.owner.sessionId !== normalizedSessionId) {
      throw new PortLeaseOwnershipError();
    }
    return lease;
  }

  private assertOpen(): void {
    if (this.shutDown) throw new PortLeaseRegistryShutdownError();
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // An observer cannot change ownership or make a transition fail.
      }
    }
  }
}

function canonicalizeWindowsPort(port: string): string {
  const match = WINDOWS_COM_PORT.exec(port);
  if (!match) throw new TypeError('Windows serial port must be COM<n> or \\\\.\\COM<n>');
  return `COM${match[1]}`;
}

function canonicalizeUnixPort(port: string): string {
  if (!port.startsWith('/dev/')) {
    throw new TypeError('Unix serial port must be an absolute path below /dev');
  }
  const parts: string[] = [];
  for (const part of port.slice(1).split('/')) {
    if (part === '..') throw new TypeError('Unix serial port must not contain parent traversal');
    if (part && part !== '.') parts.push(part);
  }
  if (parts[0] !== 'dev' || parts.length < 2) {
    throw new TypeError('Unix serial port must identify a device below /dev');
  }
  return `/${parts.join('/')}`;
}

function canonicalizeOtherPort(port: string): string {
  const absolute = port.startsWith('/') || port.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(port);
  if (!absolute) throw new TypeError('serial port must be an absolute host identifier');
  return port;
}

function validatePortText(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PORT_LEASE_LIMITS.canonicalPortCharacters ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    throw new TypeError('serial port contains invalid or out-of-bounds characters');
  }
  return value;
}

function validateCanonicalPort(value: string | undefined): string {
  if (value === undefined) throw new TypeError('custom port canonicalizer returned no value');
  return validatePortText(value);
}

function validateOpaqueId(value: string, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    !OPAQUE_ID.test(value)
  ) {
    throw new TypeError(
      `${field} must be a path-free opaque identifier of 1-${maximum} characters`,
    );
  }
  return value;
}

function validateSessionName(value: string): string {
  if (typeof value !== 'string') throw new TypeError('sessionName must be a string');
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > PORT_LEASE_LIMITS.sessionNameCharacters ||
    containsControlCharacter(normalized)
  ) {
    throw new TypeError(
      `sessionName must contain 1-${PORT_LEASE_LIMITS.sessionNameCharacters} printable characters`,
    );
  }
  return normalized;
}

function defaultLeaseId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required for port lease identifiers');
  }
  return globalThis.crypto.randomUUID();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function freezeGrant(lease: StoredPortLease): FrozenPortLeaseGrant {
  return Object.freeze({
    leaseId: lease.leaseId,
    owner: Object.freeze({ ...lease.owner }),
    state: lease.state,
  });
}
