import type { WorkspaceFramePayload } from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import { toIpcFramePayload, type WorkspaceQueuedFramePayload } from '../adapters';
import type { WorkspaceMutationCommand } from '@/features/workspace/types';
import {
  WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES,
  WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES,
  type WorkspaceConfigMutationCommand,
} from './types';

export interface SaveContext {
  readonly epoch: number;
  readonly workspaceId: string;
}

export type WorkspaceBufferedMutationCommand =
  | WorkspaceConfigMutationCommand
  | Extract<WorkspaceMutationCommand, { readonly kind: 'append-waveform-samples' }>;

export interface PendingConfigMutation {
  readonly context: SaveContext;
  readonly command: WorkspaceBufferedMutationCommand;
}

export interface PendingFrame {
  readonly context: SaveContext;
  readonly sessionId: string;
  readonly sequence: number;
  readonly payload: WorkspaceQueuedFramePayload;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/**
 * Coalescing window for state-observer notifications while capture frames are
 * still queued. Matches the frame autosave cadence; frame payloads themselves
 * never travel through notify(), only save-state summaries.
 */
const WORKSPACE_NOTIFY_THROTTLE_MS = 250;

export interface SaveQueuesHooks {
  /** Schedule one released save group on the persistence save tail. */
  scheduleSaveGroup(context: SaveContext, commands: readonly WorkspaceMutationCommand[]): void;
  /** Immediate state notification to observers (the emit half of the throttle). */
  emitNotify(): void;
}

/**
 * The two fixed autosave clocks behind the workspace facade: the 300 ms
 * config-mutation debounce and the frame queue (250 ms / 256 frames /
 * 512 KiB). Owns the queue buffers, their timers, and the Wave-1 state-observer
 * notification throttle that coalesces notifications to at most one per
 * 250 ms while capture frames are still queued.
 */
export class WorkspaceSaveQueues {
  private configQueue: PendingConfigMutation[] = [];
  private configTimer: TimerHandle | null = null;
  private frameQueue: PendingFrame[] = [];
  private frameQueueBytes = 0;
  private frameTimer: TimerHandle | null = null;
  private notifyThrottleTimer: TimerHandle | null = null;
  private notifyThrottlePending = false;

  constructor(private readonly hooks: SaveQueuesHooks) {}

  get configQueued(): boolean {
    return this.configQueue.length > 0;
  }

  get framesQueued(): boolean {
    return this.frameQueue.length > 0;
  }

  /** Mutation-command count of the queue contents (config entries plus frame
   * append groups) for the unsaved-mutation counter. */
  get queuedMutationCount(): number {
    return this.configQueue.length + frameAppendCommandCount(this.frameQueue);
  }

  /** Buffer cloned config mutations on the 300 ms debounce clock. An empty
   * batch leaves the pending timer untouched, exactly as before. */
  enqueueConfigMutations(
    context: SaveContext,
    commands: readonly WorkspaceBufferedMutationCommand[],
  ): void {
    for (const command of commands) this.configQueue.push({ context, command });
    if (commands.length === 0) return;
    if (this.configTimer !== null) globalThis.clearTimeout(this.configTimer);
    this.configTimer = globalThis.setTimeout(() => {
      this.configTimer = null;
      this.releaseConfig();
    }, WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS);
    this.notify();
  }

  /** Buffer one captured frame on the 250 ms / 256-frame / 512 KiB clock,
   * flushing early once the next frame would cross a queue bound. */
  enqueueFrame(frame: PendingFrame): void {
    if (
      this.frameQueue.length > 0 &&
      (this.frameQueue.length + 1 > WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
        this.frameQueueBytes + frame.payload.data.length > WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES)
    ) {
      this.releaseFrames();
    }

    this.frameQueue.push(frame);
    this.frameQueueBytes += frame.payload.data.length;
    if (this.frameQueue.length === 1) {
      this.frameTimer = globalThis.setTimeout(() => {
        this.frameTimer = null;
        this.releaseFrames();
      }, WORKSPACE_FRAME_AUTOSAVE_DELAY_MS);
    }
    if (
      this.frameQueue.length >= WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
      this.frameQueueBytes >= WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES
    ) {
      this.releaseFrames();
    }
    this.notify();
  }

  releaseAll(): void {
    this.releaseConfig();
    this.releaseFrames();
  }

  /**
   * Drop every buffered mutation after a latched save failure and clear the
   * pending timers. Returns the number of abandoned mutation commands so the
   * facade can retain them in its unsaved-mutation counter.
   */
  abandon(): number {
    if (this.configTimer !== null) globalThis.clearTimeout(this.configTimer);
    if (this.frameTimer !== null) globalThis.clearTimeout(this.frameTimer);
    this.configTimer = null;
    this.frameTimer = null;
    const abandoned = this.queuedMutationCount;
    this.configQueue = [];
    this.frameQueue = [];
    this.frameQueueBytes = 0;
    return abandoned;
  }

  /**
   * Reset queue contents when a hydrated workspace is installed. Timers stay
   * armed exactly as before: firing into an empty queue is a no-op.
   */
  reset(): void {
    this.configQueue = [];
    this.frameQueue = [];
    this.frameQueueBytes = 0;
  }

  /**
   * State-observer notification. Frame data itself flows through
   * enqueueFrame/releaseFrames into the save tail, never through these
   * listeners — they observe save health and pending counts. While capture
   * frames sit in the queue (a UI-tick-rate stream), coalesce notifications
   * to at most one per 250 ms so every permanently-mounted observer panel
   * does not re-run per frame; the drain path emits an immediate final
   * notification.
   */
  notify(): void {
    if (this.frameQueue.length > 0) {
      if (this.notifyThrottleTimer !== null) {
        this.notifyThrottlePending = true;
        return;
      }
      this.hooks.emitNotify();
      this.notifyThrottleTimer = globalThis.setTimeout(() => {
        this.notifyThrottleTimer = null;
        if (this.notifyThrottlePending) {
          this.notifyThrottlePending = false;
          this.notify();
        }
      }, WORKSPACE_NOTIFY_THROTTLE_MS);
      return;
    }
    this.clearNotifyThrottle();
    this.hooks.emitNotify();
  }

  private clearNotifyThrottle(): void {
    if (this.notifyThrottleTimer !== null) {
      globalThis.clearTimeout(this.notifyThrottleTimer);
      this.notifyThrottleTimer = null;
    }
    this.notifyThrottlePending = false;
  }

  private releaseConfig(): void {
    if (this.configTimer !== null) {
      globalThis.clearTimeout(this.configTimer);
      this.configTimer = null;
    }
    if (this.configQueue.length === 0) return;
    const queued = this.configQueue;
    this.configQueue = [];
    for (const group of groupConfigMutationsByContext(queued)) {
      this.hooks.scheduleSaveGroup(group.context, group.commands);
    }
    this.notify();
  }

  private releaseFrames(): void {
    if (this.frameTimer !== null) {
      globalThis.clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.frameQueue.length === 0) return;
    const queued = this.frameQueue;
    this.frameQueue = [];
    this.frameQueueBytes = 0;
    for (const group of groupFramesByContext(queued)) {
      this.hooks.scheduleSaveGroup(group.context, frameAppendCommands(group.frames));
    }
    this.notify();
  }
}

/**
 * Cached accept/reject gate for the save boundary. The decision only depends
 * on local gate state (activation phases, latched failures, and the
 * queue/save-in-flight flags that drive save health) plus the epoch-bumped
 * workspace identity, so a stable key short-circuits the full view-model
 * snapshot the evaluation would otherwise build — critical because this gate
 * runs for every captured frame batch during streaming.
 */
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

function frameAppendCommands(frames: readonly PendingFrame[]): WorkspaceMutationCommand[] {
  if (frames.length === 0) return [];
  const commands: WorkspaceMutationCommand[] = [];
  let sessionId = frames[0].sessionId;
  let startSeq = frames[0].sequence;
  let previousSeq = startSeq - 1;
  let payloads: WorkspaceFramePayload[] = [];
  const release = (): void => {
    if (payloads.length === 0) return;
    commands.push({
      kind: 'append-frames',
      sessionId,
      payload: { startSeq, frames: payloads },
    });
  };
  for (const frame of frames) {
    if (frame.sessionId !== sessionId || frame.sequence !== previousSeq + 1) {
      release();
      sessionId = frame.sessionId;
      startSeq = frame.sequence;
      payloads = [];
    }
    // Serialization boundary for the save queue: queued payloads carry the raw
    // capture buffer, and the JSON IPC contract requires the plain number
    // array. This is the only place the conversion happens (see
    // toIpcFramePayload) so a later base64 switch stays localized.
    payloads.push(toIpcFramePayload(frame.payload));
    previousSeq = frame.sequence;
  }
  release();
  return commands;
}

/** Command count of {@link frameAppendCommands} without materializing payloads. */
function frameAppendCommandCount(frames: readonly PendingFrame[]): number {
  if (frames.length === 0) return 0;
  let commands = 1;
  for (let index = 1; index < frames.length; index += 1) {
    const frame = frames[index];
    const previous = frames[index - 1];
    if (frame.sessionId !== previous.sessionId || frame.sequence !== previous.sequence + 1) {
      commands += 1;
    }
  }
  return commands;
}

function groupConfigMutationsByContext(
  queued: readonly PendingConfigMutation[],
): Array<{ context: SaveContext; commands: WorkspaceBufferedMutationCommand[] }> {
  const groups: Array<{ context: SaveContext; commands: WorkspaceBufferedMutationCommand[] }> = [];
  for (const item of queued) {
    const last = groups.at(-1);
    if (
      last &&
      last.context.epoch === item.context.epoch &&
      last.context.workspaceId === item.context.workspaceId
    ) {
      last.commands.push(item.command);
    } else {
      groups.push({ context: item.context, commands: [item.command] });
    }
  }
  return groups;
}

function groupFramesByContext(
  queued: readonly PendingFrame[],
): Array<{ context: SaveContext; frames: PendingFrame[] }> {
  const groups: Array<{ context: SaveContext; frames: PendingFrame[] }> = [];
  for (const item of queued) {
    const last = groups.at(-1);
    if (
      last &&
      last.context.epoch === item.context.epoch &&
      last.context.workspaceId === item.context.workspaceId
    ) {
      last.frames.push(item);
    } else {
      groups.push({ context: item.context, frames: [item] });
    }
  }
  return groups;
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
