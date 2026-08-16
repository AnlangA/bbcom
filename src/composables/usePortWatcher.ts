import { getCurrentInstance, ref, onMounted, onUnmounted } from 'vue';
import { enumerateTauriSerialPorts } from '../features/serial';
import { useSerialStore } from '../stores/serial';
import { isRealSerialPort, mergePortLists } from '../lib/serial-utils';
import { logger } from '../lib/logger';

/** Injectable port enumerator so the refresh logic is unit-testable without a
 *  Tauri serial runtime. Defaults to the real plugin. */
export interface UsePortWatcherOptions {
  /** Returns the raw available-ports map from the plugin. */
  enumerate?: () => Promise<Record<string, unknown>>;
}

export function usePortWatcher(interval = 1500, options: UsePortWatcherOptions = {}) {
  const ports = ref<string[]>([]);
  const serialStore = useSerialStore();
  let timer: ReturnType<typeof setInterval> | null = null;
  const enumerate = options.enumerate ?? enumerateTauriSerialPorts;

  async function refresh() {
    try {
      const available = await enumerate();
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

  if (getCurrentInstance()) {
    onMounted(() => {
      void refresh();
      timer = setInterval(refresh, interval);
    });

    onUnmounted(() => {
      if (timer) clearInterval(timer);
    });
  }

  return {
    ports,
    refresh,
  };
}
