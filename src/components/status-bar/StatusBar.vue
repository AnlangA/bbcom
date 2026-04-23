<template>
  <div class="status-bar">
    <template v-if="session">
      <div class="stat">
        <span class="stat-label">端口</span>
        <span class="stat-value port-name">{{ session.portName }}</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">TX</span>
        <span class="stat-value tx">{{ formatBytes(session.txBytes) }}</span>
        <span class="stat-detail">{{ session.txFrames }} 帧</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">RX</span>
        <span class="stat-value rx">{{ formatBytes(session.rxBytes) }}</span>
        <span class="stat-detail">{{ session.rxFrames }} 帧</span>
      </div>
      <span v-if="session.isConnected && dataRate" class="divider">|</span>
      <div v-if="session.isConnected && dataRate" class="stat">
        <span class="stat-label">速率</span>
        <span class="stat-value rate">{{ dataRate }}</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">时长</span>
        <span class="stat-value">{{ duration }}</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">波特率</span>
        <span class="stat-value">{{ session.portConfig.baudRate }}</span>
      </div>
      <div class="stat status-indicator">
        <span class="status-dot" :class="session.isConnected ? 'connected' : 'disconnected'"></span>
      </div>
    </template>
    <span v-else class="no-session">无活动会话</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { SerialSession } from '../../types';

const props = defineProps<{
  session: SerialSession | null;
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
let prevTxBytes = 0;
let prevRxBytes = 0;
let lastSampleTime = 0;
const txRate = ref(0);
const rxRate = ref(0);

watch(() => props.session?.isConnected, (connected) => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (connected) {
    prevTxBytes = props.session?.txBytes ?? 0;
    prevRxBytes = props.session?.rxBytes ?? 0;
    lastSampleTime = Date.now();
    timer = setInterval(() => {
      now.value = Date.now();
      if (props.session) {
        const elapsed = (now.value - lastSampleTime) / 1000;
        if (elapsed > 0) {
          txRate.value = Math.round((props.session.txBytes - prevTxBytes) / elapsed);
          rxRate.value = Math.round((props.session.rxBytes - prevRxBytes) / elapsed);
        }
        prevTxBytes = props.session.txBytes;
        prevRxBytes = props.session.rxBytes;
        lastSampleTime = now.value;
      }
    }, 1000);
  } else {
    txRate.value = 0;
    rxRate.value = 0;
  }
}, { immediate: true });

watch(() => props.session?.id, () => {
  now.value = Date.now();
  prevTxBytes = props.session?.txBytes ?? 0;
  prevRxBytes = props.session?.rxBytes ?? 0;
  lastSampleTime = Date.now();
  txRate.value = 0;
  rxRate.value = 0;
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

const dataRate = computed(() => {
  if (txRate.value === 0 && rxRate.value === 0) return '';
  const parts: string[] = [];
  if (txRate.value > 0) parts.push(`TX ${formatRate(txRate.value)}`);
  if (rxRate.value > 0) parts.push(`RX ${formatRate(rxRate.value)}`);
  return parts.join(' ') || '';
});

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

const duration = computed(() => {
  if (!props.session?.startTime) return '--:--:--';
  const ms = now.value - props.session.startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h.toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped>
.status-bar {
  height: 28px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: #252526;
  color: #cccccc;
  font-size: 12px;
  font-family: 'Menlo', 'Consolas', monospace;
  border-top: 1px solid #3c3c3c;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stat-label {
  color: #888;
  font-size: 11px;
}

.stat-value {
  font-weight: 500;
}

.stat-value.port-name {
  color: #e0e0e0;
}

.stat-value.tx {
  color: #4caf50;
}

.stat-value.rx {
  color: #42a5f5;
}

.stat-value.rate {
  color: #e0e0e0;
  font-size: 11px;
}

.stat-detail {
  color: #666;
  font-size: 11px;
}

.divider {
  color: #444;
  margin: 0 2px;
}

.no-session {
  color: #666;
  font-style: italic;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background 0.3s;
}

.status-dot.connected {
  background: #4caf50;
  box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
}

.status-dot.disconnected {
  background: #555;
}
</style>
