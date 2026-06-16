export interface ModbusReplayItem {
  ts: number;
}

export interface ModbusReplayCoordinatorOptions<TItem extends ModbusReplayItem> {
  runItem: (item: TItem) => Promise<void>;
  onProgress?: (remaining: number) => void;
  onIdle?: () => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/**
 * Replays timestamped Modbus items at their recorded relative cadence.
 *
 * This coordinator owns only queue ordering, timer lifecycle, and finish/stop
 * semantics. It deliberately does not know how an item maps to a register or
 * how writes are sent on the wire.
 */
export class ModbusReplayCoordinator<TItem extends ModbusReplayItem> {
  private queue: TItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseTs = 0;
  private startWall = 0;
  private running = false;
  private generation = 0;
  private readonly options: ModbusReplayCoordinatorOptions<TItem>;

  constructor(options: ModbusReplayCoordinatorOptions<TItem>) {
    this.options = options;
  }

  start(items: readonly TItem[]): boolean {
    this.stop();
    if (items.length === 0) return false;

    this.queue = [...items].sort((a, b) => a.ts - b.ts);
    this.baseTs = this.queue[0].ts;
    this.startWall = this.now();
    this.running = true;
    this.generation += 1;
    this.options.onProgress?.(this.queue.length);
    this.scheduleNext(this.generation);
    return true;
  }

  stop(): boolean {
    const wasRunning = this.running;
    this.generation += 1;
    this.running = false;
    this.clearTimer();
    this.queue = [];
    if (wasRunning) this.options.onIdle?.();
    return wasRunning;
  }

  isRunning(): boolean {
    return this.running;
  }

  remaining(): number {
    return this.queue.length;
  }

  private scheduleNext(generation: number): void {
    if (!this.running || generation !== this.generation || this.queue.length === 0) {
      this.finish(generation);
      return;
    }

    const next = this.queue[0];
    const dueAt = this.startWall + Math.max(0, next.ts - this.baseTs);
    const delay = Math.max(0, dueAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOne(generation);
    }, delay);
  }

  private async runOne(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;

    const item = this.queue.shift();
    if (!item) {
      this.finish(generation);
      return;
    }

    try {
      await this.options.runItem(item);
    } catch (error) {
      if (this.running && generation === this.generation) this.options.onError?.(error);
    }

    if (!this.running || generation !== this.generation) return;
    this.options.onProgress?.(this.queue.length);
    this.scheduleNext(generation);
  }

  private finish(generation: number): void {
    if (generation !== this.generation) return;
    const wasRunning = this.running;
    this.running = false;
    this.clearTimer();
    this.queue = [];
    if (wasRunning) this.options.onIdle?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
