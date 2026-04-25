import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { PortConfig } from '../types';

const STORAGE_KEY = 'bbcom-serial-settings';

export const useSerialStore = defineStore('serial', () => {
  const selectedPort = ref<string>('');
  const availablePorts = ref<string[]>([]);
  const portConfig = ref<PortConfig>({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  });
  let loaded = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.selectedPort) selectedPort.value = saved.selectedPort;
        if (saved.portConfig) portConfig.value = { ...portConfig.value, ...saved.portConfig };
      }
    } catch {
      // ignore
    }
    loaded = true;
  }

  function save() {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        selectedPort: selectedPort.value,
        portConfig: portConfig.value,
      }));
    } catch {
      // ignore
    }
  }

  watch([selectedPort, portConfig], save, { deep: true });

  function setSelectedPort(port: string) {
    selectedPort.value = port;
  }

  function setAvailablePorts(ports: string[]) {
    availablePorts.value = ports;
  }

  function setPortConfig(config: Partial<PortConfig>) {
    portConfig.value = { ...portConfig.value, ...config };
  }

  load();

  return {
    selectedPort,
    availablePorts,
    portConfig,
    setSelectedPort,
    setAvailablePorts,
    setPortConfig,
  };
});
