<template>
  <div v-if="enabled" class="waveform-panel">
    <div class="waveform-header">
      <span class="wf-title">
        <LineChart class="icon-sm" />
        {{ t('waveform.title') }}
      </span>
      <div class="wf-legend">
        <span v-for="(ch, i) in channels" :key="i" class="legend-item">
          <span class="legend-swatch" :style="{ background: ch.color }"></span>
          <span class="legend-value">{{ ch.latest !== null ? formatNum(ch.latest) : '—' }}</span>
        </span>
      </div>
      <button class="wf-close" type="button" :title="t('waveform.close')" @click="enabled = false">
        <X class="icon-sm" />
      </button>
    </div>
    <canvas ref="canvasRef" class="waveform-canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { LineChart, X } from 'lucide-vue-next';
import type { DataFrame } from '../../types';
import { t } from '../../lib/i18n';
import {
  channelColor,
  channelRanges,
  createBuffer,
  decodeFrameText,
  parseSampleLine,
  pushSample,
} from '../../lib/waveform';

const props = defineProps<{
  frames: DataFrame[];
  /** Which direction's data to plot. RX is the usual sensor stream. */
  direction?: DataFrame['direction'];
}>();

const enabled = ref(true);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const CAPACITY = 300;
const buffer = createBuffer(CAPACITY);
const channels = ref<Array<{ color: string; latest: number | null }>>([]);

// Track how many frames we've already consumed so we only parse new ones.
let consumed = 0;

function ingestNewFrames() {
  const dir = props.direction ?? 'RX';
  const frames = props.frames;
  let channelCount = channels.value.length;
  let changed = false;
  for (let i = consumed; i < frames.length; i += 1) {
    const f = frames[i];
    if (f.direction !== dir) continue;
    const sample = parseSampleLine(decodeFrameText(f.data));
    if (sample.length === 0) continue;
    if (sample.length > channelCount) channelCount = sample.length;
    pushSample(buffer, sample);
  }
  if (channelCount !== channels.value.length) {
    channels.value = Array.from({ length: channelCount }, (_, i) => ({
      color: channelColor(i),
      latest: null,
    }));
    changed = true;
  }
  // Refresh the legend readout from the latest sample.
  const last = buffer.samples.length > 0 ? buffer.samples[buffer.samples.length - 1] : null;
  if (last) {
    channels.value = channels.value.map((ch, i) => ({ ...ch, latest: last[i] ?? null }));
    changed = true;
  }
  consumed = frames.length;
  return changed;
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// RAF render loop. Only runs while enabled and there's a canvas. Re-derives
// ranges each frame so autoscaling tracks the data; the work is bounded by
// CAPACITY (300 samples × N channels), trivially cheap.
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

  // Grid + axis baseline.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g += 1) {
    const y = (cssH / 4) * g;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
  }

  const channelCount = channels.value.length;
  if (channelCount === 0 || buffer.samples.length === 0) {
    rafId = requestAnimationFrame(loop);
    rendering = false;
    return;
  }

  const ranges = channelRanges(buffer, channelCount);
  const sampleCount = buffer.samples.length;
  const xStep = cssW / Math.max(1, CAPACITY - 1);
  const xOffset = (CAPACITY - sampleCount) * xStep; // right-align newest

  for (let c = 0; c < channelCount; c += 1) {
    const [min, max] = ranges[c];
    const span = max - min || 1;
    ctx.strokeStyle = channels.value[c].color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < sampleCount; i += 1) {
      const v = buffer.samples[i][c];
      if (v === undefined || !Number.isFinite(v)) continue;
      const x = xOffset + i * xStep;
      const y = cssH - ((v - min) / span) * cssH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  rafId = requestAnimationFrame(loop);
  rendering = false;
}

function loop() {
  if (!enabled.value) return;
  ingestNewFrames();
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

watch(enabled, (on) => {
  if (on) start();
  else stop();
});

watch(
  () => props.frames.length,
  () => {
    // Ingest happens in the render loop; this watcher just ensures the loop is
    // running when new data arrives while the panel is open.
    if (enabled.value && rafId === null) start();
  },
);

start();
onUnmounted(stop);
</script>

<style scoped>
.waveform-panel {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  height: 180px;
  flex-shrink: 0;
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
}

.wf-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wf-legend {
  display: flex;
  gap: 12px;
  flex: 1;
  overflow-x: auto;
  text-transform: none;
  letter-spacing: 0;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.wf-close {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
}

.wf-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.waveform-canvas {
  flex: 1;
  width: 100%;
  display: block;
}
</style>
