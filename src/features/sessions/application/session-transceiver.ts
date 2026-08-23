import { computed, type ComputedRef, type Ref } from 'vue';
import type { McumgrTraceFrame } from '@/generated/ipc-contracts';
import { mcumgrTraceFramesToDataFrames } from '@/lib/mcumgr-trace';
import { sessionCaptureTimeline, type SessionCaptureTimeline } from '@/lib/capture-stream';
import type { DataFrame, SerialSendResult, SerialWriteOptions } from '@/types';
import type { SessionCapturePort } from '@/features/sessions/ports/session-ports';
import type { SerialAutomationPausePort } from '@/features/serial';
import {
  createSerialBridge,
  type SerialBridge,
  type SerialBridgeCreateOptions,
} from './serial-bridge';

const EMPTY_FRAMES: readonly DataFrame[] = Object.freeze([]);

/**
 * Read-only projection consumed by presentation code. The mutable frame store
 * remains private to the transceiver/capture boundary.
 */
export interface SessionRawDataView {
  readonly sessionId: string;
  readonly frames: ComputedRef<readonly DataFrame[]>;
  readonly bufferedFrames: ComputedRef<readonly DataFrame[]>;
  readonly timeline: ComputedRef<SessionCaptureTimeline | null>;
  readonly version: ComputedRef<number>;
  readonly paused: ComputedRef<boolean>;
  readonly txBytes: ComputedRef<number>;
  readonly rxBytes: ComputedRef<number>;
  readonly txFrames: ComputedRef<number>;
  readonly rxFrames: ComputedRef<number>;
  readonly droppedBytes: ComputedRef<number>;
}

/** Narrow API handed to protocol/function layers. */
export interface SessionFeatureTransport {
  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult>;
  onReceive(listener: (bytes: Uint8Array) => void): () => void;
}

export interface SessionTransceiverCreateOptions {
  readonly capture: SessionCapturePort;
  readonly serial: SerialBridgeCreateOptions;
  readonly createSerial?: (options: SerialBridgeCreateOptions) => SerialBridge;
}

/**
 * The single per-session RX/TX data plane.
 *
 * It owns the public serial API, fans native RX out to every function layer,
 * and exposes the one retained raw-data timeline used by presentation code.
 * Alternate physical owners (currently the Rust MCUmgr backend) must replay
 * their wire trace through {@link ingestMcumgrTrace}; they may not mutate the
 * display/session arrays directly.
 */
export class SessionTransceiver implements SessionFeatureTransport {
  readonly rawData: SessionRawDataView;
  readonly serial: SerialBridge;

  private readonly sessionId: string;
  private readonly capture: SessionCapturePort;
  private readonly appendAutoLog: (sessionId: string, frame: DataFrame) => void;
  private readonly receiveListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly removeNativeReceiveListener: () => void;
  private disposed = false;

  constructor(options: SessionTransceiverCreateOptions) {
    this.sessionId = options.serial.sessionId;
    this.capture = options.capture;
    this.appendAutoLog = options.serial.appendAutoLogFrame;
    this.serial = (options.createSerial ?? createSerialBridge)({
      ...options.serial,
      capture: this.capture,
    });
    const sessionValue = () => {
      // Capture arrays/counters are deliberately mutated through a shallow hot
      // path. The explicit version is their reactive invalidation contract.
      void this.capture.framesVersion.value;
      return this.capture.session.value;
    };
    this.rawData = Object.freeze({
      sessionId: options.serial.sessionId,
      frames: computed(() => sessionValue()?.frames ?? EMPTY_FRAMES),
      bufferedFrames: computed(() => sessionValue()?.pausedFrames ?? EMPTY_FRAMES),
      timeline: computed(() => {
        const session = sessionValue();
        return session ? sessionCaptureTimeline(session) : null;
      }),
      version: this.capture.framesVersion,
      paused: computed(() => sessionValue()?.capturePaused ?? false),
      txBytes: computed(() => sessionValue()?.txBytes ?? 0),
      rxBytes: computed(() => sessionValue()?.rxBytes ?? 0),
      txFrames: computed(() => sessionValue()?.txFrames ?? 0),
      rxFrames: computed(() => sessionValue()?.rxFrames ?? 0),
      droppedBytes: computed(() => sessionValue()?.droppedBytes ?? 0),
    });
    this.removeNativeReceiveListener = this.serial.rawBytes((bytes) => {
      this.publishReceive(bytes);
    });
  }

  get isConnecting(): Ref<boolean> {
    return this.serial.isConnecting;
  }

  get isConnected(): Ref<boolean> {
    return this.serial.isConnected;
  }

  get isClosing(): Ref<boolean> {
    return this.serial.isClosing;
  }

  get reconnecting(): Ref<boolean> {
    return this.serial.reconnecting;
  }

  get error(): Ref<string | null> {
    return this.serial.error;
  }

  get connectionFailure(): SerialBridge['connectionFailure'] {
    return this.serial.connectionFailure;
  }

  get totalDroppedBytes(): Ref<number> {
    return this.serial.totalDroppedBytes;
  }

  get serialTransactions(): SerialBridge['serialTransactions'] {
    return this.serial.serialTransactions;
  }

  start(): Promise<boolean> {
    return this.serial.start();
  }

  stop(): ReturnType<SerialBridge['stop']> {
    return this.serial.stop();
  }

  send(
    data: string,
    isHex: boolean,
    options?: SerialWriteOptions,
  ): ReturnType<SerialBridge['send']> {
    return this.serial.send(data, isHex, options);
  }

  sendBytes(payload: Uint8Array, options?: SerialWriteOptions): Promise<SerialSendResult> {
    return this.serial.sendBytes(payload, options);
  }

  sendBreak(durationMs?: number): Promise<boolean> {
    return this.serial.sendBreak(durationMs);
  }

  registerAutomation(port: SerialAutomationPausePort): () => void {
    return this.serialTransactions.registerAutomation(port);
  }

  onReceive(listener: (bytes: Uint8Array) => void): () => void {
    if (this.disposed) return () => undefined;
    this.receiveListeners.add(listener);
    return () => this.receiveListeners.delete(listener);
  }

  onCaptureCleared(listener: () => void): () => void {
    return this.capture.onCleared(listener);
  }

  onCleared(listener: () => void): () => void {
    return this.onCaptureCleared(listener);
  }

  clearRawData(): void {
    this.capture.clear();
  }

  setCapturePaused(paused: boolean): void {
    this.capture.setPaused(paused);
  }

  /**
   * Import MCUmgr's native wire trace into the same data plane as normal
   * serial traffic. RX is broadcast before capture publication, matching the
   * native serial ordering contract used by parsers and protocol functions.
   */
  ingestMcumgrTrace(frames: readonly McumgrTraceFrame[]): void {
    const mapped = mcumgrTraceFramesToDataFrames(frames);
    for (let index = 0; index < mapped.length; index += 1) {
      const frame = mapped[index];
      if (frame.direction === 'RX') this.publishReceive(frame.data);
      const captured = this.capture.add(frame, { publish: index === mapped.length - 1 });
      if (captured) this.appendAutoLog(this.sessionId, captured);
    }
  }

  ingestTraceFrames(frames: readonly McumgrTraceFrame[]): void {
    this.ingestMcumgrTrace(frames);
  }

  async suspendConnection(): Promise<void> {
    await this.stop();
  }

  resumeConnection(): Promise<boolean> {
    return this.start();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeNativeReceiveListener();
    this.receiveListeners.clear();
    await this.serial.dispose();
  }

  private publishReceive(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    for (const listener of [...this.receiveListeners]) listener(bytes);
  }
}

export function createSessionTransceiver(
  options: SessionTransceiverCreateOptions,
): SessionTransceiver {
  return new SessionTransceiver(options);
}
