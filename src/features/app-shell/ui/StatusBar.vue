<template>
  <div class="status-bar">
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ connectionAnnouncement }}
    </span>
    <template v-if="session">
      <div class="traffic-stats" :aria-label="t('session.stats.aria')">
        <span class="mini-stat tx" :title="`TX ${trafficStats.txFrames} ${t('status.frames')}`">
          <span class="mini-label">TX</span>
          {{ formatBytes(trafficStats.txBytes) }}
        </span>
        <span class="mini-stat rx" :title="`RX ${trafficStats.rxFrames} ${t('status.frames')}`">
          <span class="mini-label">RX</span>
          {{ formatBytes(trafficStats.rxBytes) }}
        </span>
      </div>
      <div class="status-group">
        <div v-if="connected && dataRate" class="stat">
          <span class="stat-label">{{ t('status.rate') }}</span>
          <span class="stat-value rate">{{ dataRate }}</span>
        </div>
        <div v-if="connected && frameRate > 0" class="stat" :title="t('status.frameRate')">
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
      <div class="status-spacer"></div>
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
    </template>
    <span v-else class="no-session">{{ t('session.noActiveSession') }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import type { SerialSession } from '@/types';
import { formatBytes, formatDuration, formatRate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useSessionRuntimeStatuses, type SessionRawDataView } from '@/features/sessions';

const props = defineProps<{
  session: SerialSession | null;
  /** Shared receive/transmit-layer data used by the presentation. */
  rawData?: SessionRawDataView | null;
  /** @deprecated Compatibility invalidation for isolated component callers. */
  framesVersion?: number;
}>();
const { isConnected } = useSessionRuntimeStatuses();
const connected = computed(() => Boolean(props.session && isConnected(props.session.id)));

const trafficStats = computed(() => {
  void props.framesVersion;
  const session = props.session;
  const rawData = rawDataForSession();
  return {
    txBytes: rawData?.txBytes.value ?? session?.txBytes ?? 0,
    rxBytes: rawData?.rxBytes.value ?? session?.rxBytes ?? 0,
    txFrames: rawData?.txFrames.value ?? session?.txFrames ?? 0,
    rxFrames: rawData?.rxFrames.value ?? session?.rxFrames ?? 0,
  };
});

function rawDataForSession(): SessionRawDataView | null {
  return props.rawData && props.rawData.sessionId === props.session?.id ? props.rawData : null;
}

function currentTrafficSample(): { txBytes: number; rxBytes: number; frames: number } {
  const rawData = rawDataForSession();
  return {
    txBytes: rawData?.txBytes.value ?? props.session?.txBytes ?? 0,
    rxBytes: rawData?.rxBytes.value ?? props.session?.rxBytes ?? 0,
    frames: rawData?.frames.value.length ?? props.session?.frames.length ?? 0,
  };
}

import { maxBufferFrames } from '@/lib/buffer-config';

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
  connected,
  (connected) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (connected) {
      const initial = currentTrafficSample();
      prevTxBytes = initial.txBytes;
      prevRxBytes = initial.rxBytes;
      prevFrames = initial.frames;
      lastSampleTime = Date.now();
      timer = setInterval(() => {
        now.value = Date.now();
        if (props.session) {
          const sample = currentTrafficSample();
          const elapsed = (now.value - lastSampleTime) / 1000;
          if (elapsed > 0) {
            // Counters reset to 0 on clearFrames; a negative delta means a reset
            // happened since the last sample, so measure from zero instead of
            // producing a (hidden, negative) bogus rate.
            let txDelta = sample.txBytes - prevTxBytes;
            let rxDelta = sample.rxBytes - prevRxBytes;
            if (txDelta < 0) txDelta = sample.txBytes;
            if (rxDelta < 0) rxDelta = sample.rxBytes;
            txRate.value = Math.round(txDelta / elapsed);
            rxRate.value = Math.round(rxDelta / elapsed);
          }
          // Frames-per-second: sample the live frame count delta. Guard the
          // divisor the same way as the byte rates — a zero-ms interval tick
          // would otherwise render "Infinity/s".
          if (elapsed > 0) {
            let frameDelta = sample.frames - prevFrames;
            if (frameDelta < 0) frameDelta = sample.frames;
            frameRate.value = Math.round(frameDelta / elapsed);
          }
          prevTxBytes = sample.txBytes;
          prevRxBytes = sample.rxBytes;
          prevFrames = sample.frames;
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
    const sample = currentTrafficSample();
    now.value = Date.now();
    prevTxBytes = sample.txBytes;
    prevRxBytes = sample.rxBytes;
    prevFrames = sample.frames;
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
  const frames = rawDataForSession()?.frames.value.length ?? props.session.frames.length;
  const pct = Math.round((frames / maxBufferFrames.value) * 100);
  return `${frames}/${maxBufferFrames.value} ${pct}%`;
});

/** Cumulative dropped bytes this connection. */
const droppedDisplay = computed(() => {
  if (!props.session) return '';
  const dropped = rawDataForSession()?.droppedBytes.value ?? props.session.droppedBytes;
  return dropped === 0 ? '' : formatBytes(dropped);
});

const connectionAnnouncement = computed(() => {
  if (!props.session) return t('session.noActiveSession');
  return connected.value ? t('session.connected') : t('session.disconnected');
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
  gap: var(--space-md);
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

.status-spacer {
  flex: 1 1 auto;
  min-width: var(--space-md);
}

.status-group {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
  flex-shrink: 0;
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
  flex-shrink: 0;
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
</style>
