import { computed, ref, type Ref } from 'vue';
import {
  normalizeWaveformTimeViewport,
  panWaveformTimeViewport,
  panWaveformTimeViewportByMs,
  scaleWaveformTimeViewport,
  syncWaveformTimeViewportAfterSampleChange,
  waveformTimeRange,
  DEFAULT_WAVEFORM_VIEWPORT_MIN_MS,
  type WaveformPanDirection,
  type WaveformTimeViewport,
  type WaveformZoomDirection,
} from '../../../lib/waveform';
import {
  calculatePlotLayout,
  clampNumber,
  clampRatio,
  normalizeWheelDelta,
  wheelIntentFromDelta,
  type PlotLayout,
} from '../../../lib/waveform-render';

/** Plot layout for one canvas state; shared by gestures and the renderer. */
export function waveformPlotLayout(
  canvas: HTMLCanvasElement,
  showYRuler: boolean,
  showXRuler: boolean,
): PlotLayout {
  return calculatePlotLayout(canvas.clientWidth, canvas.clientHeight, showYRuler, showXRuler);
}

export interface WaveformViewportOptions {
  buffer: WaveformBufferLike;
  canvasRef: Ref<HTMLCanvasElement | null>;
  showXRuler(): boolean;
  showYRuler(): boolean;
  showHoverRuler(): boolean;
  scheduleRender(): void;
}

export interface WaveformBufferLike {
  readonly timestamps: number[];
  readonly samples: unknown[];
}

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_GESTURE_IDLE_MS = 180;

interface CanvasDragState {
  pointerId: number;
  lastClientX: number;
}

/**
 * Waveform time-viewport state and pointer/wheel gestures: drag-to-pan,
 * wheel zoom/pan with anchor ratios, hover ruler tracking, and the
 * legend-driven zoom/pan buttons.
 */
export function useWaveformViewport({
  buffer,
  canvasRef,
  showXRuler,
  showYRuler,
  showHoverRuler,
  scheduleRender,
}: WaveformViewportOptions) {
  const dragging = ref(false);
  const timeViewport = ref<WaveformTimeViewport>(fullTimeViewport());

  let hoverCursor: { x: number; y: number } | null = null;
  let dragState: CanvasDragState | null = null;
  let wheelGestureResetTimer: number | null = null;

  function fullTimeViewport(): WaveformTimeViewport {
    return { startMs: 0, durationMs: Number.POSITIVE_INFINITY };
  }

  const viewportView = computed(() => {
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

  /** Reset the viewport (and hover cursor) after a buffer clear/rebuild. */
  function resetViewport(): void {
    hoverCursor = null;
    timeViewport.value = fullTimeViewport();
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
      direction === 'out' && range && next.durationMs >= range.durationMs
        ? fullTimeViewport()
        : next;
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
      if (!moved && showHoverRuler()) scheduleRender();
      e.preventDefault();
      return;
    }
    if (showHoverRuler()) scheduleRender();
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
    const layout = waveformPlotLayout(canvas, showYRuler(), showXRuler());
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

  function currentHoverCursor() {
    return hoverCursor;
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
    if (showHoverRuler()) scheduleRender();
  }

  function endCanvasDrag(e: PointerEvent) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const canvas = canvasRef.value;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    dragState = null;
    dragging.value = false;
    if (showHoverRuler()) scheduleRender();
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
    const layout = waveformPlotLayout(canvas, showYRuler(), showXRuler());
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

  return {
    dragging,
    timeViewport,
    viewportView,
    canZoomIn,
    canZoomOut,
    canPanLeft,
    canPanRight,
    currentHoverCursor,
    syncViewportAfterSampleChange,
    resetViewport,
    zoomViewport,
    panViewport,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerUp,
    onCanvasPointerCancel,
    onCanvasPointerLeave,
    onCanvasPointerCaptureLost,
    onCanvasWheel,
    resetWheelGesture,
  };
}

export type WaveformViewport = ReturnType<typeof useWaveformViewport>;
