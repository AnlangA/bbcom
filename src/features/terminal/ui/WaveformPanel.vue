<template>
  <div class="waveform-panel">
    <WaveformLegend
      :channel-state="channelState"
      :stats="statsView"
      :channel-label="channelLabel"
      :format-num="formatNum"
      :source-mode="props.mode ?? 'text'"
      :show-x-ruler="showXRuler"
      :show-y-ruler="showYRuler"
      :show-hover-ruler="showHoverRuler"
      :show-sample-points="showSamplePoints"
      :can-zoom-in="canZoomIn"
      :can-zoom-out="canZoomOut"
      :can-pan-left="canPanLeft"
      :can-pan-right="canPanRight"
      v-model:paused="paused"
      :disabled="sampleCountView === 0"
      @toggle-channel="toggleChannel"
      @toggle-mode="$emit('toggleMode')"
      @zoom-in="zoomViewport('in')"
      @zoom-out="zoomViewport('out')"
      @pan-left="panViewport('left')"
      @pan-right="panViewport('right')"
      @toggle-x-ruler="toggleXRuler"
      @toggle-y-ruler="toggleYRuler"
      @toggle-hover-ruler="toggleHoverRuler"
      @toggle-sample-points="toggleSamplePoints"
      @clear="clearBuffer"
      @load="loadStream"
      @export="exportCsv"
    />
    <input
      ref="streamFileInput"
      type="file"
      accept=".bbreg,.jsonl,.txt"
      hidden
      @change="onStreamFilePicked"
    />
    <canvas
      ref="canvasRef"
      class="waveform-canvas"
      role="img"
      :aria-label="t('waveform.title')"
      :aria-describedby="waveformDescriptionId"
      :class="{
        'hover-ruler-enabled': showHoverRuler,
        'is-draggable': sampleCountView > 0,
        'is-dragging': dragging,
      }"
      @pointerdown="onCanvasPointerDown"
      @pointermove="onCanvasPointerMove"
      @pointerup="onCanvasPointerUp"
      @pointerleave="onCanvasPointerLeave"
      @pointercancel="onCanvasPointerCancel"
      @lostpointercapture="onCanvasPointerCaptureLost"
      @wheel.prevent="onCanvasWheel"
    ></canvas>
    <p :id="waveformDescriptionId" class="sr-only">
      {{
        accessibleSampleRows.length === 0
          ? t('waveform.noData')
          : t('session.stats.totalFrames', { count: accessibleSampleRows.length })
      }}
    </p>
    <table :id="waveformTableId" class="sr-only" :aria-label="t('waveform.title')">
      <caption>
        {{
          t('waveform.title')
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">{{ t('packet.time') }}</th>
          <th v-for="index in 8" :key="index" scope="col">{{ channelLabel(index - 1) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in accessibleSampleRows" :key="row.timestamp">
          <th scope="row">{{ row.timestamp }}</th>
          <td v-for="(value, index) in row.values" :key="index">{{ value }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { useMessage } from 'naive-ui';
import type {
  DataFrame,
  SessionWaveformFrameCursor,
  SessionWaveformSampleInput,
  SessionWaveformState,
} from '@/types';
import { t } from '@/lib/i18n';
import {
  normalizeWaveformTimeViewport,
  visibleChannelRangeInWindow,
  waveformSampleIndexWindow,
  DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
} from '@/lib/waveform';
import {
  buildVisibleChannelPaths,
  drawHoverRuler,
  drawSamplePoints,
  drawWaveformPaths,
  drawXRuler,
  drawYRuler,
  findHoverPoint,
  formatNum,
  monoFontStack,
  readWaveformTheme,
} from '@/lib/waveform-render';
import WaveformLegend from './WaveformLegend.vue';
import { useWaveformIngest } from './waveform/useWaveformIngest';
import { useWaveformViewport, waveformPlotLayout } from './waveform/useWaveformViewport';
import { useWaveformExport } from './waveform/useWaveformExport';

const props = defineProps<{
  frames: DataFrame[];
  /** Shallow frame arrays are updated through this explicit store signal. */
  framesVersion?: number;
  /** Which direction's data to plot. RX is the usual sensor stream. */
  direction?: DataFrame['direction'];
  /** Sample source: 'text' parses trailing RX numbers (Arduino Serial Plotter
   *  style); 'register' plots Modbus register values pushed by the master. */
  mode?: 'text' | 'register';
  /** Per-channel display labels for register mode (e.g. {0: 'Temp'}). Keys with
   *  no entry fall back to the default 'Ch N' label. */
  channelLabels?: Record<number, string>;
  /** Application/session-owned durable waveform state. */
  waveform: SessionWaveformState;
  /** Separate gates mirror the workspace user/runtime mutation boundaries. */
  canEdit?: boolean;
  canAppend?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleMode'): void;
  (e: 'appendSamples', samples: readonly SessionWaveformSampleInput[]): void;
  (e: 'replaceSamples', samples: readonly SessionWaveformSampleInput[]): void;
  (e: 'setChannelVisibility', channelIndex: number, visible: boolean): void;
  (e: 'updateFrameCursor', cursor: SessionWaveformFrameCursor): void;
  (
    e: 'commitFrameIngest',
    ingest: Readonly<{
      mode: 'append' | 'replace';
      samples: readonly SessionWaveformSampleInput[];
      cursor: SessionWaveformFrameCursor;
    }>,
  ): void;
  (e: 'clear', cursor: SessionWaveformFrameCursor): void;
}>();

const message = useMessage();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const waveformId = useId().replace(/:/g, '');
const waveformDescriptionId = `waveform-${waveformId}-description`;
const waveformTableId = `waveform-${waveformId}-table`;

// Canvas redraws are demand-driven and coalesced into one RAF. This keeps the
// waveform idle at 0fps when no data or pointer interaction changes the view.
let rafId: number | null = null;
let resizeObserver: ResizeObserver | null = null;

const showXRuler = ref(true);
const showYRuler = ref(true);
const showHoverRuler = ref(true);
const showSamplePoints = ref(false);

// The viewport composable is created right after ingest; ingest only reaches
// the viewport hooks lazily (post-mount ingests and buffer resets).
const ingest = useWaveformIngest({
  frames: () => props.frames,
  framesVersion: () => props.framesVersion,
  mode: () => props.mode,
  direction: () => props.direction,
  canAppend: () => props.canAppend,
  canEdit: () => props.canEdit,
  waveform: () => props.waveform,
  onAppendSamples: (samples) => emit('appendSamples', samples),
  onCommitFrameIngest: (ingestCommit) => emit('commitFrameIngest', ingestCommit),
  onUpdateFrameCursor: (cursor) => emit('updateFrameCursor', cursor),
  onClear: (cursor) => emit('clear', cursor),
  syncViewportAfterSampleChange: (previousTimestamps) =>
    viewport.syncViewportAfterSampleChange(previousTimestamps),
  resetViewport: () => viewport.resetViewport(),
  scheduleRender: () => scheduleRender(),
});

const viewport = useWaveformViewport({
  buffer: ingest.buffer,
  canvasRef,
  showXRuler: () => showXRuler.value,
  showYRuler: () => showYRuler.value,
  showHoverRuler: () => showHoverRuler.value,
  scheduleRender: () => scheduleRender(),
});

const streamFileInput = ref<HTMLInputElement | null>(null);

const exporter = useWaveformExport({
  samples: () => ingest.buffer.samples,
  channelCount: () => ingest.channelState.value.length,
  fileInputTarget: () => streamFileInput.value,
  onFileSamples: (samples) => ingest.pushRegisterSamples(samples),
  message,
});

// Local aliases keep the template bindings (and the v-model:paused contract)
// unchanged while the implementations live in the composables.
const { channelState, statsView, sampleCountView, paused, clearBuffer } = ingest;
const {
  dragging,
  canZoomIn,
  canZoomOut,
  canPanLeft,
  canPanRight,
  zoomViewport,
  panViewport,
  onCanvasPointerDown,
  onCanvasPointerMove,
  onCanvasPointerUp,
  onCanvasPointerLeave,
  onCanvasPointerCancel,
  onCanvasPointerCaptureLost,
  onCanvasWheel,
} = viewport;
const { loadStream, exportCsv, onStreamFilePicked } = exporter;

defineExpose({
  pushRegisterSample: ingest.pushRegisterSample,
  pushRegisterSamples: ingest.pushRegisterSamples,
});

const accessibleSampleRows = computed(() => {
  void ingest.waveformVersion.value;
  const buffer = ingest.buffer;
  const start = Math.max(0, buffer.timestamps.length - 100);
  return buffer.timestamps.slice(start).map((timestamp, offset) => ({
    timestamp,
    values: Array.from({ length: 8 }, (_, channel) => {
      const value = buffer.samples[start + offset]?.[channel];
      return value === undefined || !Number.isFinite(value) ? '' : formatNum(value);
    }),
  }));
});

/** Label for channel `i`: the register name in register mode, else 'Ch N'. */
function channelLabel(i: number): string {
  const label = props.channelLabels?.[i];
  if (label) return label;
  return `${t('waveform.channel')}${i}`;
}

function toggleChannel(i: number) {
  if (props.canEdit === false) return;
  const next = ingest.channelState.value.slice();
  if (next[i]) {
    const visible = !next[i].visible;
    next[i] = { ...next[i], visible };
    emit('setChannelVisibility', i, visible);
  }
  ingest.channelState.value = next;
  scheduleRender();
}

function toggleXRuler() {
  showXRuler.value = !showXRuler.value;
  scheduleRender();
}

function toggleYRuler() {
  showYRuler.value = !showYRuler.value;
  scheduleRender();
}

function toggleHoverRuler() {
  showHoverRuler.value = !showHoverRuler.value;
  scheduleRender();
}

function toggleSamplePoints() {
  showSamplePoints.value = !showSamplePoints.value;
  scheduleRender();
}

function scheduleRender() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    render();
  });
}

function cancelScheduledRender() {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

function render() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
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
  const {
    axisColor,
    gridColor,
    hoverBg,
    hoverLineColor,
    hoverText,
    samplePointOutline,
    rulerColor,
  } = readWaveformTheme();
  const { leftPad, plotX0, plotX1, plotTop, plotBottom, plotW, plotH } = waveformPlotLayout(
    canvas,
    showYRuler.value,
    showXRuler.value,
  );

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 0; g <= 4; g += 1) {
    const y = plotTop + (plotH / 4) * g;
    ctx.moveTo(plotX0, y);
    ctx.lineTo(plotX1, y);
  }
  ctx.stroke();

  const buffer = ingest.buffer;
  const channelCount = ingest.channelState.value.length;
  if (channelCount === 0 || buffer.samples.length === 0) {
    return;
  }

  const activeViewport = normalizeWaveformTimeViewport(
    viewport.timeViewport.value,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const visibleStartMs = activeViewport.startMs;
  const visibleEndMs = visibleStartMs + activeViewport.durationMs;
  const visibleWindow = waveformSampleIndexWindow(buffer.timestamps, visibleStartMs, visibleEndMs);
  const [vMin, vMax] = visibleChannelRangeInWindow(
    buffer,
    channelCount,
    ingest.channelState.value.map((channel) => channel.visible),
    visibleWindow.scanStartIndex,
    visibleWindow.scanEndIndex,
  );
  const span = vMax - vMin || 1;
  const firstTimestamp = visibleStartMs;
  const timeSpan = activeViewport.durationMs;
  const hasTimeScale = Number.isFinite(timeSpan) && timeSpan > 0;
  const originTimestamp = buffer.originTimestamp ?? firstTimestamp;

  const sampleX = (timestamp: number): number => {
    if (hasTimeScale) {
      return plotX0 + ((timestamp - firstTimestamp) / timeSpan) * plotW;
    }
    return plotX0;
  };

  ctx.fillStyle = axisColor;
  // Canvas 2D `font` does not resolve CSS variables — read the resolved family
  // from the DOM so the Y-axis labels use the same monospace stack as the rest
  // of the UI (otherwise it silently falls back to the canvas default).
  ctx.font = `10px ${monoFontStack}`;

  if (showXRuler.value) {
    drawXRuler(ctx, {
      axisColor,
      gridColor,
      rulerColor,
      plotX0,
      plotX1,
      plotBottom,
      plotH,
      plotTop,
      plotW,
      firstTimestamp,
      timeSpan,
      hasTimeScale,
      originTimestamp,
    });
  }

  if (showYRuler.value) {
    drawYRuler(ctx, {
      axisColor,
      rulerColor,
      leftPad,
      plotX0,
      plotTop,
      plotBottom,
      plotH,
      vMin,
      vMax,
    });
  }

  const visiblePaths = buildVisibleChannelPaths(buffer, ingest.channelState.value, channelLabel, {
    channelCount,
    endMs: visibleEndMs,
    plotBottom,
    plotH,
    sampleX,
    scanEndIndex: visibleWindow.scanEndIndex,
    scanStartIndex: visibleWindow.scanStartIndex,
    span,
    startMs: visibleStartMs,
    vMin,
  });

  drawWaveformPaths(ctx, visiblePaths);

  if (showSamplePoints.value) {
    drawSamplePoints(ctx, {
      outlineColor: samplePointOutline,
      paths: visiblePaths,
    });
  }

  const hoverPoint = showHoverRuler.value
    ? findHoverPoint({
        cursor: viewport.currentHoverCursor(),
        originTimestamp,
        paths: visiblePaths,
        plotTop,
        plotX0,
        plotX1,
        plotBottom,
      })
    : null;
  if (hoverPoint) {
    drawHoverRuler(ctx, {
      point: hoverPoint,
      cssW,
      cssH,
      plotX0,
      plotX1,
      plotTop,
      plotBottom,
      lineColor: hoverLineColor,
      bgColor: hoverBg,
      textColor: hoverText,
    });
  }
}

function observeCanvasResize() {
  const canvas = canvasRef.value;
  if (!canvas || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(canvas);
}

let themeObserver: MutationObserver | null = null;
let dprMediaQuery: MediaQueryList | null = null;

function observeThemeChanges() {
  if (typeof MutationObserver === 'undefined') return;
  // Plot colors are read from CSS variables at render time, so a theme switch
  // must trigger a redraw — otherwise the plot keeps the old palette until
  // the next frame of data or pointer interaction.
  themeObserver = new MutationObserver(() => scheduleRender());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

function observeDevicePixelRatio() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  // Dragging between displays can change the DPR without a CSS resize, so
  // ResizeObserver alone would leave a stale backing-store scale (blurry
  // canvas). Re-arm the query at the new ratio on every change.
  dprMediaQuery?.removeEventListener('change', observeDevicePixelRatio);
  dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprMediaQuery.addEventListener('change', observeDevicePixelRatio, { once: true });
  scheduleRender();
}

watch(
  () => props.channelLabels,
  () => scheduleRender(),
);

onMounted(() => {
  observeCanvasResize();
  observeThemeChanges();
  observeDevicePixelRatio();
  ingest.hydrateSharedWaveform();
  if (ingest.ingestNewFrames()) ingest.invalidateWaveform();
  else scheduleRender();
});

onUnmounted(() => {
  cancelScheduledRender();
  viewport.resetWheelGesture();
  resizeObserver?.disconnect();
  resizeObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
  dprMediaQuery?.removeEventListener('change', observeDevicePixelRatio);
  dprMediaQuery = null;
});
</script>

<style scoped>
.waveform-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.waveform-canvas {
  flex: 1;
  width: 100%;
  display: block;
  min-height: 0;
  touch-action: none;
  user-select: none;
}

.waveform-canvas.hover-ruler-enabled {
  cursor: crosshair;
}

.waveform-canvas.is-draggable {
  cursor: grab;
}

.waveform-canvas.hover-ruler-enabled.is-draggable {
  cursor: crosshair;
}

.waveform-canvas.is-dragging,
.waveform-canvas.hover-ruler-enabled.is-dragging {
  cursor: grabbing;
}
</style>
