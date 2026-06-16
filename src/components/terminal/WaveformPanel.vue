<template>
  <div class="waveform-panel">
    <div class="waveform-header">
      <span class="wf-title">
        <LineChart class="icon-sm" />
        {{ t('waveform.title') }}
      </span>
      <!-- Per-channel legend: swatch toggles visibility, value shows the latest sample, click stats to see min/max/avg. -->
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
            @click="toggleChannel(i)"
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
        <button
          class="wf-btn"
          type="button"
          :title="t('waveform.sourceMode')"
          @click="$emit('toggleMode')"
        >
          <Type class="icon-sm" />
        </button>
        <button
          class="wf-btn"
          type="button"
          :title="paused ? t('waveform.resume') : t('waveform.pause')"
          @click="paused = !paused"
        >
          <Play v-if="paused" class="icon-sm" />
          <Pause v-else class="icon-sm" />
        </button>
        <button class="wf-btn" type="button" :title="t('waveform.clear')" @click="clearBuffer">
          <Eraser class="icon-sm" />
        </button>
        <button class="wf-btn" type="button" :title="t('waveform.loadStream')" @click="loadStream">
          <Upload class="icon-sm" />
        </button>
        <button
          class="wf-btn"
          type="button"
          :title="t('waveform.exportCsv')"
          :disabled="buffer.samples.length === 0"
          @click="exportCsv"
        >
          <Download class="icon-sm" />
        </button>
      </div>
    </div>
    <div class="wf-stats" v-if="channelState.length > 0">
      <span
        v-for="(stat, i) in statsView"
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
    <input
      ref="streamFileInput"
      type="file"
      accept=".bbreg,.jsonl,.txt"
      hidden
      @change="onStreamFilePicked"
    />
    <canvas ref="canvasRef" class="waveform-canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { Download, Eraser, LineChart, Pause, Play, Type, Upload } from 'lucide-vue-next';
import { useMessage } from 'naive-ui';
import type { DataFrame } from '../../types';
import { t } from '../../lib/i18n';
import {
  channelColor,
  channelRanges,
  channelStats,
  createBuffer,
  decodeFrameText,
  parseSampleLine,
  pushSample,
  type ChannelStats,
} from '../../lib/waveform';
import { parseStream } from '../../lib/modbus-stream';

const props = defineProps<{
  frames: DataFrame[];
  /** Which direction's data to plot. RX is the usual sensor stream. */
  direction?: DataFrame['direction'];
  /** Sample source: 'text' parses trailing RX numbers (Arduino Serial Plotter
   *  style); 'register' plots Modbus register values pushed by the master. */
  mode?: 'text' | 'register';
  /** Per-channel display labels for register mode (e.g. {0: 'Temp'}). Keys with
   *  no entry fall back to the default 'Ch N' label. */
  channelLabels?: Record<number, string>;
}>();

defineEmits<{ (e: 'toggleMode'): void }>();

const message = useMessage();
const canvasRef = ref<HTMLCanvasElement | null>(null);

const CAPACITY = 600;
const buffer = createBuffer(CAPACITY);

interface ChannelState {
  color: string;
  latest: number | null;
  visible: boolean;
}
const channelState = ref<ChannelState[]>([]);

// Track how many frames we've already consumed so we only parse new ones.
let consumed = 0;
// When paused, new frames are still consumed (so the offset stays aligned) but
// their samples are dropped — freezing the plot at its last position.
const paused = ref(false);

/** Label for channel `i`: the register name in register mode, else 'Ch N'. */
function channelLabel(i: number): string {
  const label = props.channelLabels?.[i];
  if (label) return label;
  return `${t('waveform.channel')}${i}`;
}

/**
 * Push one decoded register value onto a channel (register mode). Called by the
 * Modbus master on each poll tick via a template ref. Grows the channel list to
 * fit the channel index and updates the legend readout.
 */
function pushRegisterSample(channel: number, value: number) {
  if (paused.value || channel < 0 || !Number.isFinite(value)) return;
  ensureChannel(channel);
  // Sparse sample: only the bound channel carries a new value; others hold
  // their previous latest so unrelated channels keep steady lines.
  const sample: number[] = [];
  for (let i = 0; i <= channel; i += 1) {
    sample[i] = i === channel ? value : (channelState.value[i]?.latest ?? 0);
  }
  pushSample(buffer, sample);
  const next = channelState.value.slice();
  next[channel] = { ...next[channel], latest: value };
  channelState.value = next;
}

function ensureChannel(channel: number) {
  if (channel < channelState.value.length) return;
  const next: ChannelState[] = channelState.value.slice();
  for (let i = next.length; i <= channel; i += 1) {
    next.push({ color: channelColor(i), latest: null, visible: true });
  }
  channelState.value = next;
}

defineExpose({ pushRegisterSample });

const streamFileInput = ref<HTMLInputElement | null>(null);

function loadStream() {
  streamFileInput.value?.click();
}

function onStreamFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const records = parseStream(String(reader.result ?? ''));
    if (records.length === 0) {
      message.warning(t('waveform.noData'));
      return;
    }
    for (const rec of records) {
      if (typeof rec.ch === 'number' && rec.ch >= 0) {
        pushRegisterSample(rec.ch, rec.value);
      }
    }
    message.success(t('waveform.exportedStream', { count: records.length }));
  };
  reader.readAsText(file);
  input.value = '';
}

function ingestNewFrames() {
  // Register mode is fed imperatively by the master (pushRegisterSample); the
  // text-parsing path only runs in text mode.
  if ((props.mode ?? 'text') === 'register') {
    consumed = props.frames.length;
    return;
  }
  const dir = props.direction ?? 'RX';
  const frames = props.frames;
  let channelCount = channelState.value.length;
  for (let i = consumed; i < frames.length; i += 1) {
    const f = frames[i];
    if (f.direction !== dir) continue;
    const sample = parseSampleLine(decodeFrameText(f.data));
    if (sample.length === 0) continue;
    if (sample.length > channelCount) channelCount = sample.length;
    if (!paused.value) pushSample(buffer, sample);
  }
  if (channelCount !== channelState.value.length) {
    // Grow the channel list, preserving visibility/latest of existing channels.
    const next: ChannelState[] = [];
    for (let i = 0; i < channelCount; i += 1) {
      const prev = channelState.value[i];
      next.push({
        color: channelColor(i),
        latest: prev?.latest ?? null,
        visible: prev?.visible ?? true,
      });
    }
    channelState.value = next;
  }
  // Refresh the legend readout from the latest sample.
  const last = buffer.samples.length > 0 ? buffer.samples[buffer.samples.length - 1] : null;
  if (last) {
    channelState.value = channelState.value.map((ch, i) => ({ ...ch, latest: last[i] ?? null }));
  }
  consumed = frames.length;
}

function toggleChannel(i: number) {
  const next = channelState.value.slice();
  if (next[i]) next[i] = { ...next[i], visible: !next[i].visible };
  channelState.value = next;
}

function clearBuffer() {
  buffer.samples.length = 0;
}

const statsView = computed<ChannelStats[]>(() => channelStats(buffer, channelState.value.length));

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// RAF render loop. Only runs while enabled and there's a canvas. Re-derives
// ranges each frame so autoscaling tracks the data; the work is bounded by
// CAPACITY (600 samples × N channels), trivially cheap.
let rafId: number | null = null;
let rendering = false;

function render() {
  rendering = true;
  const canvas = canvasRef.value;
  if (!canvas) {
    rendering = false;
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    rendering = false;
    return;
  }
  // Match the backing store to the displayed size for crisp lines (HiDPI).
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Theme-aware grid (var reads from CSS so light/dark both look right). Grid
  // is drawn first so channel lines render on top.
  refreshMonoFont();
  const gridColor = readCssVar('--grid-line', 'rgba(255,255,255,0.04)');
  const axisColor = readCssVar('--text-dim', 'rgba(255,255,255,0.3)');
  const leftPad = 44; // room for Y-axis labels
  const plotX0 = leftPad;
  const plotW = cssW - leftPad;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 0; g <= 4; g += 1) {
    const y = (cssH / 4) * g;
    ctx.moveTo(plotX0, y);
    ctx.lineTo(cssW, y);
  }
  ctx.stroke();

  const channelCount = channelState.value.length;
  if (channelCount === 0 || buffer.samples.length === 0) {
    rafId = requestAnimationFrame(loop);
    rendering = false;
    return;
  }

  const ranges = channelRanges(buffer, channelCount);
  const sampleCount = buffer.samples.length;
  const xStep = plotW / Math.max(1, CAPACITY - 1);
  const xOffset = (CAPACITY - sampleCount) * xStep; // right-align newest

  // Y-axis labels for the first visible channel's range (autoscale reference).
  const firstVisibleRange = (() => {
    for (let c = 0; c < channelCount; c += 1) {
      if (channelState.value[c]?.visible) return ranges[c];
    }
    return ranges[0];
  })();
  ctx.fillStyle = axisColor;
  // Canvas 2D `font` does not resolve CSS variables — read the resolved family
  // from the DOM so the Y-axis labels use the same monospace stack as the rest
  // of the UI (otherwise it silently falls back to the canvas default).
  ctx.font = `10px ${monoFontStack}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const [vMin, vMax] = firstVisibleRange;
  for (let g = 0; g <= 4; g += 1) {
    const y = (cssH / 4) * g;
    const v = vMax - ((vMax - vMin) * g) / 4;
    ctx.fillText(formatNum(v), leftPad - 6, y);
  }

  for (let c = 0; c < channelCount; c += 1) {
    if (!channelState.value[c]?.visible) continue;
    const [min, max] = ranges[c];
    const span = max - min || 1;
    ctx.strokeStyle = channelState.value[c].color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < sampleCount; i += 1) {
      const v = buffer.samples[i][c];
      if (v === undefined || !Number.isFinite(v)) continue;
      const x = plotX0 + xOffset + i * xStep;
      const y = cssH - ((v - min) / span) * cssH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  rafId = requestAnimationFrame(loop);
  rendering = false;
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // getComputedStyle returns "" for unset vars; rgba()/hex values pass through.
  return v || fallback;
}

// Resolved once per render: the page's monospace family (e.g.
// 'JetBrains Mono','SFMono-Regular',...). Canvas `font` can't take a CSS var,
// so we read the resolved value. Falls back to a safe generic stack.
let monoFontStack = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
function refreshMonoFont() {
  const resolved = readCssVar('--font-mono', monoFontStack);
  if (resolved) monoFontStack = resolved;
}

function loop() {
  if (!paused.value) ingestNewFrames();
  if (!rendering) render();
}

function start() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// Pause/visibility changes only affect ingestion/render decisions; the loop
// keeps running so resuming is instant and the plot repaints on toggle.
watch(
  () => channelState.value.map((c) => c.visible).join(','),
  () => {
    /* visibility read inside render() each frame; nothing else needed */
  },
);

watch(
  () => props.frames.length,
  () => {
    // Ingest happens in the render loop; this watcher just ensures the loop is
    // running when new data arrives while the panel is open.
    if (rafId === null) start();
  },
);

function exportCsv() {
  const samples = buffer.samples;
  if (samples.length === 0) return;
  const channelCount = channelState.value.length;
  const header = Array.from({ length: channelCount }, (_, i) => `ch${i}`).join(',');
  const lines = [header];
  for (let i = 0; i < samples.length; i += 1) {
    const row: string[] = [];
    for (let c = 0; c < channelCount; c += 1) {
      const v = samples[i][c];
      row.push(v === undefined || !Number.isFinite(v) ? '' : String(v));
    }
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bbcom-waveform-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(t('waveform.exported', { count: samples.length }));
}

start();
onUnmounted(stop);
</script>

<style scoped>
.waveform-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  min-height: 0;
}

.waveform-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.wf-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.wf-legend {
  display: flex;
  gap: 12px;
  flex: 1;
  overflow-x: auto;
  text-transform: none;
  letter-spacing: 0;
  min-width: 0;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.legend-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: inherit;
}

.legend-toggle.hidden {
  opacity: 0.35;
}

.legend-toggle.hidden .legend-swatch {
  background: transparent !important;
  border: 1px dashed currentColor;
}

.legend-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  flex-shrink: 0;
}

.legend-name {
  font-size: 10px;
  color: var(--text-muted);
}

.legend-value {
  color: var(--text-primary);
  font-weight: 600;
}

.legend-empty {
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-sans);
  text-transform: none;
  letter-spacing: 0;
}

.wf-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.wf-btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.wf-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.wf-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.wf-stats {
  display: flex;
  gap: 8px;
  padding: 3px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  overflow-x: auto;
  flex-shrink: 0;
}

.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-left: 2px solid var(--stat-color, var(--color-primary));
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.stat-name {
  color: var(--text-primary);
  font-weight: 700;
}

.stat-val {
  color: var(--text-muted);
}

.waveform-canvas {
  flex: 1;
  width: 100%;
  display: block;
  min-height: 0;
}
</style>
