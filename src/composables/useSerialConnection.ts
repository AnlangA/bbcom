import { ref, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import { useSessionStore } from '../stores/sessions';
import { useSessionFrames } from './useSessionFrames';
import { useAutoLog } from './useAutoLog';
import { encodeUtf8, parseHex } from '../lib/format';
import { concatUint8Arrays } from '../lib/bytes';
import { escapeSerialPath } from '../lib/serial-utils';
import { mapDataBits, mapFlowControl, mapParity, mapStopBits } from '../lib/serial-config';
import { logger } from '../lib/logger';
import { MAX_INPUT_SIZE } from '../types';
import type { PortConfig } from '../types';

const MAX_RX_QUEUE_BYTES = MAX_INPUT_SIZE * 2;
const MAX_RX_QUEUE_CHUNKS = 512;
// Prefix used to recognize (and clear) the transient RX-overflow error so it
// does not persist in the SessionView error pill after the buffer recovers.
const RX_OVERFLOW_PREFIX = '接收缓冲区溢出';

interface SerialConnectionOptions {
  onDisconnect?: () => void;
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

  let dataQueue: Uint8Array[] = [];
  let totalQueueSize = 0;
  let droppedRxBytes = 0;
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

  async function start() {
    isConnecting.value = true;
    error.value = null;
    // Tear down any leftover state from a previous connection (e.g. reconnect
    // after an unexpected disconnect) so the old port's Tauri event listeners
    // don't leak when we overwrite the references below, and stale unflushed
    // RX data doesn't bleed into the new connection's first frame.
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
      const previous = port.value;
      port.value = null;
      try {
        await previous.stopListening();
        await previous.close();
      } catch (e) {
        logger.debug('serial previous-port cleanup failed for', portName, e);
      }
    }
    let p: SerialPort | null = null;
    try {
      p = new SerialPort({
        path: portName,
        baudRate: config.baudRate,
        dataBits: mapDataBits(config.dataBits),
        stopBits: mapStopBits(config.stopBits),
        parity: mapParity(config.parity),
        flowControl: mapFlowControl(config.flowControl),
      });
      await p.open();
      // Register the data callback BEFORE starting the read pump. Tauri
      // discards events that have no listener, so bytes arriving the instant
      // listening begins (e.g. a device that sends on connect) would otherwise
      // be dropped during the gap between startListening and listen.
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
      port.value = p;
    } catch (e) {
      // Roll back any partial registration so a failed connect leaves no leaks.
      if (unlistenData) {
        unlistenData();
        unlistenData = null;
      }
      if (p) {
        try {
          await p.close();
        } catch (closeErr) {
          logger.debug('serial cleanup close failed for', portName, closeErr);
        }
      }
      logger.warn('serial open failed for', portName, e);
      error.value = String(e);
      return false;
    } finally {
      isConnecting.value = false;
    }

    isConnected.value = true;
    sessionStore.setConnected(sessionId, true);

    unlistenDisconnect = await listen(
      `plugin-serialplugin-disconnected-${escapeSerialPath(portName)}`,
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
      (totalQueueSize + bytes.length > MAX_RX_QUEUE_BYTES ||
        dataQueue.length >= MAX_RX_QUEUE_CHUNKS)
    ) {
      const dropped = dataQueue.shift();
      if (!dropped) break;
      totalQueueSize -= dropped.length;
      droppedRxBytes += dropped.length;
    }

    if (bytes.length > MAX_RX_QUEUE_BYTES) {
      const retained = bytes.slice(bytes.length - MAX_RX_QUEUE_BYTES);
      droppedRxBytes += bytes.length - retained.length;
      dataQueue.push(retained);
      totalQueueSize += retained.length;
    } else {
      dataQueue.push(bytes);
      totalQueueSize += bytes.length;
    }

    if (droppedRxBytes > 0) {
      error.value = `${RX_OVERFLOW_PREFIX}，已丢弃 ${droppedRxBytes} 字节`;
    } else if (error.value?.startsWith(RX_OVERFLOW_PREFIX)) {
      // Buffer has recovered — clear a stale overflow message, but leave any
      // connection-level error (which uses a different prefix) untouched.
      error.value = null;
    }

    if (!rafId) {
      rafId = requestAnimationFrame(flushQueue);
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

    const frame = addFrame({
      direction: 'RX',
      data: concatUint8Arrays(chunks),
    });
    if (frame) appendFrame(sessionId, frame);
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

  async function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dataQueue = [];
    totalQueueSize = 0;
    droppedRxBytes = 0;
    // Clear any transient error (e.g. buffer-overflow) so a stale message does
    // not linger in the SessionView error pill after disconnect.
    error.value = null;
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
      } catch (e) {
        // Closing an already-closed/disconnected port is expected; log at debug.
        logger.debug('serial close ignored error for', portName, e);
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
    start,
    send,
    stop,
  };
}
