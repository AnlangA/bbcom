import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { PortConfig } from '@/types';
import { settingsService } from '@/features/settings';

export const useSerialStore = defineStore('serial', () => {
  const boot = settingsService.hydrate();
  const selectedPort = ref<string>(boot.settings.selectedPort);
  const availablePorts = ref<string[]>([]);
  const portConfig = ref<PortConfig>({ ...boot.settings.portConfig });

  function save() {
    settingsService.update({
      selectedPort: selectedPort.value,
      portConfig: portConfig.value,
    });
  }

  /** Cancel the debounce and synchronously persist the current serial snapshot. */
  function flushSettings(): boolean {
    return settingsService.flush();
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

  return {
    selectedPort,
    availablePorts,
    portConfig,
    setSelectedPort,
    setAvailablePorts,
    setPortConfig,
    flushSettings,
  };
});
