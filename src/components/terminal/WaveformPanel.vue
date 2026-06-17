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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import type { DataFrame } from '../../types';
import { t } from '../../lib/i18n';
import {
  channelStats,
  closestPointOnWaveformPath,
  createBuffer,
  buildWaveformCsv,
  formatWaveformNumber,
  ingestWaveformTextFrames,
  normalizeWaveformTimeViewport,
  panWaveformTimeViewport,
  panWaveformTimeViewportByMs,
  planWaveformFrameIngest,
  pushRegisterWaveformSample,
  scaleWaveformTimeViewport,
  syncWaveformTimeViewportAfterSampleChange,
  thinWaveformSamplePoints,
  visibleChannelRange,
  waveformFrameCursorAtEnd,
  waveformTimeRange,
  DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  type ChannelStats,
  type WaveformFrameCursor,
  type WaveformChannelState,
  type WaveformPathPoint,
  type WaveformPanDirection,
  type WaveformTimeViewport,
  type WaveformZoomDirection,
} from '../../lib/waveform';
import { parseStream } from '../../lib/modbus';
import WaveformLegend from './WaveformLegend.vue';

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
}>();

defineEmits<{ (e: 'toggleMode'): void }>();

const message = useMessage();
const canvasRef = ref<HTMLCanvasElement | null>(null);

const CAPACITY = 600;
const buffer = createBuffer(CAPACITY);

const channelState = ref<WaveformChannelState[]>([]);
const showXRuler = ref(true);
const showYRuler = ref(true);
const showHoverRuler = ref(true);
const showSamplePoints = ref(false);
const dragging = ref(false);
const waveformVersion = ref(0);
const timeViewport = ref<WaveformTimeViewport>(fullTimeViewport());

let frameCursor: WaveformFrameCursor = { consumed: 0, lastFrameId: null };
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
function pushRegisterSample(channel: number, value: number, timestamp = Date.now()) {
  const previousTimestamps = buffer.timestamps.slice();
  const result = pushRegisterWaveformSample(
    buffer,
    channelState.value,
    channel,
    value,
    paused.value,
    timestamp,
  );
  channelState.value = result.channels;
  if (result.pushed) {
    syncViewportAfterSampleChange(previousTimestamps);
    invalidateWaveform();
  }
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
        pushRegisterSample(rec.ch, rec.value, rec.t);
      }
    }
    message.success(t('waveform.exportedStream', { count: records.length }));
  };
  reader.readAsText(file);
  input.value = '';
}

function ingestNewFrames(): boolean {
  // Register mode is fed imperatively by the master (pushRegisterSample); the
  // text-parsing path only runs in text mode.
  if ((props.mode ?? 'text') === 'register') {
    frameCursor = waveformFrameCursorAtEnd(props.frames);
    return false;
  }

  const previousChannelCount = channelState.value.length;
  const previousTimestamps = buffer.timestamps.slice();
  const plan = planWaveformFrameIngest(props.frames, frameCursor);
  frameCursor = plan.nextCursor;
  if (plan.reset) resetWaveformBuffer({ clearChannels: true });
  if (plan.startIndex >= props.frames.length) return plan.reset;

  const result = ingestWaveformTextFrames(buffer, props.frames, {
    startIndex: plan.startIndex,
    direction: props.direction ?? 'RX',
    paused: paused.value,
    channels: channelState.value,
  });
  channelState.value = result.channels;
  frameCursor = waveformFrameCursorAtEnd(props.frames);
  if (!plan.reset && result.pushedSamples > 0) {
    syncViewportAfterSampleChange(previousTimestamps);
  }
  return plan.reset || result.pushedSamples > 0 || result.channels.length !== previousChannelCount;
}

function toggleChannel(i: number) {
  const next = channelState.value.slice();
  if (next[i]) next[i] = { ...next[i], visible: !next[i].visible };
  channelState.value = next;
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

function zoomViewport(direction: WaveformZoomDirection) {
  resetWheelGesture();
  if (buffer.timestamps.length === 0) return;
  const next = scaleWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    0.5,
    direction === 'in' ? 0.5 : 2,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const range = waveformTimeRange(buffer.timestamps);
  timeViewport.value =
    direction === 'out' && range && next.durationMs >= range.durationMs ? fullTimeViewport() : next;
  scheduleRender();
}

function panViewport(direction: WaveformPanDirection) {
  resetWheelGesture();
  if (buffer.timestamps.length === 0) return;
  timeViewport.value = panWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    direction,
    0.25,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  scheduleRender();
}

function clearBuffer() {
  frameCursor = waveformFrameCursorAtEnd(props.frames);
  resetWaveformBuffer({ clearChannels: true });
  invalidateWaveform();
}

function resetWaveformBuffer(options: { clearChannels: boolean }) {
  buffer.samples.length = 0;
  buffer.timestamps.length = 0;
  buffer.originTimestamp = null;
  buffer.totalDroppedSamples = 0;
  hoverCursor = null;
  timeViewport.value = fullTimeViewport();
  if (options.clearChannels) {
    channelState.value = [];
  } else {
    channelState.value = channelState.value.map((channel) => ({ ...channel, latest: null }));
  }
}

const sampleCountView = computed(() => {
  void waveformVersion.value;
  return buffer.samples.length;
});

const viewportView = computed(() => {
  void waveformVersion.value;
  return normalizeWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
});

const canZoomIn = computed(() => {
  const view = viewportView.value;
  return view.durationMs > DEFAULT_WAVEFORM_VIEWPORT_MIN_MS;
});

const canZoomOut = computed(() => {
  const range = waveformTimeRange(buffer.timestamps);
  return Boolean(range && viewportView.value.durationMs < range.durationMs);
});
const canPanLeft = computed(() => {
  const range = waveformTimeRange(buffer.timestamps);
  return Boolean(range && viewportView.value.startMs > range.startMs);
});
const canPanRight = computed(() => {
  const range = waveformTimeRange(buffer.timestamps);
  if (!range) return false;
  const view = viewportView.value;
  return view.startMs + view.durationMs < range.endMs;
});

const statsView = computed<ChannelStats[]>(() => {
  void waveformVersion.value;
  return channelStats(buffer, channelState.value.length);
});

function invalidateWaveform() {
  waveformVersion.value += 1;
  scheduleRender();
}

function fullTimeViewport(): WaveformTimeViewport {
  return { startMs: 0, durationMs: Number.POSITIVE_INFINITY };
}

function syncViewportAfterSampleChange(previousTimestamps: readonly number[]) {
  if (!Number.isFinite(timeViewport.value.durationMs)) {
    timeViewport.value = fullTimeViewport();
    return;
  }
  timeViewport.value = syncWaveformTimeViewportAfterSampleChange(
    timeViewport.value,
    previousTimestamps,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
}

function formatNum(n: number): string {
  return formatWaveformNumber(n);
}

// Canvas redraws are demand-driven and coalesced into one RAF. This keeps the
// waveform idle at 0fps when no data or pointer interaction changes the view.
let rafId: number | null = null;
let hoverCursor: { x: number; y: number } | null = null;
let resizeObserver: ResizeObserver | null = null;
let dragState: CanvasDragState | null = null;
let wheelGestureResetTimer: number | null = null;

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_DOMINANCE_RATIO = 1.25;
const WHEEL_GESTURE_IDLE_MS = 180;

type CanvasWheelIntent = 'pan' | 'zoom';

interface CanvasDragState {
  pointerId: number;
  lastClientX: number;
}

interface PlotLayout {
  leftPad: number;
  plotX0: number;
  plotX1: number;
  plotTop: number;
  plotBottom: number;
  plotW: number;
  plotH: number;
  topPad: number;
  bottomPad: number;
  rightPad: number;
}

function onCanvasPointerDown(e: PointerEvent) {
  if (e.button !== 0 || buffer.samples.length === 0) return;
  const canvas = canvasRef.value;
  if (!canvas) return;
  resetWheelGesture();
  updateHoverCursor(e);
  dragState = {
    pointerId: e.pointerId,
    lastClientX: e.clientX,
  };
  dragging.value = true;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onCanvasPointerMove(e: PointerEvent) {
  updateHoverCursor(e);
  if (dragState?.pointerId === e.pointerId) {
    const deltaX = e.clientX - dragState.lastClientX;
    dragState.lastClientX = e.clientX;
    const moved = deltaX !== 0 && panViewportByCanvasPixels(-deltaX);
    if (!moved && showHoverRuler.value) scheduleRender();
    e.preventDefault();
    return;
  }
  if (showHoverRuler.value) scheduleRender();
}

function onCanvasPointerLeave() {
  if (dragState) return;
  clearHoverCursor();
}

function onCanvasPointerUp(e: PointerEvent) {
  endCanvasDrag(e);
}

function onCanvasPointerCancel(e: PointerEvent) {
  endCanvasDrag(e);
  clearHoverCursor();
}

function onCanvasPointerCaptureLost(e: PointerEvent) {
  endCanvasDrag(e);
}

function onCanvasWheel(e: WheelEvent) {
  const canvas = canvasRef.value;
  if (!canvas || buffer.samples.length === 0) return;
  updateHoverCursor(e);
  const layout = currentPlotLayout(canvas);
  const rect = canvas.getBoundingClientRect();
  const anchorRatio = clampRatio((e.clientX - rect.left - layout.plotX0) / layout.plotW);
  const deltaX = normalizeWheelDelta(e.deltaX, e.deltaMode, canvas.clientWidth);
  const deltaY = normalizeWheelDelta(e.deltaY, e.deltaMode, canvas.clientHeight);
  const intent = wheelIntentFromDelta(deltaX, deltaY, e);
  if (!intent) return;
  beginWheelGesture();

  if (intent === 'pan') {
    const panDelta = e.shiftKey && Math.abs(deltaX) < Math.abs(deltaY) ? deltaY : deltaX;
    panViewportByCanvasPixels(panDelta);
    return;
  }

  if (deltaY !== 0) {
    const exponent = clampNumber(deltaY * WHEEL_ZOOM_SENSITIVITY, -0.75, 0.75);
    scaleViewportAtRatio(anchorRatio, Math.exp(exponent));
  }
}

function updateHoverCursor(e: Pick<MouseEvent, 'clientX' | 'clientY'>) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  hoverCursor = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function clearHoverCursor() {
  if (!hoverCursor) return;
  hoverCursor = null;
  if (showHoverRuler.value) scheduleRender();
}

function endCanvasDrag(e: PointerEvent) {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const canvas = canvasRef.value;
  if (canvas?.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  dragState = null;
  dragging.value = false;
  if (showHoverRuler.value) scheduleRender();
}

function panViewportByCanvasPixels(pixelDelta: number): boolean {
  const canvas = canvasRef.value;
  if (!canvas || buffer.timestamps.length === 0) return false;
  const view = normalizeWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const range = waveformTimeRange(buffer.timestamps);
  if (!range || view.durationMs >= range.durationMs) return false;
  const layout = currentPlotLayout(canvas);
  const next = panWaveformTimeViewportByMs(
    timeViewport.value,
    buffer.timestamps,
    (pixelDelta / layout.plotW) * view.durationMs,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  if (next.startMs === view.startMs && next.durationMs === view.durationMs) return false;
  timeViewport.value = next;
  scheduleRender();
  return true;
}

function scaleViewportAtRatio(anchorRatio: number, scale: number): boolean {
  if (buffer.timestamps.length === 0) return false;
  const previous = normalizeWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const next = scaleWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    anchorRatio,
    scale,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const range = waveformTimeRange(buffer.timestamps);
  const nextViewport =
    scale > 1 && range && next.durationMs >= range.durationMs ? fullTimeViewport() : next;
  const normalizedNext = normalizeWaveformTimeViewport(
    nextViewport,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  if (
    previous.startMs === normalizedNext.startMs &&
    previous.durationMs === normalizedNext.durationMs
  ) {
    return false;
  }
  timeViewport.value = nextViewport;
  scheduleRender();
  return true;
}

function wheelIntentFromDelta(
  deltaX: number,
  deltaY: number,
  event: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
): CanvasWheelIntent | null {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX === 0 && absY === 0) return null;
  if (event.ctrlKey || event.metaKey) return 'zoom';
  if (event.shiftKey && absY > 0 && absX < absY) return 'pan';
  if (absX > 0 && absX >= absY * WHEEL_DOMINANCE_RATIO) return 'pan';
  if (absY > 0) return 'zoom';
  return 'pan';
}

function beginWheelGesture() {
  if (wheelGestureResetTimer !== null) {
    window.clearTimeout(wheelGestureResetTimer);
  }
  wheelGestureResetTimer = window.setTimeout(() => {
    resetWheelGesture();
  }, WHEEL_GESTURE_IDLE_MS);
}

function resetWheelGesture() {
  if (wheelGestureResetTimer !== null) {
    window.clearTimeout(wheelGestureResetTimer);
    wheelGestureResetTimer = null;
  }
}

function currentPlotLayout(canvas: HTMLCanvasElement): PlotLayout {
  return calculatePlotLayout(canvas.clientWidth, canvas.clientHeight);
}

function calculatePlotLayout(cssW: number, cssH: number): PlotLayout {
  const leftPad = showYRuler.value ? 52 : 12;
  const topPad = 12;
  const bottomPad = showXRuler.value ? 30 : 16;
  const rightPad = 8;
  const plotX0 = leftPad;
  const plotTop = topPad;
  const plotBottom = Math.max(plotTop + 1, cssH - bottomPad);
  const plotH = plotBottom - plotTop;
  const plotX1 = Math.max(plotX0 + 1, cssW - rightPad);
  const plotW = plotX1 - plotX0;
  return {
    leftPad,
    plotX0,
    plotX1,
    plotTop,
    plotBottom,
    plotW,
    plotH,
    topPad,
    bottomPad,
    rightPad,
  };
}

function normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * Math.max(1, pageSize);
  return delta;
}

function clampRatio(value: number): number {
  return clampNumber(value, 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
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
  refreshMonoFont();
  const gridColor = readCssVar('--grid-line', 'rgba(255,255,255,0.04)');
  const axisColor = readCssVar('--text-dim', 'rgba(255,255,255,0.3)');
  const rulerColor = readCssVar('--border-color', 'rgba(255,255,255,0.1)');
  const hoverLineColor = readCssVar('--color-warning', '#ffd84d');
  const hoverBg = readCssVar('--bg-elevated', 'rgba(24,28,34,0.94)');
  const hoverText = readCssVar('--text-primary', '#eef3f7');
  const samplePointOutline = readCssVar('--bg-inset', '#11161c');
  const { leftPad, plotX0, plotX1, plotTop, plotBottom, plotW, plotH } = calculatePlotLayout(
    cssW,
    cssH,
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

  const channelCount = channelState.value.length;
  if (channelCount === 0 || buffer.samples.length === 0) {
    return;
  }

  const activeViewport = normalizeWaveformTimeViewport(
    timeViewport.value,
    buffer.timestamps,
    DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  );
  const visibleStartMs = activeViewport.startMs;
  const visibleEndMs = visibleStartMs + activeViewport.durationMs;
  const [vMin, vMax] = visibleChannelRange(
    buffer,
    channelCount,
    channelState.value.map((channel) => channel.visible),
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

  const visiblePaths = buildVisibleChannelPaths({
    channelCount,
    endMs: visibleEndMs,
    plotBottom,
    plotH,
    sampleX,
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
        cursor: hoverCursor,
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

function sampleTimestamp(index: number): number {
  const timestamp = buffer.timestamps[index];
  return Number.isFinite(timestamp) ? timestamp : index;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value)}ms`;
}

interface HoverPoint {
  x: number;
  y: number;
  relativeMs: number;
  value: number;
  color: string;
  label: string;
}

interface RenderedChannelPath {
  color: string;
  label: string;
  points: WaveformPathPoint[];
  samplePoints: WaveformPathPoint[];
}

interface BuildChannelPathOptions {
  channelCount: number;
  endMs: number;
  plotBottom: number;
  plotH: number;
  sampleX: (timestamp: number) => number;
  span: number;
  startMs: number;
  vMin: number;
}

interface HoverPointOptions {
  cursor: { x: number; y: number } | null;
  originTimestamp: number;
  paths: RenderedChannelPath[];
  plotTop: number;
  plotX0: number;
  plotX1: number;
  plotBottom: number;
}

function buildVisibleChannelPaths(options: BuildChannelPathOptions): RenderedChannelPath[] {
  const { channelCount, endMs, plotBottom, plotH, sampleX, span, startMs, vMin } = options;
  const paths: RenderedChannelPath[] = [];
  for (let c = 0; c < channelCount; c += 1) {
    const channel = channelState.value[c];
    if (!channel?.visible) continue;
    const points: WaveformPathPoint[] = [];
    const samplePoints: WaveformPathPoint[] = [];
    let previous: { timestamp: number; value: number } | null = null;

    for (let i = 0; i < buffer.samples.length; i += 1) {
      const value = buffer.samples[i][c];
      if (value === undefined || !Number.isFinite(value)) continue;
      const timestamp = sampleTimestamp(i);
      if (!Number.isFinite(timestamp)) continue;
      const current = { timestamp, value };

      if (previous && current.timestamp >= startMs && previous.timestamp <= endMs) {
        addInterpolatedSegmentPoints(points, previous, current, {
          endMs,
          plotBottom,
          plotH,
          sampleX,
          span,
          startMs,
          vMin,
        });
      } else if (!previous && timestamp >= startMs && timestamp <= endMs) {
        points.push(toRenderedPoint(current, { plotBottom, plotH, sampleX, span, vMin }));
      }

      if (timestamp >= startMs && timestamp <= endMs) {
        samplePoints.push(toRenderedPoint(current, { plotBottom, plotH, sampleX, span, vMin }));
      }

      previous = current;
    }
    if (points.length > 0) {
      paths.push({
        color: channel.color,
        label: channelLabel(c),
        points,
        samplePoints,
      });
    }
  }
  return paths;
}

interface SegmentPoint {
  timestamp: number;
  value: number;
}

interface RenderPointOptions {
  plotBottom: number;
  plotH: number;
  sampleX: (timestamp: number) => number;
  span: number;
  vMin: number;
}

interface SegmentClipOptions extends RenderPointOptions {
  startMs: number;
  endMs: number;
}

function addInterpolatedSegmentPoints(
  out: WaveformPathPoint[],
  a: SegmentPoint,
  b: SegmentPoint,
  options: SegmentClipOptions,
) {
  if (b.timestamp < options.startMs || a.timestamp > options.endMs) return;
  const from = Math.max(a.timestamp, options.startMs);
  const to = Math.min(b.timestamp, options.endMs);
  if (from > to) return;
  pushRenderedPoint(out, interpolateSegmentPoint(a, b, from), options);
  if (to !== from) {
    pushRenderedPoint(out, interpolateSegmentPoint(a, b, to), options);
  }
}

function interpolateSegmentPoint(
  a: SegmentPoint,
  b: SegmentPoint,
  timestamp: number,
): SegmentPoint {
  const duration = b.timestamp - a.timestamp;
  const ratio = duration === 0 ? 0 : (timestamp - a.timestamp) / duration;
  return {
    timestamp,
    value: a.value + (b.value - a.value) * Math.max(0, Math.min(1, ratio)),
  };
}

function pushRenderedPoint(
  out: WaveformPathPoint[],
  point: SegmentPoint,
  options: RenderPointOptions,
) {
  const last = out[out.length - 1];
  if (last && Math.abs(last.timestamp - point.timestamp) < 0.0001) {
    out[out.length - 1] = toRenderedPoint(point, options);
    return;
  }
  out.push(toRenderedPoint(point, options));
}

function toRenderedPoint(point: SegmentPoint, options: RenderPointOptions): WaveformPathPoint {
  return {
    x: options.sampleX(point.timestamp),
    y: options.plotBottom - ((point.value - options.vMin) / options.span) * options.plotH,
    value: point.value,
    timestamp: point.timestamp,
  };
}

function drawWaveformPaths(ctx: CanvasRenderingContext2D, paths: readonly RenderedChannelPath[]) {
  ctx.lineWidth = 1.5;
  for (const path of paths) {
    ctx.strokeStyle = path.color;
    ctx.beginPath();
    for (let i = 0; i < path.points.length; i += 1) {
      const point = path.points[i];
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }
}

function findHoverPoint(options: HoverPointOptions): HoverPoint | null {
  const { cursor, originTimestamp, paths, plotTop, plotX0, plotX1, plotBottom } = options;
  if (!cursor) return null;
  if (cursor.x < plotX0 || cursor.x > plotX1 || cursor.y < plotTop || cursor.y > plotBottom) {
    return null;
  }

  let best: HoverPoint | null = null;
  let bestDistance = Infinity;
  for (const path of paths) {
    const projected = closestPointOnWaveformPath(cursor, path.points);
    if (!projected || projected.distanceSq >= bestDistance) continue;
    bestDistance = projected.distanceSq;
    best = {
      x: projected.x,
      y: projected.y,
      value: projected.value,
      color: path.color,
      label: path.label,
      relativeMs: projected.timestamp - originTimestamp,
    };
  }
  return best;
}

interface SamplePointDrawOptions {
  outlineColor: string;
  paths: readonly RenderedChannelPath[];
}

function drawSamplePoints(ctx: CanvasRenderingContext2D, options: SamplePointDrawOptions) {
  const { outlineColor, paths } = options;
  const radius = 3;
  const haloRadius = radius + 1.2;
  const renderPaths = paths.map((path) => ({
    ...path,
    samplePoints: thinWaveformSamplePoints(path.samplePoints),
  }));

  ctx.save();
  for (const path of renderPaths) {
    for (const point of path.samplePoints) {
      ctx.fillStyle = outlineColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, haloRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const path of renderPaths) {
    ctx.fillStyle = path.color;
    for (const point of path.samplePoints) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

interface HoverRulerDrawOptions {
  point: HoverPoint;
  cssW: number;
  cssH: number;
  plotX0: number;
  plotX1: number;
  plotTop: number;
  plotBottom: number;
  lineColor: string;
  bgColor: string;
  textColor: string;
}

function drawHoverRuler(ctx: CanvasRenderingContext2D, options: HoverRulerDrawOptions) {
  const { point, cssW, cssH, plotX0, plotX1, plotTop, plotBottom, lineColor, bgColor, textColor } =
    options;

  ctx.save();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(point.x, plotTop);
  ctx.lineTo(point.x, plotBottom);
  ctx.moveTo(plotX0, point.y);
  ctx.lineTo(plotX1, point.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = lineColor;
  ctx.strokeStyle = bgColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const maxTextW = Math.max(44, Math.min(220, cssW - 28));
  const lines = [
    point.label,
    `x: ${formatMs(point.relativeMs)}`,
    `y: ${formatNum(point.value)}`,
  ].map((line) => truncateCanvasText(ctx, line, maxTextW));
  const paddingX = 8;
  const paddingY = 6;
  const lineHeight = 14;
  const boxW = Math.ceil(
    Math.max(...lines.map((line) => ctx.measureText(line).width)) + paddingX * 2,
  );
  const boxH = paddingY * 2 + lineHeight * lines.length;
  let boxX = point.x + 10;
  let boxY = point.y - boxH - 10;
  if (boxX + boxW > cssW - 6) boxX = point.x - boxW - 10;
  if (boxY < 6) boxY = point.y + 10;
  if (boxY + boxH > cssH - 6) boxY = cssH - boxH - 6;
  boxX = Math.max(6, Math.min(Math.max(6, cssW - boxW - 6), boxX));
  boxY = Math.max(6, Math.min(Math.max(6, cssH - boxH - 6), boxY));

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = lineColor;
  drawRoundRect(ctx, boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, index) => {
    ctx.fillText(line, boxX + paddingX, boxY + paddingY + index * lineHeight);
  });
  ctx.restore();
}

function truncateCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = '...';
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}${suffix}`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}${suffix}`;
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

interface XRulerDrawOptions {
  axisColor: string;
  gridColor: string;
  rulerColor: string;
  plotX0: number;
  plotX1: number;
  plotBottom: number;
  plotH: number;
  plotTop: number;
  plotW: number;
  firstTimestamp: number;
  timeSpan: number;
  hasTimeScale: boolean;
  originTimestamp: number;
}

function drawXRuler(ctx: CanvasRenderingContext2D, options: XRulerDrawOptions) {
  const {
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
  } = options;

  ctx.save();
  ctx.strokeStyle = rulerColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0, plotBottom);
  ctx.lineTo(plotX1, plotBottom);
  ctx.stroke();

  const tickCount = hasTimeScale ? 5 : 1;
  for (let g = 0; g < tickCount; g += 1) {
    const ratio = tickCount === 1 ? 0 : g / (tickCount - 1);
    const x = plotX0 + plotW * ratio;
    const timestamp = hasTimeScale ? firstTimestamp + timeSpan * ratio : firstTimestamp;
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotTop + plotH);
    ctx.stroke();

    ctx.strokeStyle = rulerColor;
    ctx.beginPath();
    ctx.moveTo(x, plotBottom);
    ctx.lineTo(x, plotBottom + 4);
    ctx.stroke();

    ctx.fillStyle = axisColor;
    ctx.textBaseline = 'top';
    ctx.textAlign = g === 0 ? 'left' : g === tickCount - 1 ? 'right' : 'center';
    ctx.fillText(formatMs(timestamp - originTimestamp), x, plotBottom + 7);
  }
  ctx.restore();
}

interface YRulerDrawOptions {
  axisColor: string;
  rulerColor: string;
  leftPad: number;
  plotX0: number;
  plotTop: number;
  plotBottom: number;
  plotH: number;
  vMin: number;
  vMax: number;
}

function drawYRuler(ctx: CanvasRenderingContext2D, options: YRulerDrawOptions) {
  const { axisColor, rulerColor, leftPad, plotX0, plotTop, plotBottom, plotH, vMin, vMax } =
    options;

  ctx.save();
  ctx.strokeStyle = rulerColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0, plotTop);
  ctx.lineTo(plotX0, plotBottom);
  ctx.stroke();

  ctx.fillStyle = axisColor;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g += 1) {
    const y = plotTop + (plotH / 4) * g;
    const v = vMax - ((vMax - vMin) * g) / 4;
    ctx.strokeStyle = rulerColor;
    ctx.beginPath();
    ctx.moveTo(plotX0 - 4, y);
    ctx.lineTo(plotX0, y);
    ctx.stroke();
    ctx.fillText(formatNum(v), leftPad - 8, y);
  }
  ctx.restore();
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

function observeCanvasResize() {
  const canvas = canvasRef.value;
  if (!canvas || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(canvas);
}

watch(
  () => [props.framesVersion, props.frames.length] as const,
  () => {
    if (ingestNewFrames()) invalidateWaveform();
  },
);

watch(
  () => [props.mode ?? 'text', props.direction ?? 'RX'] as const,
  () => {
    frameCursor = waveformFrameCursorAtEnd(props.frames);
    resetWaveformBuffer({ clearChannels: true });
    invalidateWaveform();
  },
);

watch(
  () => props.channelLabels,
  () => scheduleRender(),
);

onMounted(() => {
  observeCanvasResize();
  if (ingestNewFrames()) invalidateWaveform();
  else scheduleRender();
});

onUnmounted(() => {
  cancelScheduledRender();
  resetWheelGesture();
  resizeObserver?.disconnect();
  resizeObserver = null;
});

function exportCsv() {
  const samples = buffer.samples;
  if (samples.length === 0) return;
  const channelCount = channelState.value.length;
  const blob = new Blob([buildWaveformCsv(samples, channelCount)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bbcom-waveform-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  message.success(t('waveform.exported', { count: samples.length }));
}
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
