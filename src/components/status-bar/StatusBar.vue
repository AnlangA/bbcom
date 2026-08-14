<template>
  <div class="status-bar">
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ connectionAnnouncement }}
    </span>
    <template v-if="session">
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
      <div class="status-group">
        <div v-if="session.isConnected && dataRate" class="stat">
          <span class="stat-label">{{ t('status.rate') }}</span>
          <span class="stat-value rate">{{ dataRate }}</span>
        </div>
        <div
          v-if="session.isConnected && frameRate > 0"
          class="stat"
          :title="t('status.frameRate')"
        >
          <span class="stat-label">{{ t('status.frameRate') }}</span>
          <span class="stat-value">{{ frameRate }}/s</span>
        </div>
        <div v-if="bufferLevel" class="stat" :title="t('status.bufferLevel')">
          <span class="stat-label">{{ t('status.bufferLevel') }}</span>
          <span class="stat-value">{{ bufferLevel }}</span>
        </div>
        <div v-if="droppedDisplay" class="stat" :title="t('status.dropped')">
          <span class="stat-label">{{ t('status.dropped') }}</span>
          <span class="stat-value dropped">{{ droppedDisplay }}</span>
        </div>
      </div>
      <div class="status-group">
        <div class="stat">
          <span class="stat-label">{{ t('status.duration') }}</span>
          <span class="stat-value">{{ duration }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">{{ t('status.baud') }}</span>
          <span class="stat-value">{{ session.portConfig.baudRate }}</span>
        </div>
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
import type { SerialSession } from '../../types';
import { formatBytes, formatDuration, formatRate } from '../../lib/format';
import { t } from '../../lib/i18n';

const props = defineProps<{
  session: SerialSession | null;
  /** Invalidates template reads from the session's raw frame arrays/counters. */
  framesVersion: number;
}>();

import { maxBufferFrames } from '../../lib/buffer-config';

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
let prevTxBytes = 0;
let prevRxBytes = 0;
let prevFrames = 0;
let lastSampleTime = 0;
const txRate = ref(0);
const rxRate = ref(0);
const frameRate = ref(0);

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
      prevFrames = props.session?.frames.length ?? 0;
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
          // Frames-per-second: sample the live frame count delta.
          let frameDelta = props.session.frames.length - prevFrames;
          if (frameDelta < 0) frameDelta = props.session.frames.length;
          frameRate.value = Math.round(frameDelta / elapsed);
          prevTxBytes = props.session.txBytes;
          prevRxBytes = props.session.rxBytes;
          prevFrames = props.session.frames.length;
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
    prevFrames = props.session?.frames.length ?? 0;
    lastSampleTime = Date.now();
    txRate.value = 0;
    rxRate.value = 0;
    frameRate.value = 0;
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

/** Buffer level: how full the rolling frame buffer is. */
const bufferLevel = computed(() => {
  if (!props.session) return '';
  const pct = Math.round((props.session.frames.length / maxBufferFrames.value) * 100);
  return `${props.session.frames.length}/${maxBufferFrames.value} ${pct}%`;
});

/** Cumulative dropped bytes this connection. */
const droppedDisplay = computed(() => {
  if (!props.session || props.session.droppedBytes === 0) return '';
  return formatBytes(props.session.droppedBytes);
});

const connectionAnnouncement = computed(() => {
  if (!props.session) return t('session.noActiveSession');
  return props.session.isConnected ? t('session.connected') : t('session.disconnected');
});
</script>

<style scoped>
.status-bar {
  height: var(--statusbar-height);
  padding: 0 var(--space-md);
  display: flex;
  align-items: center;
  /* Groups separate by whitespace alone: wider between groups, tighter
     inside a group — no literal divider glyphs to scan past. */
  gap: var(--space-lg);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.status-group {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.stat {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  white-space: nowrap;
  min-height: 20px;
  padding: 0 var(--space-2xs);
}

.stat-label {
  color: var(--text-dim);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.stat-value {
  font-weight: var(--font-weight-medium);
}

.stat-value.rate {
  color: var(--accent-amber);
}

.stat-value.dropped {
  color: var(--accent-amber);
  font-weight: var(--font-weight-semibold);
}

.traffic-stats {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
  padding: var(--space-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.mini-stat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
  padding: var(--space-2xs) var(--space-sm);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
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
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
}

.no-session {
  color: var(--text-secondary);
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
