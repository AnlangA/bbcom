import type { WorkspaceFramePayload } from '../../../../generated/ipc-contracts';
import type { WorkspaceMutationCommand } from '@/features/workspace/types';
import { toIpcFramePayload, type WorkspaceQueuedFramePayload } from '../../adapters';
import {
  WORKSPACE_FRAME_AUTOSAVE_DELAY_MS,
  WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES,
  WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES,
} from '../types';
import type { SaveContext } from './config-save-queue';

export interface PendingFrame {
  readonly context: SaveContext;
  readonly sessionId: string;
  readonly sequence: number;
  readonly payload: WorkspaceQueuedFramePayload;
}

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface FrameSaveQueueHooks {
  scheduleSaveGroup(context: SaveContext, commands: readonly WorkspaceMutationCommand[]): void;
  onNotify(): void;
}

export class FrameSaveQueue {
  private queue: PendingFrame[] = [];
  private queueBytes = 0;
  private timer: TimerHandle | null = null;

  constructor(private readonly hooks: FrameSaveQueueHooks) {}

  get queued(): boolean {
    return this.queue.length > 0;
  }

  get mutationCount(): number {
    return frameAppendCommandCount(this.queue);
  }

  enqueue(frame: PendingFrame): void {
    if (
      this.queue.length > 0 &&
      (this.queue.length + 1 > WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
        this.queueBytes + frame.payload.data.length > WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES)
    ) {
      this.release();
    }

    this.queue.push(frame);
    this.queueBytes += frame.payload.data.length;
    if (this.queue.length === 1) {
      this.timer = globalThis.setTimeout(() => {
        this.timer = null;
        this.release();
      }, WORKSPACE_FRAME_AUTOSAVE_DELAY_MS);
    }
    if (
      this.queue.length >= WORKSPACE_FRAME_AUTOSAVE_MAX_FRAMES ||
      this.queueBytes >= WORKSPACE_FRAME_AUTOSAVE_MAX_BYTES
    ) {
      this.release();
    }
    this.hooks.onNotify();
  }

  release(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const queued = this.queue;
    this.queue = [];
    this.queueBytes = 0;
    for (const group of groupFramesByContext(queued)) {
      this.hooks.scheduleSaveGroup(group.context, frameAppendCommands(group.frames));
    }
    this.hooks.onNotify();
  }

  abandon(): number {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    const abandoned = frameAppendCommandCount(this.queue);
    this.queue = [];
    this.queueBytes = 0;
    return abandoned;
  }

  reset(): void {
    this.queue = [];
    this.queueBytes = 0;
  }
}

export function frameAppendCommands(frames: readonly PendingFrame[]): WorkspaceMutationCommand[] {
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
    payloads.push(toIpcFramePayload(frame.payload));
    previousSeq = frame.sequence;
  }
  release();
  return commands;
}

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
