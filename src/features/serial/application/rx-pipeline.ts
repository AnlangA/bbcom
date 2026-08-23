import { concatUint8Arrays } from '@/lib/bytes';
import { normalizeRxFrameGapMs } from '@/lib/serial-framing';
import { SerialRxQueue } from '@/lib/serial-rx-queue';
import {
  SerialRxDrainScheduler,
  SerialUiPublishScheduler,
  type SerialTimerScheduler,
} from '@/lib/serial-rx-scheduler';
import { MAX_INPUT_SIZE } from '@/types';
import { logger } from '@/lib/logger';
import type { SerialConnectionRuntimeRefs } from './serial-connection-runtime';
import type {
  SerialConnectionOptions,
  SerialConnectionSink,
  VisibilityPort,
} from './serial-connection-types';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;

export interface RxPipelineDeps extends SerialConnectionRuntimeRefs {
  sessionId: string;
  sink: SerialConnectionSink;
  options: SerialConnectionOptions | undefined;
  timerScheduler?: SerialTimerScheduler;
  visibilityPort?: VisibilityPort;
}

export interface RxPipeline {
  enqueueReceivedBytes(bytes: Uint8Array, generation?: number): void;
  flushRxAndPublish(): void;
  resetRxDrain(rxFrameGapMs: number): void;
  cancelRxDrain(): void;
  cancelUiPublisher(): void;
  resetQueue(): void;
  clearPendingQueue(): void;
  cancelPublishers(): void;
  rawBytes(callback: (bytes: Uint8Array) => void): () => void;
  clearRawByteObservers(): void;
  clearOverflowTracking(): void;
  visibilityChanged(): void;
}

export function createRxPipeline({
  state,
  serialTransactions,
  sessionId,
  sink,
  options,
  timerScheduler,
  visibilityPort,
}: RxPipelineDeps): RxPipeline {
  const rxQueue = new SerialRxQueue({
    maxBytes: MAX_RX_QUEUE_BYTES,
    maxChunks: MAX_RX_QUEUE_CHUNKS,
  });
  let rxOverflowErrorMessage: string | null = null;

  const isDocumentVisible = () => visibilityPort?.isVisible() ?? true;
  const uiPublisher = new SerialUiPublishScheduler(
    () => {
      sink.updateDroppedBytes(sessionId, state.totalDroppedBytes.value);
      sink.publishFrames(sessionId);
    },
    isDocumentVisible,
    timerScheduler,
  );

  const rawByteObservers = new Set<(bytes: Uint8Array) => void>();

  function createRxDrain(rxFrameGapMs: number): SerialRxDrainScheduler {
    return new SerialRxDrainScheduler(
      () => ({ bytes: rxQueue.pendingBytes, chunks: rxQueue.pendingChunks }),
      flushQueue,
      timerScheduler,
      normalizeRxFrameGapMs(rxFrameGapMs),
    );
  }

  let rxDrain = createRxDrain(0);

  function resetRxDrain(rxFrameGapMs: number): void {
    rxDrain.cancel();
    rxDrain = createRxDrain(rxFrameGapMs);
  }

  function cancelRxDrain(): void {
    rxDrain.cancel();
  }

  function cancelUiPublisher(): void {
    uiPublisher.cancel();
  }

  function resetQueue(): void {
    rxQueue.reset();
    rxOverflowErrorMessage = null;
  }

  function clearPendingQueue(): void {
    rxQueue.clearPending();
  }

  function enqueueReceivedBytes(bytes: Uint8Array, generation = state.connectionGeneration): void {
    if (bytes.length === 0) return;
    const mirrored = serialTransactions.offerRx(generation, bytes);
    if (mirrored.status === 'backpressure') {
      logger.warn('serial transaction RX mirror backpressure for', sessionId);
    }
    for (const observer of rawByteObservers) observer(bytes);

    const result = rxQueue.enqueue(bytes);
    state.totalDroppedBytes.value = result.totalDroppedBytes;
    if (result.overflowStarted) options?.onOverflow?.(result.totalDroppedBytes);

    if (result.droppedSinceDrain > 0) {
      rxOverflowErrorMessage = 'SERIAL_RX_OVERFLOW';
      state.error.value = rxOverflowErrorMessage;
    } else if (rxOverflowErrorMessage && state.error.value === rxOverflowErrorMessage) {
      state.error.value = null;
      rxOverflowErrorMessage = null;
    }
    rxDrain.notify();
  }

  function flushQueue(): void {
    if (rxQueue.pendingChunks === 0) return;
    const { chunks, byteLength } = rxQueue.drain();
    const frame = sink.addFrame(
      sessionId,
      { direction: 'RX', data: concatUint8Arrays(chunks, byteLength), origin: 'serial-rx' },
      { publish: false },
    );
    if (!frame) return;
    sink.appendAutoLogFrame(sessionId, frame);
    options?.onRxFrame?.(frame);
    uiPublisher.markDirty();
  }

  function flushRxAndPublish(): void {
    rxDrain.flushNow();
    uiPublisher.flushNow();
  }

  function rawBytes(callback: (bytes: Uint8Array) => void): () => void {
    rawByteObservers.add(callback);
    return () => rawByteObservers.delete(callback);
  }

  function visibilityChanged(): void {
    uiPublisher.visibilityChanged();
  }

  function clearOverflowTracking(): void {
    rxOverflowErrorMessage = null;
  }

  function clearRawByteObservers(): void {
    rawByteObservers.clear();
  }

  function cancelPublishers(): void {
    rxDrain.cancel();
    uiPublisher.cancel();
  }

  return {
    enqueueReceivedBytes,
    flushRxAndPublish,
    resetRxDrain,
    cancelRxDrain,
    cancelUiPublisher,
    resetQueue,
    clearPendingQueue,
    cancelPublishers,
    rawBytes,
    clearRawByteObservers,
    clearOverflowTracking,
    visibilityChanged,
  };
}
