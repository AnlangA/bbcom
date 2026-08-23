import { CaptureAccountingStore } from '@/features/platform/application';
import { SaveGate, WorkspaceSaveQueues, type SaveQueuesHooks } from './save-queues/index';
import type { WorkspaceLatchedSaveFailure } from './types';

/** Single owner of the active write epoch, queues, accounting and save latch. */
export class WorkspaceSaveCoordinator {
  readonly queues: WorkspaceSaveQueues;
  readonly gate = new SaveGate();
  readonly captureAccounting = new CaptureAccountingStore();

  workspaceEpoch = 0;
  saveTail: Promise<void> = Promise.resolve();
  scheduledSaveGroups = 0;
  saveInFlight = false;
  lastSaveFailure: WorkspaceLatchedSaveFailure | null = null;
  retainedUnsavedMutations = 0;

  constructor(hooks: SaveQueuesHooks) {
    this.queues = new WorkspaceSaveQueues(hooks);
  }

  openEpoch(): number {
    this.workspaceEpoch += 1;
    this.queues.reset();
    this.saveTail = Promise.resolve();
    this.scheduledSaveGroups = 0;
    this.saveInFlight = false;
    this.lastSaveFailure = null;
    this.retainedUnsavedMutations = 0;
    return this.workspaceEpoch;
  }
}
