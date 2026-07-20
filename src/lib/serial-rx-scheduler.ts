import { DEFAULT_RX_FRAME_GAP_MS, normalizeRxFrameGapMs } from './serial-framing';

export const SERIAL_RX_DRAIN_BYTES = 64 * 1024;
export const SERIAL_RX_DRAIN_CHUNKS = 64;
/** @deprecated Use a session's configurable RX frame gap. */
export const SERIAL_RX_DRAIN_INTERVAL_MS = DEFAULT_RX_FRAME_GAP_MS;
export const SERIAL_UI_VISIBLE_INTERVAL_MS = 17;
export const SERIAL_UI_HIDDEN_INTERVAL_MS = 250;

export interface SerialTimerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  microtask(callback: () => void): void;
}

const defaultScheduler: SerialTimerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  microtask: (callback) => queueMicrotask(callback),
};

export interface SerialRxPending {
  bytes: number;
  chunks: number;
}

/**
 * Schedules capture work independently of painting. Small bursts are framed
 * after a configurable period of RX inactivity; 64 KiB or 64 native chunks
 * still drain on the next microtask to keep memory bounded.
 */
export class SerialRxDrainScheduler {
  private readonly getPending: () => SerialRxPending;
  private readonly drain: () => void;
  private readonly scheduler: SerialTimerScheduler;
  private readonly inactivityGapMs: number;
  private timer: unknown | null = null;
  private immediateScheduled = false;
  private generation = 0;

  constructor(
    getPending: () => SerialRxPending,
    drain: () => void,
    scheduler: SerialTimerScheduler = defaultScheduler,
    inactivityGapMs: number = DEFAULT_RX_FRAME_GAP_MS,
  ) {
    this.getPending = getPending;
    this.drain = drain;
    this.scheduler = scheduler;
    this.inactivityGapMs = normalizeRxFrameGapMs(inactivityGapMs);
  }

  notify(): void {
    const pending = this.getPending();
    if (pending.bytes <= 0 || pending.chunks <= 0) return;
    if (pending.bytes >= SERIAL_RX_DRAIN_BYTES || pending.chunks >= SERIAL_RX_DRAIN_CHUNKS) {
      if (this.timer !== null) {
        this.scheduler.cancel(this.timer);
        this.timer = null;
        this.generation += 1;
      }
      if (this.immediateScheduled) return;
      this.immediateScheduled = true;
      const generation = this.generation;
      this.scheduler.microtask(() => {
        if (generation !== this.generation) return;
        this.immediateScheduled = false;
        this.drainPending();
      });
      return;
    }
    if (this.immediateScheduled) return;
    // Frame on silence, not on time elapsed since the first byte. Every new
    // native chunk restarts the inactivity window.
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
      this.generation += 1;
    }
    const generation = this.generation;
    this.timer = this.scheduler.schedule(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      this.drainPending();
    }, this.inactivityGapMs);
  }

  flushNow(): void {
    this.invalidateScheduledWork();
    this.drainPending();
  }

  cancel(): void {
    this.invalidateScheduledWork();
  }

  private invalidateScheduledWork(): void {
    this.generation += 1;
    this.immediateScheduled = false;
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
  }

  private drainPending(): void {
    const pending = this.getPending();
    if (pending.bytes <= 0 || pending.chunks <= 0) return;
    this.drain();
    // A custom drain may intentionally leave a tail.
    this.notify();
  }
}

/** Coalesces Vue/UI publication separately from the capture drain cadence. */
export class SerialUiPublishScheduler {
  private readonly publish: () => void;
  private readonly isVisible: () => boolean;
  private readonly scheduler: SerialTimerScheduler;
  private timer: unknown | null = null;
  private dirty = false;
  private generation = 0;

  constructor(
    publish: () => void,
    isVisible: () => boolean,
    scheduler: SerialTimerScheduler = defaultScheduler,
  ) {
    this.publish = publish;
    this.isVisible = isVisible;
    this.scheduler = scheduler;
  }

  markDirty(): void {
    this.dirty = true;
    this.schedule();
  }

  visibilityChanged(): void {
    if (!this.dirty) return;
    this.cancelTimer();
    this.schedule();
  }

  flushNow(): void {
    this.cancelTimer();
    if (!this.dirty) return;
    this.dirty = false;
    this.publish();
  }

  cancel(): void {
    this.cancelTimer();
    this.dirty = false;
  }

  private schedule(): void {
    if (!this.dirty || this.timer !== null) return;
    const generation = this.generation;
    const delay = this.isVisible() ? SERIAL_UI_VISIBLE_INTERVAL_MS : SERIAL_UI_HIDDEN_INTERVAL_MS;
    this.timer = this.scheduler.schedule(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.publish();
    }, delay);
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== null) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
  }
}
