import type { WorkspaceMutationCommand } from '@/features/workspace/types';
import { IPC_LIMITS } from '../../../../generated/ipc-contracts';
import {
  ConfigSaveQueue,
  type PendingConfigMutation,
  type SaveContext,
  type WorkspaceBufferedMutationCommand,
} from './config-save-queue';
import { FrameSaveQueue, type PendingFrame } from './frame-save-queue';

export type { SaveContext, WorkspaceBufferedMutationCommand, PendingConfigMutation, PendingFrame };

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
const WORKSPACE_NOTIFY_THROTTLE_MS = 250;

export interface SaveQueuesHooks {
  scheduleSaveGroup(context: SaveContext, commands: readonly WorkspaceMutationCommand[]): void;
  emitNotify(): void;
}

export class WorkspaceSaveQueues {
  private readonly configQueue: ConfigSaveQueue;
  private readonly frameQueue: FrameSaveQueue;
  private notifyThrottleTimer: TimerHandle | null = null;
  private notifyThrottlePending = false;

  constructor(hooks: SaveQueuesHooks) {
    const queueHooks = {
      scheduleSaveGroup: hooks.scheduleSaveGroup,
      onNotify: () => this.notify(),
    };
    this.configQueue = new ConfigSaveQueue(queueHooks);
    this.frameQueue = new FrameSaveQueue(queueHooks);
    this.emitNotify = hooks.emitNotify;
  }

  private readonly emitNotify: () => void;

  get configQueued(): boolean {
    return this.configQueue.queued;
  }
  get framesQueued(): boolean {
    return this.frameQueue.queued;
  }
  get queuedMutationCount(): number {
    return this.configQueue.mutationCount + this.frameQueue.mutationCount;
  }

  enqueueConfigMutations(
    context: SaveContext,
    commands: readonly WorkspaceBufferedMutationCommand[],
  ): void {
    this.configQueue.enqueue(context, commands);
  }
  enqueueFrame(frame: PendingFrame): void {
    this.frameQueue.enqueue(frame);
  }
  releaseAll(): void {
    this.configQueue.release();
    this.frameQueue.release();
  }
  abandon(): number {
    return this.configQueue.abandon() + this.frameQueue.abandon();
  }
  reset(): void {
    this.configQueue.reset();
    this.frameQueue.reset();
  }

  notify(): void {
    if (this.frameQueue.queued) {
      if (this.notifyThrottleTimer !== null) {
        this.notifyThrottlePending = true;
        return;
      }
      this.emitNotify();
      this.notifyThrottleTimer = globalThis.setTimeout(() => {
        this.notifyThrottleTimer = null;
        if (this.notifyThrottlePending) {
          this.notifyThrottlePending = false;
          this.notify();
        }
      }, WORKSPACE_NOTIFY_THROTTLE_MS);
      return;
    }
    if (this.notifyThrottleTimer !== null) {
      globalThis.clearTimeout(this.notifyThrottleTimer);
      this.notifyThrottleTimer = null;
    }
    this.notifyThrottlePending = false;
    this.emitNotify();
  }
}

export class SaveGate {
  private cache: Readonly<{ key: string; outcome: SaveContext | null }> | null = null;
  accepting(key: string, evaluate: () => SaveContext | null): SaveContext | null {
    const cached = this.cache;
    if (cached && cached.key === key) return cached.outcome;
    const outcome = evaluate();
    this.cache = Object.freeze({ key, outcome });
    return outcome;
  }
}

interface WorkspaceMutationLogicalWeight {
  readonly bytes: number;
  readonly frames: number;
  readonly singleLargeFrame: boolean;
}

/**
 * Mirror the native logical batch budget: raw bytes for capture mutations and
 * compact UTF-8 JSON for every structured mutation. A conservative maximum
 * sequence value makes the estimate safe for every coordinator epoch.
 */
export function partitionWorkspaceMutationCommands(
  commands: readonly WorkspaceMutationCommand[],
): WorkspaceMutationCommand[][] | null {
  const batches: WorkspaceMutationCommand[][] = [];
  let batch: WorkspaceMutationCommand[] = [];
  let batchBytes = 0;
  let batchFrames = 0;
  const release = (): void => {
    if (batch.length === 0) return;
    batches.push(batch);
    batch = [];
    batchBytes = 0;
    batchFrames = 0;
  };

  for (const command of commands) {
    const weight = workspaceMutationLogicalWeight(command);
    if (!weight) return null;
    if (weight.singleLargeFrame) {
      release();
      batches.push([command]);
      continue;
    }
    if (
      weight.bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES ||
      weight.frames > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_BATCH
    ) {
      return null;
    }
    if (
      batch.length > 0 &&
      (batch.length + 1 > IPC_LIMITS.MAX_WORKSPACE_MUTATIONS_PER_BATCH ||
        batchBytes + weight.bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES ||
        batchFrames + weight.frames > IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_BATCH)
    ) {
      release();
    }
    batch.push(command);
    batchBytes += weight.bytes;
    batchFrames += weight.frames;
  }
  release();
  return batches;
}

function workspaceMutationLogicalWeight(
  command: WorkspaceMutationCommand,
): WorkspaceMutationLogicalWeight | null {
  if (command.kind === 'append-frames' || command.kind === 'replace-capture') {
    const frames = command.payload.frames;
    if (!Array.isArray(frames)) return null;
    let bytes = 0;
    for (const frame of frames) {
      // The generated contract declares `data` as number[]; tolerate a raw
      // buffer too so a future Uint8Array-bearing command cannot slip past
      // the byte budget unmeasured.
      const data: unknown = frame.data;
      if (!Array.isArray(data) && !(data instanceof Uint8Array)) return null;
      bytes += data.length;
      if (!Number.isSafeInteger(bytes)) return null;
    }
    const singleLargeFrame =
      frames.length === 1 &&
      bytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES &&
      bytes <= IPC_LIMITS.MAX_WORKSPACE_FRAME_BYTES;
    return { bytes, frames: frames.length, singleLargeFrame };
  }

  // Waveform sample rows have a fixed numeric shape and the session state is
  // structurally bounded (600 groups x 8 channels), so one constant per sample
  // covers keys, quotes, separators and the widest decimal values without
  // walking every element. This is the command that repeats on every
  // streaming tick; per-value walking (or the previous JSON.stringify +
  // TextEncoder pass) allocated the whole payload just to size it.
  if (command.kind === 'append-waveform-samples') {
    const samples = command.payload.samples;
    if (!Array.isArray(samples)) return null;
    return { bytes: 96 + samples.length * 96, frames: 0, singleLargeFrame: false };
  }

  // Every other structured variant carries an unbounded JSON document
  // (feature state, session documents, AI messages, metadata), so its size
  // cannot be bounded by field counts alone. Walk the enumerable fields once
  // with pure arithmetic — strings and keys at face length, widest decimal
  // form per number — which costs no serialization allocations.
  let bytes = 40 + command.kind.length;
  for (const [key, value] of Object.entries(command)) {
    if (key === 'kind') continue;
    const valueBytes = estimateStructuredJsonBytes(value, 0);
    if (valueBytes === null) return null;
    bytes += key.length + 5 + valueBytes + 1;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  return { bytes, frames: 0, singleLargeFrame: false };
}

/**
 * Allocation-free upper bound for the compact JSON bytes of one structured
 * mutation field. Returns null for values JSON cannot represent (bigint,
 * symbols, functions) or absurdly deep nesting — the same fail-closed
 * rejection the previous serializer's exceptions produced.
 */
function estimateStructuredJsonBytes(value: unknown, depth: number): number | null {
  if (value === null) return 4;
  switch (typeof value) {
    case 'undefined':
      return 0; // JSON.stringify omits the key entirely
    case 'boolean':
      return 5;
    case 'number':
      return Number.isFinite(value) ? 24 : 4;
    case 'string':
      return value.length + 2;
    case 'object':
      break;
    case 'bigint':
    case 'symbol':
    case 'function':
    default:
      return null;
  }
  if (depth > 64) return null;
  if (value instanceof Uint8Array) return 2 + value.length * 4;
  let bytes = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      const itemBytes = estimateStructuredJsonBytes(item, depth + 1);
      if (itemBytes === null) return null;
      bytes += itemBytes + 1;
      if (!Number.isSafeInteger(bytes)) return null;
    }
    return bytes;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemBytes = estimateStructuredJsonBytes(item, depth + 1);
    if (itemBytes === null) return null;
    bytes += key.length + 4 + itemBytes + 1;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  return bytes;
}
