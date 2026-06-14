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

  let dataQueue: Uint8Array[] = [];
  let totalQueueSize = 0;
  let droppedRxBytes = 0;
  let overflowNotified = false;
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

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

  async function start() {
    isConnecting.value = true;
    error.value = null;
    totalDroppedBytes.value = 0;
    overflowNotified = false;
    try {
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
    } catch (e) {
      error.value = String(e);
      return false;
    } finally {
      isConnecting.value = false;
    }

    isConnected.value = true;
    sessionStore.setConnected(sessionId, true);

    unlistenData = await port.value.listen((data: string | number[] | Uint8Array) => {
      const bytes =
        data instanceof Uint8Array
          ? data
          : typeof data === 'string'
            ? encodeUtf8(data)
            : new Uint8Array(data as number[]);

      enqueueReceivedBytes(bytes);
    }, false);

    unlistenDisconnect = await listen(
      `plugin-serialplugin-disconnected-${portName}`,
      () => {
        isConnected.value = false;
        sessionStore.setConnected(sessionId, false);
        options?.onDisconnect?.();
      },
    );

    return true;
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

  async function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    if (unlistenData) {
      unlistenData();
      unlistenData = null;
    }
    if (unlistenDisconnect) {
      unlistenDisconnect();
      unlistenDisconnect = null;
    }
    if (port.value) {
      try {
        await port.value.stopListening();
        await port.value.close();
      } catch {
        // ignore
      }
      port.value = null;
    }
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
  }

  onUnmounted(() => {
    stop();
  });

  return {
    port,
    isConnecting,
    isConnected,
    error,
    totalDroppedBytes,
    start,
    send,
    stop,
  };
}
