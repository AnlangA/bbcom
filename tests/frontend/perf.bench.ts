/**
 * Headless hot-path microbenchmarks for the serial data pipeline.
 *
 * These run under the same Node `--test` loader as the unit tests (so `.ts`
 * imports resolve) but are NOT correctness tests — they measure throughput of
 * the pure TS functions that dominate the per-frame cost at high baud:
 *   - formatHex / formatUtf8 (per-frame formatting, LRU-cached in the app)
 *   - concatUint8Arrays (the RX flush path that coalesces a RAF batch)
 *   - the MERGED-view projection (visibleFrames in usePacketFilter)
 *
 * Run: pnpm run bench:frontend
 *
 * Every case warms the code path for a fixed minimum duration, calibrates to
 * at least 100 ms, then records seven rounds and rejects a coefficient of
 * variation above 10%.
 * CI sets BENCH_OUTPUT to
 * collect structured results from three independent base/head processes. For
 * local one-shot comparisons, BENCH_WRITE=1 refreshes the legacy baseline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encodeUtf8, formatHex, formatHexAscii, formatUtf8 } from '../../src/lib/format.ts';
import { concatUint8Arrays } from '../../src/lib/bytes.ts';
import { ProtocolParser } from '../../src/lib/protocol-parser.ts';
import { decodeFrameText, parseSampleLine } from '../../src/lib/waveform.ts';
import { SerialRxQueue } from '../../src/lib/serial-rx-queue.ts';
import { buildModbusReadBatches, readRequest, scanResponse } from '../../src/lib/modbus';
import { usePacketFilter } from '../../src/composables/usePacketFilter.ts';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { effectScope, markRaw, ref, shallowRef } from 'vue';
import type {
  DataFrame,
  ModbusRegister,
  PacketViewMode,
  PortConfig,
  SearchMode,
} from '../../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, '.perf-baseline.json');

// A realistic serial mix: mostly small RX chunks (sensors/printers), a few
// larger ones (firmware logs, file transfers). Sizes weighted toward 32–256B.
function makeFrame(i: number, dir: DataFrame['direction']): DataFrame {
  const size = [32, 64, 64, 128, 128, 256, 512][i % 7];
  const data = new Uint8Array(size);
  // pseudo-random but deterministic — avoid crypto for a stable workload
  for (let j = 0; j < size; j++) data[j] = (i * 31 + j * 7) & 0xff;
  return markRaw({
    id: `f${i}`,
    direction: dir,
    timestamp: Date.now() + i,
    data,
  });
}

const N = 50_000;
const FRAMES: DataFrame[] = Array.from({ length: N }, (_, i) =>
  makeFrame(i, i % 5 === 0 ? 'TX' : 'RX'),
);
// The high-baud terminal case is a long uninterrupted direction run. It is
// where a full re-concatenation becomes quadratic as new data arrives and is
// the fixed v0.5 performance target for the rope projection.
const MERGED_FRAMES: DataFrame[] = FRAMES.map((frame) => markRaw({ ...frame, direction: 'RX' }));
const TOTAL_BYTES = FRAMES.reduce((s, f) => s + f.data.length, 0);
const HEXASCII_DATA = new Uint8Array(64 * 1024);
for (let index = 0; index < HEXASCII_DATA.length; index += 1) {
  HEXASCII_DATA[index] = index & 0xff;
}
const WAVEFORM_FRAMES: DataFrame[] = Array.from({ length: N }, (_, i) =>
  markRaw({
    id: `w${i}`,
    direction: 'RX',
    timestamp: Date.now() + i,
    data: encodeUtf8(`${i % 100},${(i * 3) % 100},${(i * 7) % 100}\n`),
  }),
);

interface BenchResult {
  name: string;
  /** operations per second */
  opsPerSec: number;
  /** Median process CPU duration of one measured round. */
  ms: number;
  iterations: number;
  samples: Array<{ opsPerSec: number; ms: number }>;
  cv: number;
}

interface BenchCollection {
  schemaVersion: 3;
  rounds: number;
  minSampleMs: number;
  minWarmupMs: number;
  calibrationTargetMs: number;
  maxCv: number;
  cases: Record<string, BenchResult>;
}

const BENCH_ROUNDS = 7;
const MIN_SAMPLE_MS = 100;
const MIN_WARMUP_MS = 1000;
// A one-second target makes a normal scheduler timeslice materially smaller
// than one sample and amortizes short GC/scheduling pauses. The contract
// remains "at least 100 ms"; this deliberately exceeds that floor for a
// repeatable 3 x 7 base/head gate.
const CALIBRATION_TARGET_MS = 1000;
const MAX_CV = 0.1;
const BENCH_OUTPUT = process.env.BENCH_OUTPUT?.trim();

if (BENCH_OUTPUT && process.env.BENCH_WRITE) {
  throw new Error('BENCH_OUTPUT and BENCH_WRITE are mutually exclusive');
}

const collection: BenchCollection = {
  schemaVersion: 3,
  rounds: BENCH_ROUNDS,
  minSampleMs: MIN_SAMPLE_MS,
  minWarmupMs: MIN_WARMUP_MS,
  calibrationTargetMs: CALIBRATION_TARGET_MS,
  maxCv: MAX_CV,
  cases: {},
};
if (BENCH_OUTPUT) writeFileSync(BENCH_OUTPUT, `${JSON.stringify(collection, null, 2)}\n`);

function measure(fn: () => unknown, iterations: number): { opsPerSec: number; ms: number } {
  // Process CPU time retains formatter/GC work while excluding time when a
  // shared runner deschedules this process. Wall-clock scheduling noise made
  // the otherwise strict per-process CV gate flaky even with CPU affinity.
  const cpuStart = process.cpuUsage();
  for (let i = 0; i < iterations; i++) fn();
  const cpu = process.cpuUsage(cpuStart);
  const ms = (cpu.user + cpu.system) / 1000;
  return { opsPerSec: (iterations / ms) * 1000, ms };
}

function warmUp(fn: () => unknown): void {
  const deadline = performance.now() + MIN_WARMUP_MS;
  do {
    fn();
  } while (performance.now() < deadline);
}

function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function coefficientOfVariation(samples: number[]): number {
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance) / mean;
}

function calibratedIterations(fn: () => unknown, initialIterations: number): number {
  let iterations = Math.max(1, Math.floor(initialIterations));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { ms } = measure(fn, iterations);
    assert.ok(Number.isFinite(ms) && ms > 0, 'benchmark calibration produced no samples');
    if (ms >= CALIBRATION_TARGET_MS) return iterations;
    const scale = Math.max(2, Math.ceil((CALIBRATION_TARGET_MS / ms) * 1.1));
    const next = iterations * scale;
    assert.ok(Number.isSafeInteger(next), 'benchmark calibration iteration count overflowed');
    iterations = next;
  }
  assert.fail(`benchmark could not calibrate to ${CALIBRATION_TARGET_MS} ms`);
}

/** Calibrate, then run exactly seven independently measured rounds. */
function benchMedian(name: string, fn: () => unknown, initialIterations: number): BenchResult {
  // Warm before calibration: cold-start tiering otherwise makes two identical
  // processes choose materially different batch sizes. The warmup is never
  // included in a sample and all seven samples remain mandatory.
  warmUp(fn);
  const iterations = calibratedIterations(fn, initialIterations);
  let samples = Array.from({ length: BENCH_ROUNDS }, () => measure(fn, iterations));
  let ops = samples.map((sample) => sample.opsPerSec);
  let cv = coefficientOfVariation(ops);
  // Allocation-heavy formatters can have one process disturbed by a cold GC
  // cycle or scheduler interruption even after calibration. Retry one complete
  // seven-round set after another warmup; persistent noise still fails the
  // strict 10% contract and the discarded attempt never enters comparison
  // output.
  if (cv > MAX_CV) {
    warmUp(fn);
    samples = Array.from({ length: BENCH_ROUNDS }, () => measure(fn, iterations));
    ops = samples.map((sample) => sample.opsPerSec);
    cv = coefficientOfVariation(ops);
  }
  for (const sample of samples) {
    assert.ok(Number.isFinite(sample.opsPerSec) && sample.opsPerSec > 0, `${name} has no samples`);
    assert.ok(
      Number.isFinite(sample.ms) && sample.ms >= MIN_SAMPLE_MS,
      `${name} measured only ${sample.ms.toFixed(1)} ms; minimum is ${MIN_SAMPLE_MS} ms`,
    );
  }
  assert.ok(Number.isFinite(cv), `${name} produced a non-finite coefficient of variation`);
  assert.ok(
    cv <= MAX_CV,
    `${name} CV ${(cv * 100).toFixed(2)}% exceeds 10%; samples=${ops.map((sample) => sample.toFixed(2)).join(',')}`,
  );
  return {
    name,
    opsPerSec: median(ops),
    ms: median(samples.map((sample) => sample.ms)),
    iterations,
    samples,
    cv,
  };
}

function loadBaseline(): Record<string, number> {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function recordResult(result: BenchResult): void {
  if (BENCH_OUTPUT) {
    collection.cases[result.name] = result;
    writeFileSync(BENCH_OUTPUT, `${JSON.stringify(collection, null, 2)}\n`);
  }
  if (process.env.BENCH_WRITE) {
    const all = loadBaseline();
    all[result.name] = result.opsPerSec;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(all, null, 2)}\n`);
  }
}

function assertNoRegression(name: string, opsPerSec: number): void {
  if (BENCH_OUTPUT) return;
  const baseline = loadBaseline()[name];
  if (baseline === undefined) return; // no baseline yet — first run
  const ratio = opsPerSec / baseline;
  // Allow 15% noise; anything worse is a regression.
  if (ratio < 0.85) {
    assert.fail(
      `${name} regressed: ${fmt(opsPerSec)} ops/s vs baseline ${fmt(baseline)} ops/s (${(ratio * 100).toFixed(1)}%)`,
    );
  }
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

function summarize(r: BenchResult): string {
  return `${r.name}: ${fmt(r.opsPerSec)} ops/s (${r.ms.toFixed(1)} ms, CV ${(r.cv * 100).toFixed(2)}%)`;
}

test('bench: formatHex over 50k frames', () => {
  const r = benchMedian(
    'formatHex_50k',
    () => {
      for (const f of FRAMES) formatHex(f.data);
    },
    1,
  );
  console.log(`[bench] ${summarize(r)} | ${fmt(TOTAL_BYTES)} bytes total`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: formatUtf8 over 50k frames', () => {
  const r = benchMedian(
    'formatUtf8_50k',
    () => {
      for (const f of FRAMES) formatUtf8(f.data);
    },
    1,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: formatHexAscii over a 64 KiB merged display tail', () => {
  const r = benchMedian('format_hexascii_64k', () => formatHexAscii(HEXASCII_DATA), 100);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: concatUint8Arrays (RX flush, 64-chunk batch)', () => {
  // Simulate one RAF flush: ~64 chunks concatenated into one frame.
  const batch = FRAMES.slice(0, 64).map((f) => f.data);
  const batchBytes = batch.reduce((sum, chunk) => sum + chunk.length, 0);
  const r = benchMedian(
    'concat_64chunks',
    () => {
      concatUint8Arrays(batch, batchBytes);
    },
    10000,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: MERGED-view projection over 50k frames', () => {
  // Exercise the real composable in both base and head. The base revision
  // materializes every direction run; the rope revision builds descriptors
  // only. Constructing the scope is intentionally part of the operation, but
  // source-frame creation is not.
  function projectMerged(): void {
    const scope = effectScope();
    scope.run(() => {
      const filter = usePacketFilter({
        frames: shallowRef(MERGED_FRAMES),
        framesVersion: ref(0),
        searchMode: ref<SearchMode>('TEXT'),
        packetViewMode: ref<PacketViewMode>('MERGED'),
        getHexSearchData: () => '',
        getTextSearchData: () => '',
      });
      if (filter.visibleFrames.value.length === 0) throw new Error('merged view emitted no rows');
    });
    scope.stop();
  }
  const r = benchMedian('merged_projection_50k', projectMerged, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: protocol parser feed over 50k frames', () => {
  const r = benchMedian(
    'protocol_parser_feed_50k',
    () => {
      const parser = new ProtocolParser({ kind: 'fixed', frameSize: 64 });
      let parsed = 0;
      for (const f of FRAMES) {
        parsed += parser.feed(f.data).length;
      }
      if (parsed === 0) throw new Error('parser emitted no frames');
    },
    1,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: waveform decode/parse over 50k frames', () => {
  const r = benchMedian(
    'waveform_parse_50k',
    () => {
      let samples = 0;
      for (const f of WAVEFORM_FRAMES) {
        samples += parseSampleLine(decodeFrameText(f.data)).length;
      }
      if (samples === 0) throw new Error('waveform parser emitted no samples');
    },
    1,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

// ---------------------------------------------------------------------------
// Bench blind spots: the RX-queue overflow drop path, the 50k-frame
// session push, and Modbus read-batch composition. These are the three paths
// previously uncovered by a microbench and most likely to regress silently.
// ---------------------------------------------------------------------------

test('bench: SerialRxQueue drop path (512 sustained overflowing enqueues)', () => {
  // Tight queue so every enqueue after saturation exercises the head-drop path
  // (shift + recordDrop) — the backpressure safety net for high-baud bursts.
  const queue = new SerialRxQueue({ maxBytes: 64 * 1024, maxChunks: 512 });
  const chunk = new Uint8Array(256);
  const r = benchMedian(
    'serialrxqueue_drop_512',
    () => {
      queue.reset();
      for (let i = 0; i < 512; i++) queue.enqueue(chunk);
    },
    50,
  );
  console.log(`[bench] ${summarize(r)} | dropped ${queue.totalDroppedBytes} bytes`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: sessions store 50k-frame push (addFrame hot path)', () => {
  // The per-frame store mutation that dominates a long capture. Uses a fresh
  // store per iteration to measure allocation + bounded-buffer trim, not the
  // persistence debounce (which is async and would add noise).
  const cfg: PortConfig = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    dtr: false,
    rts: false,
  };
  const seed: Array<{ direction: DataFrame['direction']; data: Uint8Array }> = FRAMES.map((f) => ({
    direction: f.direction,
    data: f.data,
  }));
  const r = benchMedian(
    'sessions_push_50k',
    () => {
      setActivePinia(createPinia());
      const store = useSessionStore();
      const id = store.createSession('BENCH', cfg);
      for (let i = 0; i < seed.length; i++) {
        store.addFrame(id, { direction: seed[i].direction, data: seed[i].data });
      }
    },
    1,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: Modbus read-batch composition (256 contiguous holding regs)', () => {
  // Batching turns a flat register table into the minimal set of PDU read
  // requests. With contiguous rows this collapses to a handful of batches; with
  // fragmented rows it stays linear. Measure the contiguous best case (the
  // common polling layout) so a regression in the coalescing loop is caught.
  const regs: ModbusRegister[] = Array.from({ length: 256 }, (_, i) => ({
    id: `r${i}`,
    name: `reg${i}`,
    slaveAddress: 1,
    functionCode: 3,
    address: i,
    quantity: 1,
    type: 'uint16',
    waveformChannel: null,
    value: null,
    valueTs: null,
    periodicRead: true,
    periodicWrite: false,
  }));
  const r = benchMedian(
    'modbus_readbatch_256',
    () => {
      const batches = buildModbusReadBatches(regs);
      if (batches.length === 0) throw new Error('expected at least one batch');
    },
    200,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: scanResponse RTU trailing-noise sweep', () => {
  // Worst case for the RTU scanner: a valid frame at offset 0 (emitted), then a
  // long tail of non-frame bytes. The scanner must sweep every candidate length
  // (4..256) at each noise offset before giving up. Pre-fix this was
  // O(noise · 252 · avg_len) CRC byte-ops per call; the incremental fold makes
  // it O(noise · 252) total. This locks that improvement as a regression gate.
  const valid = readRequest('rtu', 1, 0x03, 0, 2); // 01 03 00 00 00 02 c4 0b
  // 200 noise bytes (no CRC-valid frame hiding in them), after the real frame.
  const noise = new Uint8Array(200);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7 + 13) & 0xff;
  const buf = new Uint8Array(valid.length + noise.length);
  buf.set(valid, 0);
  buf.set(noise, valid.length);
  // Correctness anchor: the scanner must still find exactly the one valid frame.
  const check = scanResponse('rtu', buf);
  if (check.frames.length !== 1) throw new Error(`expected 1 frame, got ${check.frames.length}`);
  const r = benchMedian(
    'modbus_scan_rtu_noise',
    () => {
      scanResponse('rtu', buf);
    },
    200,
  );
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r);
  assertNoRegression(r.name, r.opsPerSec);
});
