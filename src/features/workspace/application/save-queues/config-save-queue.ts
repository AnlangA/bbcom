import type { WorkspaceMutationCommand } from '@/features/workspace/types';
import {
  WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS,
  type WorkspaceConfigMutationCommand,
} from '../types';

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

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface ConfigSaveQueueHooks {
  scheduleSaveGroup(context: SaveContext, commands: readonly WorkspaceMutationCommand[]): void;
  onNotify(): void;
}

export class ConfigSaveQueue {
  private queue: PendingConfigMutation[] = [];
  private timer: TimerHandle | null = null;

  constructor(private readonly hooks: ConfigSaveQueueHooks) {}

  get queued(): boolean {
    return this.queue.length > 0;
  }

  get mutationCount(): number {
    return this.queue.length;
  }

  enqueue(
    context: SaveContext,
    commands: readonly WorkspaceBufferedMutationCommand[],
  ): void {
    for (const command of commands) this.queue.push({ context, command });
    if (commands.length === 0) return;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      this.release();
    }, WORKSPACE_CONFIG_AUTOSAVE_DELAY_MS);
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
    for (const group of groupConfigMutationsByContext(queued)) {
      this.hooks.scheduleSaveGroup(group.context, group.commands);
    }
    this.hooks.onNotify();
  }

  abandon(): number {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    const abandoned = this.queue.length;
    this.queue = [];
    return abandoned;
  }

  reset(): void {
    this.queue = [];
  }
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
