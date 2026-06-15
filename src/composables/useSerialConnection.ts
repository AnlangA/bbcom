import { ref, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import { useSessionStore } from '../stores/sessions';
import { useSessionFrames } from './useSessionFrames';
import { useAutoLog } from './useAutoLog';
import { encodeUtf8, formatBytes, parseHex } from '../lib/format';
import { concatUint8Arrays } from '../lib/bytes';
import { escapeSerialPath } from '../lib/serial-utils';
import { mapDataBits, mapFlowControl, mapParity, mapStopBits } from '../lib/serial-config';
import { logger } from '../lib/logger';
import { t } from '../lib/i18n';
import { MAX_INPUT_SIZE } from '../types';
import type { PortConfig, DataFrame } from '../types';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;
const RECONNECT_INTERVAL_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

interface SerialConnectionOptions {
  onDisconnect?: () => void;
  /** Fired once per connection when RX data is first dropped due to overflow. */
  onOverflow?: (totalDroppedBytes: number) => void;
  /** Polled at disconnect time so the toggle can change live. */
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  /** Fired for each completed RX frame (after it's added to the store), so
   *  observers like the trigger engine can react without polling the store. */
  onRxFrame?: (frame: DataFrame) => void;
}

export function useSerialConnection(
  sessionId: string,
  portName: string,
  config: PortConfig,
  options?: SerialConnectionOptions,
) {
  const sessionStore = useSessionStore();
  const { addFrame } = useSessionFrames(sessionId);
  const { appendFrame } = useAutoLog();
  const port = ref<SerialPort | null>(null);
  const isConnecting = ref(false);
  const isConnected = ref(false);
  const error = ref<string | null>(null);
  /** Cumulative RX bytes dropped due to queue overflow for this connection. */
  const totalDroppedBytes = ref(0);
  /** True while auto-reconnect is cycling through retry attempts. */
  const reconnecting = ref(false);

  let dataQueue: Uint8Array[] = [];
  let totalQueueSize = 0;
  let droppedRxBytes = 0;
  let rxOverflowErrorMessage: string | null = null;
  let overflowNotified = false;
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

  // Reconnect state
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;

  // Write serializer: chains every TX through a single promise so concurrent
  // callers (cyclic loop, quick-command, history-resend, AI-fill) can never
  // overlap writeBinary on the same port. The cyclic sender drives an async
  // handler from setInterval without awaiting it; if a write IPC round-trip
  // ever exceeds the loop interval, unserialized writes would interleave on
  // the driver — undefined behavior on most serial drivers. Chaining costs one
  // microtask and serializes strictly in call order.
  let writeChain: Promise<boolean> = Promise.resolve(true);

  // Raw-bytes observers: protocol engines (e.g. the Modbus master) need
  // byte-accurate RX *before* the RAF coalesces chunks into display frames,
  // because they must verify CRCs and correlate responses to their own
  // requests. Each observer receives the exact bytes the plugin delivered.
  const rawByteObservers = new Set<(bytes: Uint8Array) => void>();

  /** Open the port, start listening, apply handshake lines, (re)register the data listener. */
  async function openConnection() {
    const p = new SerialPort({
      path: portName,
      baudRate: config.baudRate,
      dataBits: mapDataBits(config.dataBits),
      stopBits: mapStopBits(config.stopBits),
      parity: mapParity(config.parity),
      flowControl: mapFlowControl(config.flowControl),
    });
    await p.open();
    port.value = p;
    if (unlistenData) {
      unlistenData();
    }
    // Register the data callback before starting the read pump. Tauri discards
    // events that have no listener, so bytes arriving immediately on connect
    // would otherwise be dropped in the startListening/listen gap.
    unlistenData = await p.listen((data: string | number[] | Uint8Array) => {
      const bytes =
        data instanceof Uint8Array
          ? data
          : typeof data === 'string'
            ? encodeUtf8(data)
            : new Uint8Array(data as number[]);
      enqueueReceivedBytes(bytes);
    }, false);
    await p.startListening();
    // Apply DTR/RTS handshake levels — needed for Arduino auto-reset, ESP32
    // boot-mode entry, modems, etc. Some drivers reject these writes; ignore
    // so the connection itself still succeeds.
    try {
      await p.setDataTerminalReady(config.dtr);
      await p.setRequestToSend(config.rts);
    } catch {
      // control-signal write unsupported on this driver — non-fatal
    }
  }

  async function start() {
    isConnecting.value = true;
    error.value = null;
    totalDroppedBytes.value = 0;
    overflowNotified = false;
    intentionalClose = false;
    reconnecting.value = false;
    stopReconnect();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    rxOverflowErrorMessage = null;
    // Reset the write chain so a new connection starts from a settled state.
    writeChain = Promise.resolve(true);
    await closePortSafely();
    try {
      await openConnection();
    } catch (e) {
      await closePortSafely();
      logger.warn('serial open failed for', portName, e);
      error.value = String(e);
      isConnecting.value = false;
      return false;
    } finally {
      isConnecting.value = false;
    }

    isConnected.value = true;
    sessionStore.setConnected(sessionId, true);

    // The disconnect event is a global per-port event — register it once and
    // let it survive reconnects.
    if (unlistenDisconnect) unlistenDisconnect();
    unlistenDisconnect = await listen(
      `plugin-serialplugin-disconnected-${escapeSerialPath(portName)}`,
      onDisconnectEvent,
    );

    return true;
  }

  function onDisconnectEvent() {
    if (intentionalClose) {
      // Planned close via stop() — the caller already knows; just sync state.
      isConnected.value = false;
      sessionStore.setConnected(sessionId, false);
      return;
    }
    // Unplanned disconnect (cable pulled, device reset, …)
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
    unlistenData = null;
    port.value = null;

    if (options?.autoReconnect?.()) {
      startReconnect();
    } else {
      options?.onDisconnect?.();
    }
  }

  function startReconnect() {
    if (reconnecting.value || intentionalClose) return;
    reconnecting.value = true;
    reconnectAttempts = 0;
    options?.onReconnecting?.();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer || intentionalClose) return;
    reconnectTimer = setTimeout(attemptReconnect, RECONNECT_INTERVAL_MS);
  }

  async function attemptReconnect() {
    reconnectTimer = null;
    if (intentionalClose) {
      reconnecting.value = false;
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      reconnecting.value = false;
      // Give up — treat as a normal disconnect so the UI reflects it.
      options?.onDisconnect?.();
      return;
    }
    try {
      await openConnection();
      if (intentionalClose) {
        // The user disconnected while we were opening — close what we got.
        await closePortSafely();
        reconnecting.value = false;
        return;
      }
      reconnecting.value = false;
      isConnected.value = true;
      error.value = null;
      rxOverflowErrorMessage = null;
      sessionStore.setConnected(sessionId, true);
      options?.onReconnected?.();
    } catch {
      if (!intentionalClose) scheduleReconnect();
    }
  }

  function stopReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting.value = false;
  }

  function enqueueReceivedBytes(bytes: Uint8Array) {
    // Notify raw-bytes observers first — they need the exact chunk (incl. CRC
    // tails and inter-chunk boundaries) before any queue trimming/coalescing.
    if (rawByteObservers.size > 0 && bytes.length > 0) {
      for (const obs of rawByteObservers) obs(bytes);
    }

    while (
      dataQueue.length > 0 &&
      (totalQueueSize + bytes.length > MAX_RX_QUEUE_BYTES ||
        dataQueue.length >= MAX_RX_QUEUE_CHUNKS)
    ) {
      const dropped = dataQueue.shift();
      if (!dropped) break;
      totalQueueSize -= dropped.length;
      recordDrop(dropped.length);
    }

    if (bytes.length > MAX_RX_QUEUE_BYTES) {
      const retained = bytes.slice(bytes.length - MAX_RX_QUEUE_BYTES);
      recordDrop(bytes.length - retained.length);
      dataQueue.push(retained);
      totalQueueSize += retained.length;
    } else {
      dataQueue.push(bytes);
      totalQueueSize += bytes.length;
    }

    if (droppedRxBytes > 0) {
      rxOverflowErrorMessage = t('serial.error.rxOverflow', { bytes: formatBytes(droppedRxBytes) });
      error.value = rxOverflowErrorMessage;
    } else if (rxOverflowErrorMessage && error.value === rxOverflowErrorMessage) {
      // Buffer has recovered — clear a stale overflow message, but leave any
      // connection-level error untouched.
      error.value = null;
      rxOverflowErrorMessage = null;
    }

    if (!rafId) {
      rafId = requestAnimationFrame(flushQueue);
    }
  }

  function recordDrop(count: number) {
    if (count <= 0) return;
    droppedRxBytes += count;
    totalDroppedBytes.value += count;
    if (!overflowNotified) {
      // Notify once per connection so silent data loss is at least surfaced
      // once; the running total stays visible in the toolbar afterwards.
      overflowNotified = true;
      options?.onOverflow?.(totalDroppedBytes.value);
    }
  }

  function flushQueue() {
    if (dataQueue.length === 0) {
      rafId = null;
      return;
    }
    const chunks = dataQueue;
    const chunkBytes = totalQueueSize;
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    rafId = null;

    const frame = addFrame({
      direction: 'RX',
      data: concatUint8Arrays(chunks, chunkBytes),
    });
    if (frame) {
      appendFrame(sessionId, frame);
      // Notify observers (e.g. the trigger engine) of the completed RX frame.
      // Fired after the frame is stored so a trigger response re-enters the
      // same single-flight write serializer in the right order.
      options?.onRxFrame?.(frame);
    }
  }

  async function doSend(data: string, isHex: boolean): Promise<boolean> {
    if (!port.value) return false;

    let payload: Uint8Array;
    if (isHex) {
      try {
        payload = new Uint8Array(parseHex(data));
      } catch {
        return false;
      }
      if (payload.length === 0) {
        return false;
      }
    } else {
      if (data.length === 0) {
        return false;
      }
      payload = encodeUtf8(data);
    }

    if (payload.length > MAX_INPUT_SIZE) {
      return false;
    }

    try {
      // writeBinary accepts Uint8Array directly and converts internally, so no
      // need to box the payload into a regular array here (avoids a redundant copy).
      await port.value.writeBinary(payload);
    } catch (e) {
      logger.warn('serial write failed on', portName, e);
      return false;
    }

    const txFrame = addFrame({
      direction: 'TX',
      data: payload,
    });
    if (txFrame) appendFrame(sessionId, txFrame);
    return true;
  }

  async function send(data: string, isHex: boolean): Promise<boolean> {
    // Chain onto the in-flight write so sends never overlap. Each caller still
    // observes its own boolean result; only the ordering is serialized.
    const result = writeChain.then(() => doSend(data, isHex));
    writeChain = result.catch(() => true);
    return result;
  }

  /**
   * Send a pre-built binary payload (e.g. a Modbus RTU frame) through the same
   * serialized write path as {@link send}. This is the safe TX entry point for
   * protocol engines that must emit raw bytes without a hex/text round-trip and
   * must not overlap cyclic sends, triggers, or quick commands.
   */
  async function sendBytes(payload: Uint8Array): Promise<boolean> {
    if (payload.length === 0) return false;
    const result = writeChain.then(() => doSendBytes(payload));
    writeChain = result.catch(() => true);
    return result;
  }

  async function doSendBytes(payload: Uint8Array): Promise<boolean> {
    if (!port.value) return false;
    if (payload.length > MAX_INPUT_SIZE) return false;
    try {
      await port.value.writeBinary(payload);
    } catch (e) {
      logger.warn('serial writeBinary failed on', portName, e);
      return false;
    }
    const txFrame = addFrame({ direction: 'TX', data: payload });
    if (txFrame) appendFrame(sessionId, txFrame);
    return true;
  }

  /**
   * Subscribe to raw RX bytes (each chunk as delivered by the plugin, before
   * RAF coalescing). Returns an unlisten function. Protocol engines use this to
   * verify CRCs and correlate responses to their own requests; UI code should
   * use {@link SerialConnectionOptions.onRxFrame} for completed display frames.
   */
  function rawBytes(cb: (bytes: Uint8Array) => void): () => void {
    rawByteObservers.add(cb);
    return () => {
      rawByteObservers.delete(cb);
    };
  }

  /**
   * Pulse the serial BREAK line (line held to SPACE) for ~250ms. Required for
   * Arduino auto-reset into the bootloader and for forcing ESP32/ESP8266 into
   * download mode (often combined with DTR/RTS). Idempotent: a second call
   * while one is in flight is ignored. Non-fatal if the driver rejects it
   * (some USB-CDC adapters don't implement break).
   */
  let breakInFlight = false;
  async function sendBreak(durationMs = 250): Promise<boolean> {
    if (breakInFlight || !port.value) return false;
    breakInFlight = true;
    try {
      await port.value.setBreak();
      await new Promise((r) => setTimeout(r, durationMs));
      await port.value.clearBreak();
      return true;
    } catch (e) {
      logger.warn('serial setBreak/clearBreak failed on', portName, e);
      return false;
    } finally {
      breakInFlight = false;
    }
  }

  async function closePortSafely() {
    if (unlistenData) {
      try {
        unlistenData();
      } catch {
        // listener may already be gone after an unplanned disconnect
      }
      unlistenData = null;
    }
    if (port.value) {
      try {
        await port.value.stopListening();
        await port.value.close();
      } catch {
        // ignore — port may already be closed
      }
      port.value = null;
    }
  }

  async function stop() {
    intentionalClose = true;
    stopReconnect();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    error.value = null;
    // Drain any in-flight write before tearing the port down, so a final
    // queued TX (e.g. the last tick of a cyclic send) is not cut off mid-write.
    await writeChain.catch(() => undefined);
    await closePortSafely();
    if (unlistenDisconnect) {
      unlistenDisconnect();
      unlistenDisconnect = null;
    }
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
  }

  onUnmounted(() => {
    void stop();
  });

  return {
    port,
    isConnecting,
    isConnected,
    reconnecting,
    error,
    totalDroppedBytes,
    start,
    send,
    sendBytes,
    sendBreak,
    rawBytes,
    stop,
  };
}
