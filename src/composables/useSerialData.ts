import { ref, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { useSerialPort } from './useSerialPort';
import { useSessionStore } from '../stores/sessions';
import { encodeUtf8, parseHex } from '../lib/format';
import { MAX_INPUT_SIZE } from '../types';
import type { PortConfig } from '../types';

export function useSerialData(sessionId: string, portName: string, config: PortConfig) {
  const serial = useSerialPort();
  const sessionStore = useSessionStore();
  const isConnected = ref(false);

  let dataQueue: Uint8Array[] = [];
  let totalQueueSize = 0;
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

  function concatUint8Arrays(chunks: Uint8Array[]): number[] {
    if (chunks.length === 0) return [];
    if (chunks.length === 1) return Array.from(chunks[0]);

    const merged = new Uint8Array(totalQueueSize);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return Array.from(merged);
  }

  async function start() {
    const success = await serial.connect(portName, config);
    if (!success) return false;

    isConnected.value = true;
    sessionStore.setConnected(sessionId, true);

    unlistenData = await serial.listen((data) => {
      const bytes = data instanceof Uint8Array ? data : typeof data === 'string'
        ? encodeUtf8(data)
        : new Uint8Array(data as number[]);

      dataQueue.push(bytes);
      totalQueueSize += bytes.length;

      if (!rafId) {
        rafId = requestAnimationFrame(flushQueue);
      }
    });

    unlistenDisconnect = await listen(
      `plugin-serialplugin-disconnected-${portName}`,
      () => {
        isConnected.value = false;
        sessionStore.setConnected(sessionId, false);
      },
    );

    return true;
  }

  function flushQueue() {
    if (dataQueue.length === 0) {
      rafId = null;
      return;
    }
    const chunks = dataQueue;
    dataQueue = [];
    totalQueueSize = 0;
    rafId = null;

    sessionStore.addFrame(sessionId, {
      direction: 'RX',
      data: concatUint8Arrays(chunks),
    });
  }

  async function send(data: string, isHex: boolean) {
    if (!serial.port.value) return false;

    let payload: number[];
    if (isHex) {
      try {
        payload = parseHex(data);
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
      const encoded = encodeUtf8(data);
      payload = Array.from(encoded);
    }

    if (payload.length > MAX_INPUT_SIZE) {
      return false;
    }

    const ok = await serial.write(payload);
    if (ok) {
      sessionStore.addFrame(sessionId, {
        direction: 'TX',
        data: payload,
      });
    }
    return ok;
  }

  async function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    dataQueue = [];
    totalQueueSize = 0;
    if (unlistenData) {
      unlistenData();
      unlistenData = null;
    }
    if (unlistenDisconnect) {
      unlistenDisconnect();
      unlistenDisconnect = null;
    }
    await serial.disconnect();
    isConnected.value = false;
    sessionStore.setConnected(sessionId, false);
  }

  onUnmounted(() => {
    stop();
  });

  return {
    isConnecting: serial.isConnecting,
    error: serial.error,
    isConnected,
    start,
    send,
    stop,
  };
}
