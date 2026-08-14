import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { PortConfig } from '../types';
import { loadJson, saveJson } from '../lib/storage';
import { DEFAULT_RX_FRAME_GAP_MS, normalizeRxFrameGapMs } from '../lib/serial-framing';

/** New workspace-era namespace. The 0.7.3 key remains read-only for G24. */
const STORAGE_KEY = 'bbcom-v1:serial-settings';
const DEFAULT_PORT_CONFIG: Readonly<PortConfig> = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: DEFAULT_RX_FRAME_GAP_MS,
  dtr: false,
  rts: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePersistedPortConfig(value: unknown): PortConfig {
  const raw = isRecord(value) ? value : {};
  return {
    baudRate:
      typeof raw.baudRate === 'number' && Number.isSafeInteger(raw.baudRate) && raw.baudRate > 0
        ? raw.baudRate
        : DEFAULT_PORT_CONFIG.baudRate,
    dataBits:
      raw.dataBits === 5 || raw.dataBits === 6 || raw.dataBits === 7 || raw.dataBits === 8
        ? raw.dataBits
        : DEFAULT_PORT_CONFIG.dataBits,
    stopBits:
      raw.stopBits === 1 || raw.stopBits === 2 ? raw.stopBits : DEFAULT_PORT_CONFIG.stopBits,
    parity:
      raw.parity === 'none' || raw.parity === 'odd' || raw.parity === 'even'
        ? raw.parity
        : DEFAULT_PORT_CONFIG.parity,
    flowControl:
      raw.flowControl === 'none' || raw.flowControl === 'software' || raw.flowControl === 'hardware'
        ? raw.flowControl
        : DEFAULT_PORT_CONFIG.flowControl,
    rxFrameGapMs: normalizeRxFrameGapMs(raw.rxFrameGapMs),
    dtr: typeof raw.dtr === 'boolean' ? raw.dtr : DEFAULT_PORT_CONFIG.dtr,
    rts: typeof raw.rts === 'boolean' ? raw.rts : DEFAULT_PORT_CONFIG.rts,
  };
}

export const useSerialStore = defineStore('serial', () => {
  const selectedPort = ref<string>('');
  const availablePorts = ref<string[]>([]);
  const portConfig = ref<PortConfig>({ ...DEFAULT_PORT_CONFIG });
  let loaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function load() {
    const saved = loadJson(STORAGE_KEY, {
      selectedPort: '',
      portConfig: portConfig.value,
    });
    if (typeof saved.selectedPort === 'string') selectedPort.value = saved.selectedPort;
    portConfig.value = normalizePersistedPortConfig(saved.portConfig);
    loaded = true;
  }

  function writeSettings(): boolean {
    return saveJson(STORAGE_KEY, {
      selectedPort: selectedPort.value,
      portConfig: portConfig.value,
    });
  }

  function save() {
    if (!loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeSettings();
    }, 300);
  }

  /** Cancel the debounce and synchronously persist the current serial snapshot. */
  function flushSettings(): boolean {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    return loaded && writeSettings();
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
    flushSettings,
  };
});
