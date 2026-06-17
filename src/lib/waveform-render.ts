/**
 * Canvas rendering pipeline for the waveform plot.
 *
 * Extracted from `WaveformPanel.vue` so the panel stays a thin state +
 * interaction orchestrator and the pure layout / path-building / drawing
 * primitives live in a framework-free, unit-testable module (precedent: the
 * pure waveform math already lives in `lib/waveform.ts`). Nothing here imports
 * Vue; every function takes a `CanvasRenderingContext2D` plus plain options.
 */

import {
  closestPointOnWaveformPath,
  formatWaveformNumber,
  thinWaveformSamplePoints,
  type WaveformChannelState,
  type WaveformPathPoint,
} from './waveform';

/** A waveform buffer as produced by `createBuffer` in `waveform.ts`. */
export interface WaveformSampleBuffer {
  samples: Array<Float32Array | number[]>;
  timestamps: number[];
  originTimestamp: number | null;
}

export interface PlotLayout {
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

export interface HoverPoint {
  x: number;
  y: number;
  relativeMs: number;
  value: number;
  color: string;
  label: string;
}

export interface RenderedChannelPath {
  color: string;
  label: string;
  points: WaveformPathPoint[];
  samplePoints: WaveformPathPoint[];
}

export interface WaveformCanvasTheme {
  axisColor: string;
  gridColor: string;
  hoverBg: string;
  hoverLineColor: string;
  hoverText: string;
  rulerColor: string;
  samplePointOutline: string;
}

type CanvasWheelIntent = 'pan' | 'zoom';

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

interface BuildChannelPathOptions {
  channelCount: number;
  endMs: number;
  plotBottom: number;
  plotH: number;
  sampleX: (timestamp: number) => number;
  scanEndIndex: number;
  scanStartIndex: number;
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

interface SamplePointDrawOptions {
  outlineColor: string;
  paths: readonly RenderedChannelPath[];
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

const WHEEL_DOMINANCE_RATIO = 1.25;

/**
 * Canvas 2D `font` does not resolve CSS variables — keep the resolved
 * monospace stack in sync with the app theme. Exposed so callers can read it
 * after {@link readWaveformTheme}.
 */
export let monoFontStack = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

// ---------------------------------------------------------------------------
// Number / wheel helpers (shared by the panel's interaction handlers too).
// ---------------------------------------------------------------------------

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function clampRatio(value: number): number {
  return clampNumber(value, 0, 1);
}

export function normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * Math.max(1, pageSize);
  return delta;
}

export function wheelIntentFromDelta(
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

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value)}ms`;
}

/** Format a plotted value for an axis/hover label. */
export function formatNum(n: number): string {
  return formatWaveformNumber(n);
}

// ---------------------------------------------------------------------------
// Plot layout.
// ---------------------------------------------------------------------------

export function calculatePlotLayout(
  cssW: number,
  cssH: number,
  showYRuler: boolean,
  showXRuler: boolean,
): PlotLayout {
  const leftPad = showYRuler ? 52 : 12;
  const topPad = 12;
  const bottomPad = showXRuler ? 30 : 16;
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

// ---------------------------------------------------------------------------
// Theme (canvas 2D cannot read CSS variables directly).
// ---------------------------------------------------------------------------

export function readWaveformTheme(): WaveformCanvasTheme {
  const fallback = {
    axisColor: 'rgba(255,255,255,0.3)',
    gridColor: 'rgba(255,255,255,0.04)',
    hoverBg: 'rgba(24,28,34,0.94)',
    hoverLineColor: '#ffd84d',
    hoverText: '#eef3f7',
    rulerColor: 'rgba(255,255,255,0.1)',
    samplePointOutline: '#11161c',
  };
  if (typeof window === 'undefined') return fallback;

  const styles = getComputedStyle(document.documentElement);
  const readCssVar = (name: string, value: string): string =>
    styles.getPropertyValue(name).trim() || value;

  // Canvas 2D `font` does not resolve CSS variables, so keep the resolved
  // monospace stack in sync with the app theme while reading the rest once.
  monoFontStack = readCssVar('--font-mono', monoFontStack);
  return {
    axisColor: readCssVar('--text-dim', fallback.axisColor),
    gridColor: readCssVar('--grid-line', fallback.gridColor),
    hoverBg: readCssVar('--bg-elevated', fallback.hoverBg),
    hoverLineColor: readCssVar('--color-warning', fallback.hoverLineColor),
    hoverText: readCssVar('--text-primary', fallback.hoverText),
    rulerColor: readCssVar('--border-color', fallback.rulerColor),
    samplePointOutline: readCssVar('--bg-inset', fallback.samplePointOutline),
  };
}

// ---------------------------------------------------------------------------
// Path building (maps samples -> screen-space polylines, clipped to the
// visible window with interpolated segment endpoints).
// ---------------------------------------------------------------------------

export function sampleTimestamp(buffer: WaveformSampleBuffer, index: number): number {
  const timestamp = buffer.timestamps[index];
  return Number.isFinite(timestamp) ? timestamp : index;
}

export function buildVisibleChannelPaths(
  buffer: WaveformSampleBuffer,
  channels: readonly WaveformChannelState[],
  labelForChannel: (channelIndex: number) => string,
  options: BuildChannelPathOptions,
): RenderedChannelPath[] {
  const {
    channelCount,
    endMs,
    plotBottom,
    plotH,
    sampleX,
    scanEndIndex,
    scanStartIndex,
    span,
    startMs,
    vMin,
  } = options;
  const paths: RenderedChannelPath[] = [];
  const scanStart = Math.max(0, Math.min(buffer.samples.length, scanStartIndex));
  const scanEnd = Math.max(scanStart, Math.min(buffer.samples.length, scanEndIndex));
  for (let c = 0; c < channelCount; c += 1) {
    const channel = channels[c];
    if (!channel?.visible) continue;
    const points: WaveformPathPoint[] = [];
    const samplePoints: WaveformPathPoint[] = [];
    let previous: { timestamp: number; value: number } | null = null;

    for (let i = scanStart; i < scanEnd; i += 1) {
      const value = buffer.samples[i][c];
      if (value === undefined || !Number.isFinite(value)) continue;
      const timestamp = sampleTimestamp(buffer, i);
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
        label: labelForChannel(c),
        points,
        samplePoints,
      });
    }
  }
  return paths;
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

// ---------------------------------------------------------------------------
// Drawing primitives.
// ---------------------------------------------------------------------------

export function drawWaveformPaths(
  ctx: CanvasRenderingContext2D,
  paths: readonly RenderedChannelPath[],
) {
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

export function findHoverPoint(options: HoverPointOptions): HoverPoint | null {
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

export function drawSamplePoints(ctx: CanvasRenderingContext2D, options: SamplePointDrawOptions) {
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

export function drawHoverRuler(ctx: CanvasRenderingContext2D, options: HoverRulerDrawOptions) {
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

export function truncateCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = '...';
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}${suffix}`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}${suffix}`;
}

export function drawRoundRect(
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

export function drawXRuler(ctx: CanvasRenderingContext2D, options: XRulerDrawOptions) {
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

export function drawYRuler(ctx: CanvasRenderingContext2D, options: YRulerDrawOptions) {
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
