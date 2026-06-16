<template>
  <div class="status-bar">
    <template v-if="session">
      <div class="stat">
        <Usb class="icon-sm stat-icon" />
        <span class="stat-label">{{ t('status.port') }}</span>
        <span class="stat-value port-name">{{ session.portName }}</span>
      </div>
      <span class="divider">|</span>
      <div class="traffic-stats" :aria-label="t('session.stats.aria')">
        <span class="mini-stat tx" :title="`TX ${session.txFrames} ${t('status.frames')}`">
          <span class="mini-label">TX</span>
          {{ formatBytes(session.txBytes) }}
        </span>
        <span class="mini-stat rx" :title="`RX ${session.rxFrames} ${t('status.frames')}`">
          <span class="mini-label">RX</span>
          {{ formatBytes(session.rxBytes) }}
        </span>
        <span
          class="mini-stat"
          :title="t('session.stats.totalFrames', { count: session.frames.length })"
        >
          <span class="mini-label">{{ t('session.stats.frames') }}</span>
          {{ session.frames.length }}
        </span>
      </div>
      <span v-if="session.isConnected && dataRate" class="divider">|</span>
      <div v-if="session.isConnected && dataRate" class="stat">
        <span class="stat-label">{{ t('status.rate') }}</span>
        <span class="stat-value rate">{{ dataRate }}</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">{{ t('status.duration') }}</span>
        <span class="stat-value">{{ duration }}</span>
      </div>
      <span class="divider">|</span>
      <div class="stat">
        <span class="stat-label">{{ t('status.baud') }}</span>
        <span class="stat-value">{{ session.portConfig.baudRate }}</span>
      </div>
      <div class="stat status-indicator">
        <span class="status-dot" :class="session.isConnected ? 'connected' : 'disconnected'"></span>
      </div>
    </template>
    <span v-else class="no-session">{{ t('session.noActiveSession') }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { Usb } from 'lucide-vue-next';
import type { SerialSession } from '../../types';
import { formatBytes, formatDuration, formatRate } from '../../lib/format';
import { t } from '../../lib/i18n';

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

watch(
  () => props.session?.isConnected,
  (connected) => {
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
            // Counters reset to 0 on clearFrames; a negative delta means a reset
            // happened since the last sample, so measure from zero instead of
            // producing a (hidden, negative) bogus rate.
            let txDelta = props.session.txBytes - prevTxBytes;
            let rxDelta = props.session.rxBytes - prevRxBytes;
            if (txDelta < 0) txDelta = props.session.txBytes;
            if (rxDelta < 0) rxDelta = props.session.rxBytes;
            txRate.value = Math.round(txDelta / elapsed);
            rxRate.value = Math.round(rxDelta / elapsed);
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
  },
  { immediate: true },
);

watch(
  () => props.session?.id,
  () => {
    now.value = Date.now();
    prevTxBytes = props.session?.txBytes ?? 0;
    prevRxBytes = props.session?.rxBytes ?? 0;
    lastSampleTime = Date.now();
    txRate.value = 0;
    rxRate.value = 0;
  },
);

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

const duration = computed(() => {
  if (!props.session?.startTime) return '--:--:--';
  return formatDuration(now.value - props.session.startTime);
});
</script>

<style scoped>
.status-bar {
  height: var(--statusbar-height);
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.stat {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  min-height: 20px;
  padding: 0 2px;
}

.stat-icon {
  color: var(--text-dim);
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

.stat-value.rate {
  color: var(--accent-amber);
  font-size: 11px;
}

.traffic-stats {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.mini-stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 7px;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mini-stat.tx {
  color: var(--accent-green);
  background: var(--accent-green-subtle);
}

.mini-stat.rx {
  color: var(--accent-blue);
  background: var(--accent-blue-subtle);
}

.mini-label {
  color: var(--text-dim);
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 700;
}

.divider {
  width: 1px;
  height: 14px;
  overflow: hidden;
  color: transparent;
  background: var(--border-subtle);
  margin: 0 2px;
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
  background: var(--bg-secondary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transition:
    background var(--transition-normal),
    box-shadow var(--transition-normal);
}

.status-dot.connected {
  background: var(--color-success);
  box-shadow: 0 0 0 3px var(--color-primary-subtle);
}

.status-dot.disconnected {
  background: var(--text-dim);
  box-shadow: 0 0 0 3px var(--ring-muted);
}
</style>
