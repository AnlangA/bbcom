import { ref, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import {
  SerialPort,
  DataBits as PluginDataBits,
  StopBits as PluginStopBits,
  Parity as PluginParity,
  FlowControl as PluginFlowControl,
} from 'tauri-plugin-serialplugin-api';
import { useSessionStore } from '../stores/sessions';
import { useSessionFrames } from './useSessionFrames';
import { encodeUtf8, parseHex } from '../lib/format';
import { MAX_INPUT_SIZE } from '../types';
import type { PortConfig } from '../types';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;
const RECONNECT_INTERVAL_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;

function mapDataBits(n: number): PluginDataBits {
  switch (n) {
    case 5:
      return PluginDataBits.Five;
    case 6:
      return PluginDataBits.Six;
    case 7:
      return PluginDataBits.Seven;
    case 8:
    default:
      return PluginDataBits.Eight;
  }
}

function mapStopBits(n: number): PluginStopBits {
  switch (n) {
    case 2:
      return PluginStopBits.Two;
    case 1:
    default:
      return PluginStopBits.One;
  }
}

function mapParity(p: string): PluginParity {
  switch (p) {
    case 'odd':
      return PluginParity.Odd;
    case 'even':
      return PluginParity.Even;
    case 'none':
    default:
      return PluginParity.None;
  }
}

function mapFlowControl(f: string): PluginFlowControl {
  switch (f) {
    case 'software':
      return PluginFlowControl.Software;
    case 'hardware':
      return PluginFlowControl.Hardware;
    case 'none':
    default:
      return PluginFlowControl.None;
  }
}

interface SerialConnectionOptions {
  onDisconnect?: () => void;
  /** Fired once per connection when RX data is first dropped due to overflow. */
  onOverflow?: (totalDroppedBytes: number) => void;
  /** Polled at disconnect time so the toggle can change live. */
  autoReconnect?: () => boolean;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export function useSerialConnection(
  sessionId: string,
  portName: string,
  config: PortConfig,
  options?: SerialConnectionOptions,
) {
  const sessionStore = useSessionStore();
  const { addFrame } = useSessionFrames(sessionId);
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
  let overflowNotified = false;
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

  // Reconnect state
  let intentionalClose = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;

  function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const merged = new Uint8Array(totalQueueSize);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

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
    await p.startListening();
    port.value = p;
    // Apply DTR/RTS handshake levels — needed for Arduino auto-reset, ESP32
    // boot-mode entry, modems, etc. Some drivers reject these writes; ignore
    // so the connection itself still succeeds.
    try {
      await p.setDataTerminalReady(config.dtr);
      await p.setRequestToSend(config.rts);
    } catch {
      // control-signal write unsupported on this driver — non-fatal
    }

    // Data listener is per-port-object, so (re)register it on every open.
    if (unlistenData) {
      unlistenData();
    }
    unlistenData = await p.listen((data: string | number[] | Uint8Array) => {
      const bytes =
        data instanceof Uint8Array
          ? data
          : typeof data === 'string'
            ? encodeUtf8(data)
            : new Uint8Array(data as number[]);
      enqueueReceivedBytes(bytes);
    }, false);
  }

  async function start() {
    isConnecting.value = true;
    error.value = null;
    totalDroppedBytes.value = 0;
    overflowNotified = false;
    intentionalClose = false;
    reconnecting.value = false;
    try {
      await openConnection();
    } catch (e) {
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
      `plugin-serialplugin-disconnected-${portName}`,
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
    while (
      dataQueue.length > 0 &&
      (totalQueueSize + bytes.length > MAX_RX_QUEUE_BYTES || dataQueue.length >= MAX_RX_QUEUE_CHUNKS)
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
      error.value = `接收缓冲区溢出，已丢弃 ${droppedRxBytes} 字节`;
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
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    rafId = null;

    addFrame({
      direction: 'RX',
      data: concatUint8Arrays(chunks),
    });
  }

  async function send(data: string, isHex: boolean) {
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
      await port.value.writeBinary(Array.from(payload));
    } catch {
      return false;
    }

    addFrame({
      direction: 'TX',
      data: payload,
    });
    return true;
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
    stop,
  };
}
