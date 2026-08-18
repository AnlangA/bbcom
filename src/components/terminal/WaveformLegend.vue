<!--
  Waveform legend + actions + per-channel stats. Extracted from WaveformPanel
  Presentational: receives the channel state + stats, emits per-channel
  toggle and the toolbar actions (toggle-mode/pause/clear/load/export). Pause
  is two-way bound. The action row is a single config-driven loop; adding an
  action means adding one entry below, not another tooltip block.
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
        <n-tooltip v-for="action in actions" :key="action.key" trigger="hover" placement="bottom">
          <template #trigger>
            <span class="wf-tooltip-trigger">
              <button
                class="wf-btn"
                type="button"
                :class="{ active: action.pressed?.value }"
                :aria-label="action.label.value"
                :aria-pressed="action.pressed ? action.pressed.value : undefined"
                :disabled="action.disabled?.value"
                @click="action.onClick()"
              >
                <component :is="action.icon.value" class="icon-sm" :class="action.iconClass" />
              </button>
            </span>
          </template>
          {{ action.label.value }}
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
import { computed, type Component, type Ref } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  CircleDot,
  Crosshair,
  Download,
  Eraser,
  LineChart,
  MoveHorizontal,
  MoveVertical,
  Pause,
  Play,
  Upload,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
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

const emit = defineEmits<{
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

interface LegendAction {
  key: string;
  icon: Ref<Component>;
  iconClass?: string;
  label: Ref<string>;
  disabled?: Ref<boolean>;
  pressed?: Ref<boolean>;
  onClick: () => void;
}

/** Toggle actions flip their tooltip between the show/hide variants. */
function toggler(
  key: string,
  onClick: () => void,
  icon: Component,
  pressed: Ref<boolean>,
  iconClass?: string,
): LegendAction {
  return {
    key,
    icon: computed(() => icon),
    iconClass,
    label: computed(() => t(pressed.value ? `waveform.${key}.hide` : `waveform.${key}.show`)),
    pressed,
    onClick,
  };
}

/** Plain action with a static tooltip. */
function plain(
  key: string,
  onClick: () => void,
  icon: Component,
  labelKey: string,
  disabled?: Ref<boolean>,
): LegendAction {
  return {
    key,
    icon: computed(() => icon),
    label: computed(() => t(labelKey)),
    disabled,
    onClick,
  };
}

const actions = computed<LegendAction[]>(() => [
  {
    key: 'pause',
    icon: computed(() => (props.paused ? Play : Pause)),
    label: computed(() => t(props.paused ? 'waveform.resume' : 'waveform.pause')),
    onClick: () => emit('update:paused', !props.paused),
  },
  plain(
    'pan-left',
    () => emit('pan-left'),
    ArrowLeft,
    'waveform.panLeft',
    computed(() => !props.canPanLeft),
  ),
  plain(
    'pan-right',
    () => emit('pan-right'),
    ArrowRight,
    'waveform.panRight',
    computed(() => !props.canPanRight),
  ),
  plain(
    'zoom-in',
    () => emit('zoom-in'),
    ZoomIn,
    'waveform.zoomIn',
    computed(() => !props.canZoomIn),
  ),
  plain(
    'zoom-out',
    () => emit('zoom-out'),
    ZoomOut,
    'waveform.zoomOut',
    computed(() => !props.canZoomOut),
  ),
  toggler(
    'xRuler',
    () => emit('toggle-x-ruler'),
    MoveHorizontal,
    computed(() => props.showXRuler),
  ),
  toggler(
    'yRuler',
    () => emit('toggle-y-ruler'),
    MoveVertical,
    computed(() => props.showYRuler),
  ),
  toggler(
    'hoverRuler',
    () => emit('toggle-hover-ruler'),
    Crosshair,
    computed(() => props.showHoverRuler),
  ),
  toggler(
    'samplePoints',
    () => emit('toggle-sample-points'),
    CircleDot,
    computed(() => props.showSamplePoints),
    'sample-point-icon',
  ),
  plain('clear', () => emit('clear'), Eraser, 'waveform.clear'),
  plain('load', () => emit('load'), Upload, 'waveform.loadStream'),
  plain(
    'export',
    () => emit('export'),
    Download,
    'waveform.exportCsv',
    computed(() => props.disabled),
  ),
]);
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
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-sm);
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
  font-size: var(--font-size-sm);
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
  border-left: 2px solid var(--text-muted);
}

.stat-name {
  color: var(--text-muted);
  font-weight: 700;
}

.stat-val {
  color: var(--text-dim);
}
</style>
