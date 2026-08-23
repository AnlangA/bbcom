import type {
  Direction,
  WorkspaceFramePayload,
  WorkspaceHydratedFrame,
  WorkspaceMutation,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64';
import type { DataFrame } from '@/types/serial';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import { validateWorkspaceIdentifier } from './workspace-adapter-security';

/**
 * Frame payload as held while queued for autosave: `data` stays the raw
 * capture buffer instead of a frozen boxed-number array (an 8x memory
 * amplification per frame at high baud). It is widened to the base64 IPC
 * channel only at the serialization boundary — see {@link toIpcFramePayload},
 * the single place that materializes it.
 */
export interface WorkspaceQueuedFramePayload {
  readonly id: string;
  readonly direction: Direction;
  readonly timestampMs: number;
  readonly data: Uint8Array;
  readonly txStatus?: string;
  readonly requestedBytes?: number;
  readonly omittedBytes?: number;
}

/**
 * Widen one queued payload to the JSON IPC contract shape. Frame bytes cross
 * the boundary as base64 (~4/3 wire size instead of the ~4x number-array
 * expansion). Keep this the only conversion site — both directions of the
 * byte channel are materialized here and in {@link hydrateWorkspaceFrame}.
 */
export function toIpcFramePayload(
  payload: Readonly<WorkspaceQueuedFramePayload>,
): WorkspaceFramePayload {
  return {
    id: payload.id,
    direction: payload.direction,
    timestampMs: payload.timestampMs,
    data: [],
    dataB64: bytesToBase64(payload.data),
    ...(payload.txStatus !== undefined ? { txStatus: payload.txStatus } : {}),
    ...(payload.requestedBytes !== undefined ? { requestedBytes: payload.requestedBytes } : {}),
    ...(payload.omittedBytes !== undefined ? { omittedBytes: payload.omittedBytes } : {}),
  };
}

export interface WorkspaceFrameBatchPolicy {
  readonly maxDelayMs: number;
  readonly maxFrames: number;
  /** Raw frame payload threshold. A valid larger single frame is emitted alone. */
  readonly maxPayloadBytes: number;
  readonly maxFrameBytes: number;
}

export const DEFAULT_WORKSPACE_FRAME_BATCH_POLICY: WorkspaceFrameBatchPolicy = Object.freeze({
  maxDelayMs: 250,
  maxFrames: 256,
  maxPayloadBytes: 512 * 1024,
  maxFrameBytes: IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES,
});

export interface WorkspaceFrameTotals {
  readonly workspaceFrameCount: number;
  readonly sessionFrameCount: number;
  readonly workspacePayloadBytes: number;
}

export interface WorkspaceFrameMutationBuilderOptions {
  readonly sessionId: string;
  readonly startSequence: number;
  readonly startFrameSeq: number;
  readonly totals: WorkspaceFrameTotals;
  readonly policy?: Partial<WorkspaceFrameBatchPolicy>;
}

export interface WorkspaceFrameAppendResult {
  readonly mutations: readonly WorkspaceMutation[];
  readonly deadlineMs: number;
  readonly pendingFrames: number;
  readonly pendingPayloadBytes: number;
}

/**
 * Stateful 250 ms / 256 frame / 512 KiB append-mutation builder. It performs
 * global capture-limit checks before accepting a frame, so a rejected enqueue
 * never partially changes pending state or totals.
 */
export class WorkspaceFrameMutationBuilder {
  private readonly sessionId: string;
  private readonly policy: WorkspaceFrameBatchPolicy;
  private mutationSequence: number;
  private nextFrameSeq: number;
  private workspaceFrameCount: number;
  private sessionFrameCount: number;
  private workspacePayloadBytes: number;
  private pending: WorkspaceQueuedFramePayload[] = [];
  private pendingBytes = 0;
  private pendingStartedAtMs: number | null = null;

  constructor(options: WorkspaceFrameMutationBuilderOptions) {
    this.sessionId = validateWorkspaceIdentifier(options.sessionId, 'sessionId');
    this.mutationSequence = validNonNegativeInteger(options.startSequence, 'startSequence');
    this.nextFrameSeq = validNonNegativeInteger(options.startFrameSeq, 'startFrameSeq');
    this.workspaceFrameCount = validNonNegativeInteger(
      options.totals.workspaceFrameCount,
      'workspaceFrameCount',
    );
    this.sessionFrameCount = validNonNegativeInteger(
      options.totals.sessionFrameCount,
      'sessionFrameCount',
    );
    this.workspacePayloadBytes = validNonNegativeInteger(
      options.totals.workspacePayloadBytes,
      'workspacePayloadBytes',
    );
    assertLimit('workspaceFrames', IPC_LIMITS.MAX_WORKSPACE_FRAMES, this.workspaceFrameCount);
    assertLimit(
      'sessionFrames',
      IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION,
      this.sessionFrameCount,
    );
    if (this.sessionFrameCount > this.workspaceFrameCount) {
      throw new WorkspaceAdapterValidationError('sessionFrameCount');
    }
    assertLimit(
      'workspaceCaptureBytes',
      IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES,
      this.workspacePayloadBytes,
    );
    this.policy = normalizePolicy(options.policy);
  }

  append(frame: DataFrame, nowMs: number): WorkspaceFrameAppendResult {
    const timestamp = validNonNegativeInteger(nowMs, 'nowMs');
    const payload = projectWorkspaceFrame(frame, this.policy.maxFrameBytes);
    this.assertTotalsAccept(payload.data.length);

    const mutations: WorkspaceMutation[] = [];
    if (
      this.pending.length > 0 &&
      (this.pending.length + 1 > this.policy.maxFrames ||
        this.pendingBytes + payload.data.length > this.policy.maxPayloadBytes)
    ) {
      mutations.push(this.takeMutation());
    }

    if (this.pending.length === 0) this.pendingStartedAtMs = timestamp;
    this.pending.push(payload);
    this.pendingBytes += payload.data.length;
    this.workspaceFrameCount += 1;
    this.sessionFrameCount += 1;
    this.workspacePayloadBytes += payload.data.length;

    if (
      this.pending.length >= this.policy.maxFrames ||
      this.pendingBytes >= this.policy.maxPayloadBytes
    ) {
      mutations.push(this.takeMutation());
    }
    return this.result(mutations);
  }

  flushDue(nowMs: number): WorkspaceFrameAppendResult {
    const timestamp = validNonNegativeInteger(nowMs, 'nowMs');
    const mutations: WorkspaceMutation[] = [];
    if (
      this.pendingStartedAtMs !== null &&
      timestamp - this.pendingStartedAtMs >= this.policy.maxDelayMs
    ) {
      mutations.push(this.takeMutation());
    }
    return this.result(mutations);
  }

  flush(): readonly WorkspaceMutation[] {
    return Object.freeze(this.pending.length === 0 ? [] : [this.takeMutation()]);
  }

  snapshotTotals(): WorkspaceFrameTotals {
    return Object.freeze({
      workspaceFrameCount: this.workspaceFrameCount,
      sessionFrameCount: this.sessionFrameCount,
      workspacePayloadBytes: this.workspacePayloadBytes,
    });
  }

  private assertTotalsAccept(frameBytes: number): void {
    assertLimit('workspaceFrames', IPC_LIMITS.MAX_WORKSPACE_FRAMES, this.workspaceFrameCount + 1);
    assertLimit(
      'sessionFrames',
      IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION,
      this.sessionFrameCount + 1,
    );
    assertLimit(
      'workspaceCaptureBytes',
      IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES,
      this.workspacePayloadBytes + frameBytes,
    );
  }

  private takeMutation(): WorkspaceMutation {
    if (this.pending.length === 0) throw new WorkspaceAdapterValidationError('pendingFrames');
    if (this.mutationSequence > 0xffff_ffff) {
      throw new WorkspaceAdapterLimitError('sequence', 0xffff_ffff, this.mutationSequence);
    }
    const frames = this.pending.map(toIpcFramePayload);
    const startSeq = this.nextFrameSeq;
    this.nextFrameSeq += frames.length;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingStartedAtMs = null;
    return Object.freeze({
      kind: 'append-frames',
      sequence: this.mutationSequence++,
      sessionId: this.sessionId,
      payload: Object.freeze({
        startSeq,
        frames: Object.freeze(frames) as WorkspaceFramePayload[],
      }),
    }) as WorkspaceMutation;
  }

  private result(mutations: WorkspaceMutation[]): WorkspaceFrameAppendResult {
    return Object.freeze({
      mutations: Object.freeze(mutations),
      deadlineMs:
        this.pendingStartedAtMs === null
          ? Number.POSITIVE_INFINITY
          : this.pendingStartedAtMs + this.policy.maxDelayMs,
      pendingFrames: this.pending.length,
      pendingPayloadBytes: this.pendingBytes,
    });
  }
}

export function projectWorkspaceFrame(
  frame: DataFrame,
  maxFrameBytes: number = IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES,
): WorkspaceQueuedFramePayload {
  assertExactKeys(
    frame,
    [
      'id',
      'direction',
      'timestamp',
      'data',
      'contentVersion',
      'omittedBytes',
      'txStatus',
      'requestedBytes',
    ],
    'frame',
  );
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes <= 0 ||
    maxFrameBytes > IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES
  ) {
    throw new WorkspaceAdapterValidationError('maxFrameBytes');
  }
  const id = validateWorkspaceIdentifier(frame.id, 'frame.id');
  if (frame.direction !== 'TX' && frame.direction !== 'RX') {
    throw new WorkspaceAdapterValidationError('frame.direction');
  }
  const timestampMs = validNonNegativeInteger(frame.timestamp, 'frame.timestamp');
  if (!(frame.data instanceof Uint8Array)) {
    throw new WorkspaceAdapterValidationError('frame.data');
  }
  assertLimit('frameBytes', maxFrameBytes, frame.data.byteLength);
  const txStatus = validateTxStatus(frame);
  const requestedBytes = optionalNonNegativeInteger(frame.requestedBytes, 'frame.requestedBytes');
  const omittedBytes = optionalNonNegativeInteger(frame.omittedBytes, 'frame.omittedBytes');
  if (requestedBytes !== undefined && requestedBytes < frame.data.byteLength) {
    throw new WorkspaceAdapterValidationError('frame.requestedBytes');
  }
  if (frame.direction === 'RX' && (txStatus !== undefined || requestedBytes !== undefined)) {
    throw new WorkspaceAdapterValidationError('frame.txMetadata');
  }
  // `data` shares the raw capture buffer while the payload sits in the bounded
  // save queue; the boxed number array only materializes at the IPC boundary.
  return Object.freeze({
    id,
    direction: frame.direction,
    timestampMs,
    data: frame.data,
    ...(txStatus !== undefined ? { txStatus } : {}),
    ...(requestedBytes !== undefined ? { requestedBytes } : {}),
    ...(omittedBytes !== undefined ? { omittedBytes } : {}),
  });
}

export function hydrateWorkspaceFrame(frame: WorkspaceHydratedFrame): DataFrame {
  assertExactKeys(
    frame,
    [
      'seq',
      'id',
      'direction',
      'timestampMs',
      'data',
      'dataB64',
      'txStatus',
      'requestedBytes',
      'omittedBytes',
    ],
    'frame',
  );
  const captureSeq = validNonNegativeInteger(frame.seq, 'frame.seq');
  const id = validateWorkspaceIdentifier(frame.id, 'frame.id');
  if (frame.direction !== 'TX' && frame.direction !== 'RX') {
    throw new WorkspaceAdapterValidationError('frame.direction');
  }
  const timestamp = validNonNegativeInteger(frame.timestampMs, 'frame.timestampMs');
  const data = decodeHydratedFrameData(frame);
  assertLimit('frameBytes', IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES, data.byteLength);
  const txStatus =
    frame.txStatus === undefined
      ? undefined
      : frame.txStatus === 'complete' || frame.txStatus === 'partial-unknown'
        ? frame.txStatus
        : (() => {
            throw new WorkspaceAdapterValidationError('frame.txStatus');
          })();
  const requestedBytes = optionalNonNegativeInteger(frame.requestedBytes, 'frame.requestedBytes');
  const omittedBytes = optionalNonNegativeInteger(frame.omittedBytes, 'frame.omittedBytes');
  if (requestedBytes !== undefined && requestedBytes < data.byteLength) {
    throw new WorkspaceAdapterValidationError('frame.requestedBytes');
  }
  if (frame.direction === 'RX' && (txStatus !== undefined || requestedBytes !== undefined)) {
    throw new WorkspaceAdapterValidationError('frame.txMetadata');
  }
  return Object.freeze({
    id,
    direction: frame.direction,
    timestamp,
    data,
    captureSeq,
    ...(txStatus !== undefined ? { txStatus } : {}),
    ...(requestedBytes !== undefined ? { requestedBytes } : {}),
    ...(omittedBytes !== undefined ? { omittedBytes } : {}),
  });
}

/**
 * Materialize hydrated frame bytes. Hydrate responses carry payloads only over
 * the base64 channel (`data` arrives as an empty array); the legacy
 * number-array shape stays accepted so old responses round-trip.
 */
function decodeHydratedFrameData(frame: WorkspaceHydratedFrame): Uint8Array {
  if (frame.dataB64 !== undefined) {
    if (typeof frame.dataB64 !== 'string') {
      throw new WorkspaceAdapterValidationError('frame.dataB64');
    }
    if (Array.isArray(frame.data) && frame.data.length > 0) {
      throw new WorkspaceAdapterValidationError('frame.data');
    }
    try {
      return base64ToBytes(frame.dataB64);
    } catch {
      throw new WorkspaceAdapterValidationError('frame.dataB64');
    }
  }
  if (!Array.isArray(frame.data) || frame.data.some((byte) => !isByte(byte))) {
    throw new WorkspaceAdapterValidationError('frame.data');
  }
  return Uint8Array.from(frame.data);
}

function normalizePolicy(
  requested: Partial<WorkspaceFrameBatchPolicy> | undefined,
): WorkspaceFrameBatchPolicy {
  const policy = { ...DEFAULT_WORKSPACE_FRAME_BATCH_POLICY, ...requested };
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkspaceAdapterValidationError(`policy.${field}`);
    }
  }
  const ceilings: WorkspaceFrameBatchPolicy = DEFAULT_WORKSPACE_FRAME_BATCH_POLICY;
  for (const field of Object.keys(ceilings) as (keyof WorkspaceFrameBatchPolicy)[]) {
    if (policy[field] > ceilings[field]) {
      throw new WorkspaceAdapterValidationError(`policy.${field}`);
    }
  }
  return Object.freeze(policy);
}

function validateTxStatus(frame: DataFrame): DataFrame['txStatus'] {
  if (frame.txStatus === undefined) return undefined;
  if (frame.txStatus !== 'complete' && frame.txStatus !== 'partial-unknown') {
    throw new WorkspaceAdapterValidationError('frame.txStatus');
  }
  return frame.txStatus;
}

function optionalNonNegativeInteger(value: number | undefined, field: string): number | undefined {
  return value === undefined ? undefined : validNonNegativeInteger(value, field);
}

function validNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function assertLimit(field: string, limit: number, actual: number): void {
  if (actual > limit) throw new WorkspaceAdapterLimitError(field, limit, actual);
}

function assertExactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceAdapterValidationError(field);
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WorkspaceAdapterValidationError(field);
  }
}
