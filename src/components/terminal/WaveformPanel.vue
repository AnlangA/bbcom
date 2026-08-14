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
} from '../../types';
import { SESSION_WAVEFORM_MAX_GROUPS } from '../../types';
import { t } from '../../lib/i18n';
import {
  channelStats,
  createBuffer,
  buildWaveformCsv,
  ensureWaveformChannels,
  ingestWaveformTextFrames,
  normalizeWaveformTimeViewport,
  panWaveformTimeViewport,
  panWaveformTimeViewportByMs,
  planWaveformFrameIngest,
  pushSample,
  pushRegisterWaveformSample,
  scaleWaveformTimeViewport,
  syncWaveformTimeViewportAfterSampleChange,
  visibleChannelRangeInWindow,
  waveformFrameCursorAtEnd,
  waveformSampleIndexWindow,
  waveformTimeRange,
  DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  type ChannelStats,
  type WaveformFrameCursor,
  type WaveformChannelState,
  type WaveformPanDirection,
  type WaveformTimeViewport,
  type WaveformZoomDirection,
} from '../../lib/waveform';
import {
  buildVisibleChannelPaths,
  calculatePlotLayout,
  clampNumber,
  clampRatio,
  drawHoverRuler,
  drawSamplePoints,
  drawWaveformPaths,
  drawXRuler,
  drawYRuler,
  findHoverPoint,
  formatNum,
  monoFontStack,
  normalizeWheelDelta,
  readWaveformTheme,
  wheelIntentFromDelta,
  type PlotLayout,
} from '../../lib/waveform-render';
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

const CAPACITY = SESSION_WAVEFORM_MAX_GROUPS;
const buffer = createBuffer(CAPACITY);
const waveformVersion = ref(0);
const accessibleSampleRows = computed(() => {
  void waveformVersion.value;
  const start = Math.max(0, buffer.timestamps.length - 100);
  return buffer.timestamps.slice(start).map((timestamp, offset) => ({
    timestamp,
    values: Array.from({ length: 8 }, (_, channel) => {
      const value = buffer.samples[start + offset]?.[channel];
      return value === undefined || !Number.isFinite(value) ? '' : formatNum(value);
    }),
  }));
});

const channelState = ref<WaveformChannelState[]>([]);
const showXRuler = ref(true);
const showYRuler = ref(true);
const showHoverRuler = ref(true);
const showSamplePoints = ref(false);
const dragging = ref(false);
const timeViewport = ref<WaveformTimeViewport>(fullTimeViewport());

let frameCursor: WaveformFrameCursor = { ...props.waveform.frameCursor };
// When paused, new frames are still consumed (so the offset stays aligned) but
// their samples are dropped — freezing the plot at its last position.
const paused = ref(false);

interface RegisterWaveformSampleInput {
  channel: number;
  value: number;
  timestamp?: number;
}

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
  pushRegisterSamples([{ channel, value, timestamp }]);
}

function pushRegisterSamples(samples: readonly RegisterWaveformSampleInput[]) {
  if (samples.length === 0 || props.canAppend === false) return;
  const previousTimestamps = buffer.timestamps.slice();
  let channels = channelState.value;
  let pushedSamples = 0;
  for (const sample of samples) {
    if (!Number.isInteger(sample.channel) || sample.channel < 0 || sample.channel > 7) continue;
    const result = pushRegisterWaveformSample(
      buffer,
      channels,
      sample.channel,
      sample.value,
      paused.value,
      sample.timestamp,
    );
    channels = result.channels;
    if (result.pushed) pushedSamples += 1;
  }
  channelState.value = channels;
  if (pushedSamples > 0) {
    emit('appendSamples', waveformInputsFromRecentRows(pushedSamples));
    syncViewportAfterSampleChange(previousTimestamps);
    invalidateWaveform();
  }
}

defineExpose({ pushRegisterSample, pushRegisterSamples });

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
    const samples: RegisterWaveformSampleInput[] = [];
    for (const rec of records) {
      if (typeof rec.ch === 'number' && rec.ch >= 0) {
        samples.push({ channel: rec.ch, value: rec.value, timestamp: rec.t });
      }
    }
    if (samples.length === 0) {
      message.warning(t('waveform.noData'));
      return;
    }
    pushRegisterSamples(samples);
    message.success(t('waveform.exportedStream', { count: samples.length }));
  };
  reader.readAsText(file);
  input.value = '';
}

function ingestNewFrames(): boolean {
  // Register mode is fed imperatively by the master (pushRegisterSample); the
  // text-parsing path only runs in text mode.
  if ((props.mode ?? 'text') === 'register') {
    frameCursor = waveformFrameCursorAtEnd(props.frames);
    if (props.canAppend !== false) emit('updateFrameCursor', frameCursor);
    return false;
  }

  if (props.canAppend === false) return false;

  const previousChannelCount = channelState.value.length;
  const previousTimestamps = buffer.timestamps.slice();
  const plan = planWaveformFrameIngest(props.frames, frameCursor);
  frameCursor = plan.nextCursor;
  if (plan.reset) resetWaveformBuffer({ clearChannels: true });
  if (plan.startIndex >= props.frames.length) {
    emit('commitFrameIngest', {
      mode: plan.reset ? 'replace' : 'append',
      samples: [],
      cursor: frameCursor,
    });
    return plan.reset;
  }

  const result = ingestWaveformTextFrames(buffer, props.frames, {
    startIndex: plan.startIndex,
    direction: props.direction ?? 'RX',
    paused: paused.value,
    channels: channelState.value,
  });
  channelState.value = result.channels;
  frameCursor = waveformFrameCursorAtEnd(props.frames);
  emit('commitFrameIngest', {
    mode: plan.reset ? 'replace' : 'append',
    samples:
      result.pushedSamples > 0
        ? plan.reset
          ? waveformInputsFromRows(0)
          : waveformInputsFromRecentRows(result.pushedSamples)
        : [],
    cursor: frameCursor,
  });
  if (!plan.reset && result.pushedSamples > 0) {
    syncViewportAfterSampleChange(previousTimestamps);
  }
  return plan.reset || result.pushedSamples > 0 || result.channels.length !== previousChannelCount;
}

function toggleChannel(i: number) {
  if (props.canEdit === false) return;
  const next = channelState.value.slice();
  if (next[i]) {
    const visible = !next[i].visible;
    next[i] = { ...next[i], visible };
    emit('setChannelVisibility', i, visible);
  }
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
  if (props.canEdit === false) return;
  frameCursor = waveformFrameCursorAtEnd(props.frames);
  emit('clear', frameCursor);
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

function waveformInputsFromRecentRows(rowCount: number): SessionWaveformSampleInput[] {
  return waveformInputsFromRows(Math.max(0, buffer.samples.length - rowCount));
}

function waveformInputsFromRows(startIndex: number): SessionWaveformSampleInput[] {
  const inputs: SessionWaveformSampleInput[] = [];
  for (let rowIndex = Math.max(0, startIndex); rowIndex < buffer.samples.length; rowIndex += 1) {
    const row = buffer.samples[rowIndex];
    const timestampMs = Math.max(0, Math.round(buffer.timestamps[rowIndex] ?? 0));
    const group = rowIndex - Math.max(0, startIndex);
    for (let channelIndex = 0; channelIndex < Math.min(row.length, 8); channelIndex += 1) {
      const value = row[channelIndex];
      if (!Number.isFinite(value)) continue;
      inputs.push({ channelIndex, group, timestampMs, value });
    }
  }
  return inputs;
}

/** Rebuild the bounded canvas cache from the session-owned durable rows. */
function hydrateSharedWaveform(): void {
  resetWaveformBuffer({ clearChannels: true });
  frameCursor = { ...props.waveform.frameCursor };
  const maximumChannel = props.waveform.channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.channelIndex),
    -1,
  );
  let channels = ensureWaveformChannels([], maximumChannel + 1);
  for (const persisted of props.waveform.channels) {
    const fallback = channels[persisted.channelIndex];
    if (!fallback) continue;
    const color =
      typeof persisted.config.color === 'string' && persisted.config.color.length > 0
        ? persisted.config.color
        : fallback.color;
    channels[persisted.channelIndex] = {
      color,
      latest: null,
      visible: persisted.config.visible !== false,
    };
  }

  const orderedSamples = [...props.waveform.samples].sort(
    (left, right) =>
      left.seq - right.seq ||
      left.timestampMs - right.timestampMs ||
      left.channelIndex - right.channelIndex,
  );
  const latest = Array.from({ length: channels.length }, () => 0);
  const sampledChannels = new Set<number>();
  for (let offset = 0; offset < orderedSamples.length;) {
    const sequence = orderedSamples[offset].seq;
    const groupTimestamp = orderedSamples[offset].timestampMs;
    const row = latest.slice();
    while (
      offset < orderedSamples.length &&
      orderedSamples[offset].seq === sequence &&
      orderedSamples[offset].timestampMs === groupTimestamp
    ) {
      const sample = orderedSamples[offset];
      row[sample.channelIndex] = sample.value;
      latest[sample.channelIndex] = sample.value;
      sampledChannels.add(sample.channelIndex);
      offset += 1;
    }
    pushSample(buffer, row, groupTimestamp);
  }
  channels = channels.map((channel, channelIndex) => ({
    ...channel,
    latest: sampledChannels.has(channelIndex) ? (latest[channelIndex] ?? null) : null,
  }));
  channelState.value = channels;
  waveformVersion.value += 1;
  scheduleRender();
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

// Canvas redraws are demand-driven and coalesced into one RAF. This keeps the
// waveform idle at 0fps when no data or pointer interaction changes the view.
let rafId: number | null = null;
let hoverCursor: { x: number; y: number } | null = null;
let resizeObserver: ResizeObserver | null = null;
let dragState: CanvasDragState | null = null;
let wheelGestureResetTimer: number | null = null;

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_GESTURE_IDLE_MS = 180;

interface CanvasDragState {
  pointerId: number;
  lastClientX: number;
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
  return calculatePlotLayout(
    canvas.clientWidth,
    canvas.clientHeight,
    showYRuler.value,
    showXRuler.value,
  );
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
  const { leftPad, plotX0, plotX1, plotTop, plotBottom, plotW, plotH } = calculatePlotLayout(
    cssW,
    cssH,
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
  const visibleWindow = waveformSampleIndexWindow(buffer.timestamps, visibleStartMs, visibleEndMs);
  const [vMin, vMax] = visibleChannelRangeInWindow(
    buffer,
    channelCount,
    channelState.value.map((channel) => channel.visible),
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

  const visiblePaths = buildVisibleChannelPaths(buffer, channelState.value, channelLabel, {
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

function observeCanvasResize() {
  const canvas = canvasRef.value;
  if (!canvas || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(canvas);
}

watch(
  () => props.waveform,
  () => hydrateSharedWaveform(),
);

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
    if (props.canEdit !== false) emit('clear', frameCursor);
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
  hydrateSharedWaveform();
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
