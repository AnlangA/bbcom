import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PortConfig } from '../types';

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
  };
});
