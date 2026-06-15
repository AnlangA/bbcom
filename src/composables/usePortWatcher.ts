import { ref, onMounted, onUnmounted } from "vue";
import { SerialPort } from "tauri-plugin-serialplugin-api";
import { useSerialStore } from "../stores/serial";

const BLOCKED_KEYWORDS = [
  "Bluetooth",
  "Bluetooth-Incoming-Port",
  "AirPods",
  "Watch",
];

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

      const existingSet = new Set(ports.value);
      const detectedSet = new Set(detectedPaths);

      const newPorts: string[] = [];
      for (const p of ports.value) {
        if (detectedSet.has(p)) {
          newPorts.push(p);
        }
      }
      for (const p of detectedPaths) {
        if (!existingSet.has(p)) {
          newPorts.push(p);
        }
      }

      if (
        newPorts.length === ports.value.length &&
        newPorts.every((p, i) => p === ports.value[i])
      ) {
        return;
      }

      ports.value = newPorts;
      serialStore.setAvailablePorts(newPorts);
    } catch {
      // Ignore transient serial enumeration failures; the next poll will retry.
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
