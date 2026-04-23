import { ref, onMounted, onUnmounted } from 'vue';
import { SerialPort } from 'tauri-plugin-serialplugin-api';
import { useSerialStore } from '../stores/serial';

// macOS 上常见的非串口设备关键词，用于过滤蓝牙等无关端口
const BLOCKED_KEYWORDS = ['Bluetooth', 'Bluetooth-Incoming-Port', 'AirPods', 'Watch'];

function isRealSerialPort(path: string): boolean {
  return !BLOCKED_KEYWORDS.some((kw) => path.includes(kw));
}

export function usePortWatcher(interval = 1500) {
  const ports = ref<string[]>([]);
  const serialStore = useSerialStore();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const available = await SerialPort.available_ports();
      const detectedPaths = Object.keys(available).filter(isRealSerialPort);

      // 增量更新：保留已有顺序，新发现的追加到末尾，消失的移除
      const existingSet = new Set(ports.value);
      const detectedSet = new Set(detectedPaths);

      const newPorts: string[] = [];
      // 保留仍然存在且未被过滤的旧端口，维持原始顺序
      for (const p of ports.value) {
        if (detectedSet.has(p)) {
          newPorts.push(p);
        }
      }
      // 追加新发现的端口
      for (const p of detectedPaths) {
        if (!existingSet.has(p)) {
          newPorts.push(p);
        }
      }

      ports.value = newPorts;
      serialStore.setAvailablePorts(newPorts);
    } catch {
      // ignore
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
