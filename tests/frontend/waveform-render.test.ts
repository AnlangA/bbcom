/**
 * Unit tests for the pure (non-canvas) functions extracted into the waveform
 * render pipeline. The canvas-drawing primitives (`drawXRuler`, `drawHoverRuler`,
 * …) take a `CanvasRenderingContext2D` and are runtime-coupled (no canvas is
 * available under `node --test`); they are exercised indirectly via the build +
 * the waveform math tests in `waveform.test.ts`. Everything here is pure math
 * or logic and fully testable headless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVisibleChannelPaths,
  calculatePlotLayout,
  clampNumber,
  clampRatio,
  drawHoverRuler,
  drawRoundRect,
  drawSamplePoints,
  drawWaveformPaths,
  drawXRuler,
  drawYRuler,
  findHoverPoint,
  formatMs,
  formatNum,
  normalizeWheelDelta,
  sampleTimestamp,
  wheelIntentFromDelta,
  readWaveformTheme,
  truncateCanvasText,
  type WaveformSampleBuffer,
  type WaveformChannelState,
} from '../../src/lib/waveform-render.ts';

// ---------------------------------------------------------------------------
// Number / wheel helpers.
// ---------------------------------------------------------------------------

test('clampNumber clamps finite values and returns min for non-finite', () => {
  assert.equal(clampNumber(5, 0, 10), 5);
  assert.equal(clampNumber(-1, 0, 10), 0);
  assert.equal(clampNumber(11, 0, 10), 10);
  assert.equal(clampNumber(Number.NaN, 0, 10), 0);
  assert.equal(clampNumber(Number.POSITIVE_INFINITY, 0, 10), 0);
});

test('clampRatio clamps to [0, 1]', () => {
  assert.equal(clampRatio(-0.5), 0);
  assert.equal(clampRatio(0.5), 0.5);
  assert.equal(clampRatio(1.5), 1);
});

test('normalizeWheelDelta scales by deltaMode', () => {
  assert.equal(normalizeWheelDelta(10, 0, 800), 10); // pixels
  assert.equal(normalizeWheelDelta(10, 1, 800), 160); // lines (×16)
  assert.equal(normalizeWheelDelta(10, 2, 800), 8000); // pages (×pageSize)
  assert.equal(normalizeWheelDelta(10, 2, 0), 10); // pageSize floored to ≥1
});

test('wheelIntentFromDelta classifies modifier + dominant-axis gestures', () => {
  assert.equal(wheelIntentFromDelta(0, 0, {}), null, 'no movement → null');
  assert.equal(wheelIntentFromDelta(0, 10, { ctrlKey: true }), 'zoom', 'ctrl → zoom');
  assert.equal(wheelIntentFromDelta(0, 10, { metaKey: true }), 'zoom', 'meta → zoom');
  assert.equal(wheelIntentFromDelta(0, 10, { shiftKey: true }), 'pan', 'shift+vertical → pan');
  assert.equal(wheelIntentFromDelta(20, 1, {}), 'pan', 'horizontal-dominant → pan');
  assert.equal(wheelIntentFromDelta(0, 10, {}), 'zoom', 'plain vertical → zoom');
});

// ---------------------------------------------------------------------------
// Formatters.
// ---------------------------------------------------------------------------

test('formatMs renders finite ms and an em-dash for non-finite', () => {
  assert.equal(formatMs(12.6), '13ms');
  assert.equal(formatMs(0), '0ms');
  assert.equal(formatMs(Number.POSITIVE_INFINITY), '—');
  assert.equal(formatMs(Number.NaN), '—');
});

test('formatNum delegates to the compact waveform number formatter', () => {
  assert.equal(formatNum(0), '0.00');
  assert.equal(formatNum(1000), '1000');
  assert.equal(typeof formatNum(-3.5), 'string');
});

// ---------------------------------------------------------------------------
// Plot layout.
// ---------------------------------------------------------------------------

test('calculatePlotLayout reserves pads for the rulers when shown', () => {
  const withRulers = calculatePlotLayout(800, 400, true, true);
  assert.equal(withRulers.leftPad, 52);
  assert.equal(withRulers.bottomPad, 30);
  assert.equal(withRulers.plotX0, 52);
  assert.equal(withRulers.plotTop, 12);
  assert.ok(withRulers.plotW > 0 && withRulers.plotH > 0);
  assert.ok(withRulers.plotBottom > withRulers.plotTop);
  assert.ok(withRulers.plotX1 > withRulers.plotX0);
});

test('calculatePlotLayout shrinks the pads when rulers are hidden', () => {
  const noRulers = calculatePlotLayout(800, 400, false, false);
  assert.equal(noRulers.leftPad, 12);
  assert.equal(noRulers.bottomPad, 16);
});

test('calculatePlotLayout keeps a minimum plot area on tiny canvases', () => {
  const tiny = calculatePlotLayout(1, 1, true, true);
  assert.ok(tiny.plotH >= 1, 'plotH never collapses below 1');
  assert.ok(tiny.plotW >= 1, 'plotW never collapses below 1');
});

// ---------------------------------------------------------------------------
// Theme (headless fallback path).
// ---------------------------------------------------------------------------

test('readWaveformTheme returns stable fallbacks without a window', () => {
  // The test runner has no `window` / no CSS computed style, so the fallback
  // branch is taken: every key is a concrete rgba/hex string.
  const theme = readWaveformTheme();
  assert.equal(typeof theme.axisColor, 'string');
  assert.equal(typeof theme.gridColor, 'string');
  assert.ok(theme.hoverBg.length > 0);
  assert.ok(theme.rulerColor.length > 0);
  assert.ok(theme.samplePointOutline.length > 0);
});

// ---------------------------------------------------------------------------
// Path building (sample -> screen-space polyline, clipped to the window).
// ---------------------------------------------------------------------------

function makeBuffer(timestamps: number[], channels: number[][]): WaveformSampleBuffer {
  // Pack columns: samples[i] holds channel values for row i.
  const samples = timestamps.map((_, i) => Float32Array.from(channels.map((c) => c[i] ?? 0)));
  return {
    samples,
    timestamps,
    originTimestamp: timestamps[0] ?? null,
  };
}

function channel(color: string): WaveformChannelState {
  // Minimal channel shape the path builder reads (color + visible flag).
  return { color, visible: true, latest: null } as unknown as WaveformChannelState;
}

test('sampleTimestamp falls back to the index when the entry is non-finite', () => {
  const buf: WaveformSampleBuffer = {
    samples: [],
    timestamps: [10, Number.NaN],
    originTimestamp: 10,
  };
  assert.equal(sampleTimestamp(buf, 0), 10);
  assert.equal(sampleTimestamp(buf, 1), 1, 'NaN timestamp falls back to the index');
});

test('buildVisibleChannelPaths maps in-window samples to a single polyline', () => {
  const timestamps = [100, 200, 300, 400];
  const buf = makeBuffer(timestamps, [[0, 10, 20, 30]]);
  const paths = buildVisibleChannelPaths(buf, [channel('#f00')], (i) => `Ch ${i}`, {
    channelCount: 1,
    endMs: 400,
    plotBottom: 100,
    plotH: 80,
    sampleX: (ts) => ts, // identity so x == timestamp (easy to assert)
    scanEndIndex: 4,
    scanStartIndex: 0,
    span: 30,
    startMs: 100,
    vMin: 0,
  });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].color, '#f00');
  assert.equal(paths[0].label, 'Ch 0');
  assert.equal(paths[0].points.length, 4, 'every in-window sample becomes a point');
  // y = plotBottom - ((value - vMin)/span) * plotH = 100 - (v/30)*80
  assert.equal(paths[0].points[0].y, 100);
  assert.equal(paths[0].points[3].y, 20);
});

test('buildVisibleChannelPaths skips invisible channels and out-of-window samples', () => {
  const timestamps = [100, 200, 300];
  const buf = makeBuffer(timestamps, [
    [5, 5, 5],
    [9, 9, 9],
  ]);
  const paths = buildVisibleChannelPaths(
    buf,
    [channel('#f00'), { ...channel('#0f0'), visible: false }],
    (i) => `Ch ${i}`,
    {
      channelCount: 2,
      endMs: 300,
      plotBottom: 50,
      plotH: 50,
      sampleX: (ts) => ts,
      scanEndIndex: 3,
      scanStartIndex: 0,
      span: 4,
      startMs: 100,
      vMin: 5,
    },
  );
  assert.equal(paths.length, 1, 'the invisible channel produces no path');
  assert.equal(paths[0].color, '#f00');
});

// ---------------------------------------------------------------------------
// Hover hit-testing (cursor -> nearest channel point).
// ---------------------------------------------------------------------------

test('findHoverPoint returns null outside the plot rect and matches the nearest point', () => {
  const paths = [
    {
      color: '#f00',
      label: 'Ch 0',
      points: [
        { x: 0, y: 0, value: 0, timestamp: 0 },
        { x: 100, y: 0, value: 0, timestamp: 100 },
      ],
      samplePoints: [],
    },
  ];
  // Cursor clearly outside the plot rect.
  assert.equal(
    findHoverPoint({
      cursor: { x: -5, y: 0 },
      originTimestamp: 0,
      paths,
      plotTop: 0,
      plotX0: 0,
      plotX1: 100,
      plotBottom: 50,
    }),
    null,
  );
  // Cursor inside — the projection lands mid-segment at x=90 (timestamp 90).
  const hit = findHoverPoint({
    cursor: { x: 90, y: 0 },
    originTimestamp: 0,
    paths,
    plotTop: 0,
    plotX0: 0,
    plotX1: 100,
    plotBottom: 50,
  });
  assert.ok(hit, 'a cursor inside the plot resolves to a point');
  assert.equal(hit!.color, '#f00');
  assert.equal(hit!.label, 'Ch 0');
  assert.equal(hit!.relativeMs, 90);
});

// ---------------------------------------------------------------------------
// Canvas draw primitives (exercised via a recording mock ctx — no DOM/canvas
// is available under `node --test`, but the primitives are pure given a ctx:
// they translate their options into a sequence of 2D-canvas method calls).
// ---------------------------------------------------------------------------

interface MockCtx {
  calls: Array<{ name: string; args: number[] }>;
  measureTextWidth: number;
}

/**
 * Minimal recording ctx. `measureText` returns a width proportional to the text
 * length (pxPerChar) so the label-truncation / hover-box sizing math actually
 * branches; every other method is recorded for call-order assertions, and style
 * assignments (fillStyle, lineWidth, …) are accepted no-ops.
 */
function createMockCtx(pxPerChar = 10): MockCtx & CanvasRenderingContext2D {
  const calls: Array<{ name: string; args: number[] }> = [];
  const store = { calls, measureTextWidth: pxPerChar };
  const handler: ProxyHandler<typeof store> = {
    get(target, prop: string) {
      if (prop === 'calls' || prop === 'measureTextWidth') return target[prop];
      if (prop === 'measureText') {
        return (text: string) => ({ width: text.length * target.measureTextWidth });
      }
      if (prop === 'canvas') return { getContext: () => proxy } as unknown as HTMLCanvasElement;
      return (...args: number[]) => {
        calls.push({ name: prop, args });
        return undefined;
      };
    },
    set() {
      return true;
    },
  };
  const proxy = new Proxy(store, handler) as unknown as MockCtx & CanvasRenderingContext2D;
  return proxy;
}

test('drawWaveformPaths strokes one path per channel', () => {
  const ctx = createMockCtx();
  drawWaveformPaths(ctx, [
    {
      color: '#f00',
      label: 'a',
      points: [{ x: 0, y: 0, value: 0, timestamp: 0 }],
      samplePoints: [],
    },
    {
      color: '#0f0',
      label: 'b',
      points: [{ x: 1, y: 1, value: 1, timestamp: 1 }],
      samplePoints: [],
    },
  ]);
  const strokes = ctx.calls.filter((c) => c.name === 'stroke').length;
  assert.equal(strokes, 2, 'one stroke per channel path');
  // First vertex uses moveTo, subsequent use lineTo.
  assert.ok(ctx.calls.some((c) => c.name === 'moveTo'));
});

test('drawSamplePoints draws a halo then the filled dot per point', () => {
  const ctx = createMockCtx();
  // Points spaced > 6px apart so the thinning pass keeps both.
  drawSamplePoints(ctx, {
    outlineColor: '#000',
    paths: [
      {
        color: '#f00',
        label: 'a',
        points: [],
        samplePoints: [
          { x: 0, y: 0, value: 0, timestamp: 0 },
          { x: 20, y: 20, value: 1, timestamp: 1 },
        ],
      },
    ],
  });
  const fills = ctx.calls.filter((c) => c.name === 'fill').length;
  // halo pass (2) + dot pass (2) = 4 fills.
  assert.equal(fills, 4);
});

test('drawRoundRect issues a closed quadratic-corner path', () => {
  const ctx = createMockCtx();
  drawRoundRect(ctx, 0, 0, 100, 50, 8);
  assert.ok(ctx.calls.some((c) => c.name === 'beginPath'));
  assert.ok(ctx.calls.some((c) => c.name === 'closePath'));
  assert.ok(
    ctx.calls.filter((c) => c.name === 'quadraticCurveTo').length >= 4,
    'four rounded corners',
  );
});

test('truncateCanvasText returns the text when it fits, else ellipsizes', () => {
  const ctx = createMockCtx(10); // every char measures ~10px
  assert.equal(truncateCanvasText(ctx, 'hi', 100), 'hi', 'fits → unchanged');
  const cut = truncateCanvasText(ctx, 'a-very-long-label-that-exceeds-the-width', 30);
  assert.ok(cut.endsWith('...'), 'overflow → ellipsis suffix');
  assert.ok(cut.length < 'a-very-long-label-that-exceeds-the-width'.length);
});

test('drawXRuler draws the baseline plus per-tick grid + label marks', () => {
  const ctx = createMockCtx();
  drawXRuler(ctx, {
    axisColor: '#aaa',
    gridColor: '#ccc',
    rulerColor: '#ddd',
    plotX0: 0,
    plotX1: 100,
    plotBottom: 50,
    plotH: 40,
    plotTop: 10,
    plotW: 100,
    firstTimestamp: 0,
    timeSpan: 1000,
    hasTimeScale: true,
    originTimestamp: 0,
  });
  // 5 ticks (hasTimeScale) → 5 fillText label calls.
  assert.equal(ctx.calls.filter((c) => c.name === 'fillText').length, 5);
});

test('drawYRuler draws 5 labelled value ticks', () => {
  const ctx = createMockCtx();
  drawYRuler(ctx, {
    axisColor: '#aaa',
    rulerColor: '#ddd',
    leftPad: 52,
    plotX0: 52,
    plotTop: 10,
    plotBottom: 50,
    plotH: 40,
    vMin: 0,
    vMax: 100,
  });
  assert.equal(ctx.calls.filter((c) => c.name === 'fillText').length, 5);
});

test('drawHoverRuler renders the crosshair, dot, and a labelled box', () => {
  const ctx = createMockCtx(40);
  drawHoverRuler(ctx, {
    point: { x: 50, y: 25, relativeMs: 100, value: 7, color: '#f00', label: 'Ch 0' },
    cssW: 200,
    cssH: 100,
    plotX0: 0,
    plotX1: 200,
    plotTop: 0,
    plotBottom: 100,
    lineColor: '#ffd84d',
    bgColor: '#000',
    textColor: '#fff',
  });
  // At least the crosshair + dot + box outlines + 3 text lines.
  assert.ok(
    ctx.calls.some((c) => c.name === 'arc'),
    'hover dot',
  );
  assert.ok(ctx.calls.filter((c) => c.name === 'fillText').length >= 3, 'label + x + y lines');
});
