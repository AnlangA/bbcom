export const SESSION_CONFIG_DEBOUNCE_MS = 500;
export const SESSION_FRAME_CHECKPOINT_MS = 10_000;
export const SESSION_FINAL_FLUSH_TIMEOUT_MS = 2_000;

export interface SessionPersistenceTimerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultTimerScheduler: SessionPersistenceTimerScheduler = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    (handle as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    return handle;
  },
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type SessionPersistenceFlush = (includeFrames: boolean) => Promise<void>;

/**
 * Separates low-frequency capture checkpoints from ordinary configuration
 * writes. Configuration uses a trailing 500 ms debounce; frame traffic starts
 * exactly one 10 s checkpoint timer and never resets it for later frames.
 */
export class SessionPersistenceScheduler {
  private readonly flush: SessionPersistenceFlush;
  private readonly timers: SessionPersistenceTimerScheduler;
  private readonly onError: (error: unknown) => void;
  private configTimer: unknown = null;
  private frameTimer: unknown = null;
  private configDirty = false;
  private configIncludesFrames = false;
  private framesDirty = false;

  constructor(
    flush: SessionPersistenceFlush,
    options: {
      timers?: SessionPersistenceTimerScheduler;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    this.flush = flush;
    this.timers = options.timers ?? defaultTimerScheduler;
    this.onError = options.onError ?? (() => undefined);
  }

  markConfigDirty(includeFrames = false): void {
    this.configDirty = true;
    this.configIncludesFrames ||= includeFrames;
    if (this.configTimer !== null) this.timers.cancel(this.configTimer);
    this.configTimer = this.timers.schedule(() => {
      this.configTimer = null;
      if (!this.configDirty) return;
      const flushFrames = this.configIncludesFrames;
      this.configDirty = false;
      this.configIncludesFrames = false;
      if (flushFrames) {
        this.framesDirty = false;
        this.clearFrameTimer();
      }
      void this.flush(flushFrames).catch(this.onError);
    }, SESSION_CONFIG_DEBOUNCE_MS);
  }

  markFramesDirty(): void {
    this.framesDirty = true;
    if (this.frameTimer !== null) return;
    this.frameTimer = this.timers.schedule(() => {
      this.frameTimer = null;
      if (!this.framesDirty) return;
      this.framesDirty = false;
      this.clearConfigTimer();
      this.configDirty = false;
      this.configIncludesFrames = false;
      void this.flush(true).catch(this.onError);
    }, SESSION_FRAME_CHECKPOINT_MS);
  }

  /** Force a complete metadata + frame checkpoint immediately. */
  flushNow(): Promise<void> {
    this.clearTimers();
    this.configDirty = false;
    this.configIncludesFrames = false;
    this.framesDirty = false;
    return this.flush(true);
  }

  /**
   * Request the final checkpoint but stop waiting after two seconds. The write
   * remains observed after timeout so a late rejection never becomes unhandled.
   */
  flushFinal(): Promise<'completed' | 'timeout'> {
    const operation = this.flushNow();
    operation.catch(this.onError);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = this.timers.schedule(() => {
        if (settled) return;
        settled = true;
        resolve('timeout');
      }, SESSION_FINAL_FLUSH_TIMEOUT_MS);

      operation.then(
        () => {
          if (settled) return;
          settled = true;
          this.timers.cancel(timeout);
          resolve('completed');
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.timers.cancel(timeout);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    this.clearTimers();
    this.configDirty = false;
    this.configIncludesFrames = false;
    this.framesDirty = false;
  }

  private clearConfigTimer(): void {
    if (this.configTimer === null) return;
    this.timers.cancel(this.configTimer);
    this.configTimer = null;
  }

  private clearTimers(): void {
    this.clearConfigTimer();
    this.clearFrameTimer();
  }

  private clearFrameTimer(): void {
    if (this.frameTimer === null) return;
    this.timers.cancel(this.frameTimer);
    this.frameTimer = null;
  }
}
