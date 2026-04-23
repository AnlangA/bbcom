import { ref, onUnmounted } from 'vue';
import {
  SerialPort,
  DataBits as PluginDataBits,
  StopBits as PluginStopBits,
  Parity as PluginParity,
  FlowControl as PluginFlowControl,
} from 'tauri-plugin-serialplugin-api';
import type { PortConfig } from '../types';

function mapDataBits(n: number): PluginDataBits {
  switch (n) {
    case 5:
      return PluginDataBits.Five;
    case 6:
      return PluginDataBits.Six;
    case 7:
      return PluginDataBits.Seven;
    case 8:
    default:
      return PluginDataBits.Eight;
  }
}

function mapStopBits(n: number): PluginStopBits {
  switch (n) {
    case 2:
      return PluginStopBits.Two;
    case 1:
    default:
      return PluginStopBits.One;
  }
}

function mapParity(p: string): PluginParity {
  switch (p) {
    case 'odd':
      return PluginParity.Odd;
    case 'even':
      return PluginParity.Even;
    case 'none':
    default:
      return PluginParity.None;
  }
}

function mapFlowControl(f: string): PluginFlowControl {
  switch (f) {
    case 'software':
      return PluginFlowControl.Software;
    case 'hardware':
      return PluginFlowControl.Hardware;
    case 'none':
    default:
      return PluginFlowControl.None;
  }
}

export function useSerialPort() {
  const port = ref<SerialPort | null>(null);
  const isConnecting = ref(false);
  const error = ref<string | null>(null);

  async function connect(portName: string, config: PortConfig) {
    isConnecting.value = true;
    error.value = null;
    try {
      const p = new SerialPort({
        path: portName,
        baudRate: config.baudRate,
        dataBits: mapDataBits(config.dataBits),
        stopBits: mapStopBits(config.stopBits),
        parity: mapParity(config.parity),
        flowControl: mapFlowControl(config.flowControl),
      });
      await p.open();
      // 必须调用 startListening 才能让后端开始读取串口数据并发射事件
      await p.startListening();
      port.value = p;
      return true;
    } catch (e) {
      error.value = String(e);
      return false;
    } finally {
      isConnecting.value = false;
    }
  }

  async function disconnect() {
    if (!port.value) return;
    try {
      await port.value.stopListening();
      await port.value.close();
    } catch (e) {
      // ignore
    }
    port.value = null;
  }

  async function write(data: string | number[]) {
    if (!port.value) return false;
    try {
      if (Array.isArray(data)) {
        await port.value.writeBinary(data);
      } else {
        await port.value.write(data);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function listen(callback: (data: string | number[]) => void) {
    if (!port.value) return null;
    // 使用 isDecode=false 获取原始字节数据，保证数据完整性
    return await port.value.listen(callback, false);
  }

  onUnmounted(() => {
    if (port.value) {
      port.value.stopListening().catch(() => {});
      port.value.close().catch(() => {});
      port.value = null;
    }
  });

  return {
    port,
    isConnecting,
    error,
    connect,
    disconnect,
    write,
    listen,
  };
}
