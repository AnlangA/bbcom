export interface LoopScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultScheduler: LoopScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs one asynchronous send at a time. The delay starts after the previous
 * send settles, so a slow IPC/device write can never create an unbounded queue.
 * Stopping invalidates the active generation: an in-flight send may finish,
 * but it cannot schedule another tick.
 */
export class AsyncSendLoop {
  private generation = 0;
  private timer: unknown | null = null;
  private running = false;
  private readonly task: () => Promise<void>;
  private readonly intervalMs: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly scheduler: LoopScheduler;

  constructor(
    task: () => Promise<void>,
    intervalMs: () => number,
    onError: (error: unknown) => void = () => undefined,
    scheduler: LoopScheduler = defaultScheduler,
  ) {
    this.task = task;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.scheduler = scheduler;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  start(): boolean {
    if (this.running) return false;
    this.running = true;
    const generation = ++this.generation;
    void this.tick(generation);
    return true;
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
  }

  private async tick(generation: number): Promise<void> {
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    }
    if (!this.running || generation !== this.generation) return;
    const delayMs = Math.max(0, Math.floor(this.intervalMs()));
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      void this.tick(generation);
    }, delayMs);
  }
}
