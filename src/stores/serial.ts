import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { PortConfig } from '../types';
import { loadJson, saveJson } from '../lib/storage';

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
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function load() {
    const saved = loadJson(STORAGE_KEY, {
      selectedPort: '',
      portConfig: portConfig.value,
    });
    if (saved.selectedPort) selectedPort.value = saved.selectedPort;
    if (saved.portConfig) portConfig.value = { ...portConfig.value, ...saved.portConfig };
    loaded = true;
  }

  function save() {
    if (!loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveJson(STORAGE_KEY, {
        selectedPort: selectedPort.value,
        portConfig: portConfig.value,
      });
    }, 300);
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
