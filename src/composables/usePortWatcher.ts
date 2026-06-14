import { ref, onMounted, onUnmounted } from 'vue';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import { useSerialStore } from '../stores/serial';
import { isRealSerialPort, mergePortLists } from '../lib/serial-utils';
import { logger } from '../lib/logger';

export function usePortWatcher(interval = 1500) {
  const ports = ref<string[]>([]);
  const serialStore = useSerialStore();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const available = await SerialPort.available_ports();
      const detectedPaths = Object.keys(available).filter(isRealSerialPort);

      const newPorts = mergePortLists(ports.value, detectedPaths);

      if (
        newPorts.length === ports.value.length &&
        newPorts.every((p, i) => p === ports.value[i])
      ) {
        return;
      }

      ports.value = newPorts;
      serialStore.setAvailablePorts(newPorts);
    } catch (e) {
      // Ignore transient serial enumeration failures; the next poll will retry.
      // Log at debug (dev-only) so a persistent failure (e.g. permissions) is diagnosable.
      logger.debug('serial port enumeration failed:', e);
    }
  }

  onMounted(() => {
    refresh();
    timer = setInterval(refresh, interval);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return {
    ports,
    refresh,
  };
}
