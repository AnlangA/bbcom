import { ref, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { useSerialPort } from './useSerialPort';
import { useSessionStore } from '../stores/sessions';
import type { PortConfig } from '../types';

export function useSerialData(sessionId: string, portName: string, config: PortConfig) {
  const serial = useSerialPort();
  const sessionStore = useSessionStore();
  const isConnected = ref(false);

  let dataQueue: Uint8Array[] = [];
  let rafId: number | null = null;
  let unlistenData: (() => void) | null = null;
  let unlistenDisconnect: (() => void) | null = null;

  function concatUint8Arrays(chunks: Uint8Array[]): number[] {
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(totalLen);
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
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as number[]);

      dataQueue.push(bytes);

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
      const cleaned = data.replace(/[^0-9a-fA-F]/g, '');
      if (cleaned.length % 2 !== 0) return false;
      payload = [];
      for (let i = 0; i < cleaned.length; i += 2) {
        payload.push(parseInt(cleaned.substring(i, i + 2), 16));
      }
    } else {
      const encoded = new TextEncoder().encode(data);
      payload = Array.from(encoded);
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
