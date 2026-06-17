<!--
  Waveform legend + actions + per-channel stats. Extracted from WaveformPanel
  (T3.2). Presentational: receives the channel state + stats, emits per-channel
  toggle and the toolbar actions (toggle-mode/pause/clear/load/export). Pause
  is two-way bound.
-->
<template>
  <div>
    <div class="waveform-header">
      <span class="wf-title">
        <LineChart class="icon-sm" />
        {{ t('waveform.title') }}
      </span>
      <!-- Per-channel legend: swatch toggles visibility, value shows the latest sample. -->
      <div class="wf-legend">
        <span v-for="(ch, i) in channelState" :key="i" class="legend-item">
          <button
            type="button"
            class="legend-toggle"
            :class="{ hidden: !ch.visible }"
            :title="
              ch.visible
                ? t('waveform.showChannel', { index: i })
                : t('waveform.hideChannel', { index: i })
            "
            @click="$emit('toggle-channel', i)"
          >
            <span class="legend-swatch" :style="{ background: ch.color }"></span>
            <span class="legend-name">{{ channelLabel(i) }}</span>
          </button>
          <span class="legend-value">{{ ch.latest !== null ? formatNum(ch.latest) : '—' }}</span>
        </span>
        <span v-if="channelState.length === 0" class="legend-empty">{{
          t('waveform.noData')
        }}</span>
      </div>
      <div class="wf-actions">
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="source-toggle"
              type="button"
              :aria-label="sourceTooltip"
              @click="$emit('toggle-mode')"
            >
              <span class="source-option" :class="{ active: sourceMode === 'text' }">RX</span>
              <span class="source-option" :class="{ active: sourceMode === 'register' }">REG</span>
            </button>
          </template>
          {{ sourceTooltip }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :aria-label="paused ? t('waveform.resume') : t('waveform.pause')"
              @click="$emit('update:paused', !paused)"
            >
              <Play v-if="paused" class="icon-sm" />
              <Pause v-else class="icon-sm" />
            </button>
          </template>
          {{ paused ? t('waveform.resume') : t('waveform.pause') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :aria-label="t('waveform.panLeft')"
                :disabled="!canPanLeft"
                @click="$emit('pan-left')"
              >
                <ArrowLeft class="icon-sm" />
              </button>
            </span>
          </template>
          {{ t('waveform.panLeft') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :aria-label="t('waveform.panRight')"
                :disabled="!canPanRight"
                @click="$emit('pan-right')"
              >
                <ArrowRight class="icon-sm" />
              </button>
            </span>
          </template>
          {{ t('waveform.panRight') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :aria-label="t('waveform.zoomIn')"
                :disabled="!canZoomIn"
                @click="$emit('zoom-in')"
              >
                <ZoomIn class="icon-sm" />
              </button>
            </span>
          </template>
          {{ t('waveform.zoomIn') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :aria-label="t('waveform.zoomOut')"
                :disabled="!canZoomOut"
                @click="$emit('zoom-out')"
              >
                <ZoomOut class="icon-sm" />
              </button>
            </span>
          </template>
          {{ t('waveform.zoomOut') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :class="{ active: showXRuler }"
              :aria-label="showXRuler ? t('waveform.xRuler.hide') : t('waveform.xRuler.show')"
              :aria-pressed="showXRuler"
              @click="$emit('toggle-x-ruler')"
            >
              <MoveHorizontal class="icon-sm" />
            </button>
          </template>
          {{ showXRuler ? t('waveform.xRuler.hide') : t('waveform.xRuler.show') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :class="{ active: showYRuler }"
              :aria-label="showYRuler ? t('waveform.yRuler.hide') : t('waveform.yRuler.show')"
              :aria-pressed="showYRuler"
              @click="$emit('toggle-y-ruler')"
            >
              <MoveVertical class="icon-sm" />
            </button>
          </template>
          {{ showYRuler ? t('waveform.yRuler.hide') : t('waveform.yRuler.show') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :class="{ active: showHoverRuler }"
              :aria-label="
                showHoverRuler ? t('waveform.hoverRuler.hide') : t('waveform.hoverRuler.show')
              "
              :aria-pressed="showHoverRuler"
              @click="$emit('toggle-hover-ruler')"
            >
              <Crosshair class="icon-sm" />
            </button>
          </template>
          {{ showHoverRuler ? t('waveform.hoverRuler.hide') : t('waveform.hoverRuler.show') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :class="{ active: showSamplePoints }"
              :aria-label="
                showSamplePoints ? t('waveform.samplePoints.hide') : t('waveform.samplePoints.show')
              "
              :aria-pressed="showSamplePoints"
              @click="$emit('toggle-sample-points')"
            >
              <CircleDot class="icon-sm sample-point-icon" />
            </button>
          </template>
          {{ showSamplePoints ? t('waveform.samplePoints.hide') : t('waveform.samplePoints.show') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :aria-label="t('waveform.clear')"
              @click="$emit('clear')"
            >
              <Eraser class="icon-sm" />
            </button>
          </template>
          {{ t('waveform.clear') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <button
              class="wf-btn"
              type="button"
              :aria-label="t('waveform.loadStream')"
              @click="$emit('load')"
            >
              <Upload class="icon-sm" />
            </button>
          </template>
          {{ t('waveform.loadStream') }}
        </n-tooltip>
        <n-tooltip trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :aria-label="t('waveform.exportCsv')"
                :disabled="disabled"
                @click="$emit('export')"
              >
                <Download class="icon-sm" />
              </button>
            </span>
          </template>
          {{ t('waveform.exportCsv') }}
        </n-tooltip>
      </div>
    </div>
    <div v-if="channelState.length > 0" class="wf-stats">
      <span
        v-for="(stat, i) in stats"
        :key="i"
        class="stat-chip"
        :style="{ '--stat-color': channelState[i]?.color }"
      >
        <span class="stat-name">{{ channelLabel(i) }}</span>
        <span class="stat-val">{{ t('waveform.stat.min') }} {{ formatNum(stat.min) }}</span>
        <span class="stat-val">{{ t('waveform.stat.max') }} {{ formatNum(stat.max) }}</span>
        <span class="stat-val">{{ t('waveform.stat.avg') }} {{ formatNum(stat.mean) }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  LineChart,
  Play,
  Pause,
  Eraser,
  Upload,
  Download,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  MoveHorizontal,
  MoveVertical,
  Crosshair,
  CircleDot,
} from 'lucide-vue-next';
import { NTooltip } from 'naive-ui';
import { t } from '../../lib/i18n';
import type { WaveformSourceMode } from '../../types/waveform';

interface ChannelState {
  color: string;
  visible: boolean;
  latest: number | null;
}
interface ChannelStats {
  min: number;
  max: number;
  mean: number;
}

const props = defineProps<{
  channelState: ChannelState[];
  stats: ChannelStats[];
  channelLabel: (i: number) => string;
  formatNum: (n: number) => string;
  sourceMode: WaveformSourceMode;
  showXRuler: boolean;
  showYRuler: boolean;
  showHoverRuler: boolean;
  showSamplePoints: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canPanLeft: boolean;
  canPanRight: boolean;
  paused: boolean;
  disabled: boolean;
}>();

defineEmits<{
  'toggle-channel': [number];
  'toggle-mode': [];
  'zoom-in': [];
  'zoom-out': [];
  'pan-left': [];
  'pan-right': [];
  'toggle-x-ruler': [];
  'toggle-y-ruler': [];
  'toggle-hover-ruler': [];
  'toggle-sample-points': [];
  'update:paused': [boolean];
  clear: [];
  load: [];
  export: [];
}>();

const sourceTooltip = computed(() => {
  const currentKey =
    props.sourceMode === 'register' ? 'waveform.sourceMode.register' : 'waveform.sourceMode.text';
  const nextKey =
    props.sourceMode === 'register' ? 'waveform.sourceMode.text' : 'waveform.sourceMode.register';
  return t('waveform.sourceMode.tooltip', {
    current: t(currentKey),
    next: t(nextKey),
  });
});
</script>

<style scoped>
.waveform-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.wf-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  color: var(--text-muted);
  flex-shrink: 0;
}

.wf-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: var(--font-mono);
}

.legend-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
  color: var(--text-secondary);
}

.legend-toggle.hidden {
  opacity: 0.4;
}

.legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.legend-name {
  color: var(--text-dim);
}

.legend-value {
  color: var(--accent-blue);
  font-weight: 600;
}

.legend-empty {
  color: var(--text-dim);
  font-size: 11px;
}

.wf-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.source-toggle {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  width: 66px;
  height: 24px;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-dim);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.source-toggle:hover {
  border-color: var(--border-color);
  background: var(--bg-hover);
}

.source-option {
  display: grid;
  place-items: center;
  border-radius: var(--radius-xs);
}

.source-option.active {
  background: var(--bg-active);
  color: var(--color-primary);
}

.wf-tooltip-trigger {
  display: inline-flex;
}

.wf-btn {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
}

.wf-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.wf-btn.active {
  color: var(--color-primary);
  background: var(--bg-active);
}

.wf-btn.active .sample-point-icon :deep(circle:last-child) {
  fill: currentColor;
  stroke-width: 0;
}

.wf-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.wf-stats {
  display: flex;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  border-left: 2px solid var(--stat-color, var(--text-dim));
}

.stat-name {
  color: var(--stat-color, var(--text-dim));
  font-weight: 700;
}

.stat-val {
  color: var(--text-dim);
}
</style>
