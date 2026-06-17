export interface ModbusLoopCoordinatorOptions {
  shouldRunRead: () => boolean;
  shouldRunWrite: () => boolean;
  getReadIntervalMs: () => number;
  getWriteIntervalMs: () => number;
  runRead: () => Promise<void>;
  runWrite: () => Promise<void>;
}

/**
 * Coordinates the Modbus master's two periodic loops around one half-duplex bus.
 *
 * It owns only scheduling and fairness:
 * - one exclusive operation at a time;
 * - timer de-duplication;
 * - pause/resume across disconnects;
 * - overdue loop replay when a timer fires while the bus is busy.
 */
export class ModbusLoopCoordinator {
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  private readDueWhileBusy = false;
  private writeDueWhileBusy = false;
  private readonly options: ModbusLoopCoordinatorOptions;

  constructor(options: ModbusLoopCoordinatorOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.resume();
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }

  pause(): void {
    this.readDueWhileBusy = false;
    this.writeDueWhileBusy = false;
    this.clearReadTimer();
    this.clearWriteTimer();
  }

  resume(): void {
    const readOverdue = this.readDueWhileBusy;
    const writeOverdue = this.writeDueWhileBusy;
    this.readDueWhileBusy = false;
    this.writeDueWhileBusy = false;

    // Writes update device state; if both loops became overdue while a slow
    // read held the bus, let the pending write catch up first.
    if (writeOverdue) this.scheduleWrite(0);
    if (readOverdue) this.scheduleRead(0);
    this.scheduleRead();
    this.scheduleWrite();
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await sleep(5);
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.resume();
    }
  }

  scheduleRead(delayMs = this.readIntervalMs()): void {
    if (this.readTimer) return;
    if (this.stopped || !this.options.shouldRunRead()) {
      this.readDueWhileBusy = false;
      return;
    }
    if (this.busy) {
      this.readDueWhileBusy = true;
      return;
    }

    this.readTimer = setTimeout(async () => {
      this.readTimer = null;
      if (this.stopped) return;
      if (this.busy) {
        this.readDueWhileBusy = true;
        return;
      }
      await this.runExclusive(this.options.runRead);
      this.scheduleRead();
    }, delayMs);
  }

  scheduleWrite(delayMs = this.writeIntervalMs()): void {
    if (this.writeTimer) return;
    if (this.stopped || !this.options.shouldRunWrite()) {
      this.writeDueWhileBusy = false;
      return;
    }
    if (this.busy) {
      this.writeDueWhileBusy = true;
      return;
    }

    this.writeTimer = setTimeout(async () => {
      this.writeTimer = null;
      if (this.stopped) return;
      if (this.busy) {
        this.writeDueWhileBusy = true;
        return;
      }
      await this.runExclusive(this.options.runWrite);
      this.scheduleWrite();
    }, delayMs);
  }

  isBusy(): boolean {
    return this.busy;
  }

  private clearReadTimer(): void {
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
  }

  private clearWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  private readIntervalMs(): number {
    return Math.max(100, this.options.getReadIntervalMs());
  }

  private writeIntervalMs(): number {
    return Math.max(100, this.options.getWriteIntervalMs());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
