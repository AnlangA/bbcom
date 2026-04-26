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
  height: 26px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-mono);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.stat-label {
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.stat-value {
  font-weight: 500;
}

.stat-value.port-name {
  color: var(--text-primary);
  font-weight: 600;
}

.stat-value.tx {
  color: var(--accent-green);
}

.stat-value.rx {
  color: var(--accent-blue);
}

.stat-value.rate {
  color: var(--accent-amber);
  font-size: 11px;
}

.stat-detail {
  color: var(--text-dim);
  font-size: 10px;
}

.divider {
  color: var(--border-color);
  margin: 0 1px;
  user-select: none;
}

.no-session {
  color: var(--text-dim);
  font-style: italic;
  font-family: var(--font-sans);
}

.status-indicator {
  margin-left: auto;
  position: sticky;
  right: 0;
  padding-left: var(--space-sm);
  background: var(--bg-tertiary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transition: background var(--transition-normal), box-shadow var(--transition-normal);
}

.status-dot.connected {
  background: var(--accent-green);
  box-shadow: 0 0 6px rgba(76, 175, 80, 0.6);
}

.status-dot.disconnected {
  background: var(--text-dim);
}
</style>
