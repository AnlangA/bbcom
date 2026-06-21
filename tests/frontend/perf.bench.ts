/**
 * Headless hot-path microbenchmarks for the serial data pipeline.
 *
 * These run under the same Node `--test` loader as the unit tests (so `.ts`
 * imports resolve) but are NOT correctness tests — they measure throughput of
 * the pure TS functions that dominate the per-frame cost at high baud:
 *   - formatHex / formatUtf8 (per-frame formatting, LRU-cached in the app)
 *   - concatUint8Arrays (the RX flush path that coalesces a RAF batch)
 *   - the MERGED-view rebuild (visibleFrames in usePacketFilter)
 *
 * Run: pnpm run bench:frontend
 *
 * A failure here is a *regression gate*: if a number regresses beyond the
 * baseline ratio the test fails, so CI catches perf drops. The first run
 * records no baseline — it just prints. To lock a baseline, set the env var
 * BENCH_WRITE=1 to emit/refresh tests/frontend/.perf-baseline.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encodeUtf8, formatHex, formatUtf8 } from '../../src/lib/format.ts';
import { concatUint8Arrays } from '../../src/lib/bytes.ts';
import { LRUCache } from '../../src/lib/lru-cache.ts';
import { ProtocolParser } from '../../src/lib/protocol-parser.ts';
import { decodeFrameText, parseSampleLine } from '../../src/lib/waveform.ts';
import { SerialRxQueue } from '../../src/lib/serial-rx-queue.ts';
import { buildModbusReadBatches, scanResponse, readRequest } from '../../src/lib/modbus';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/sessions.ts';
import { markRaw } from 'vue';
import type { DataFrame, ModbusRegister, PortConfig } from '../../src/types.ts';

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
const TOTAL_BYTES = FRAMES.reduce((s, f) => s + f.data.length, 0);
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
  /** total ms for the measured block */
  ms: number;
}

function bench(name: string, fn: () => void, iters: number): BenchResult {
  // warmup
  for (let i = 0; i < Math.min(1000, iters); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  return { name, opsPerSec: (iters / ms) * 1000, ms };
}

function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Run `fn` `rounds` times and return the median ops/sec. */
function benchMedian(name: string, fn: () => unknown, iters: number, rounds = 5): BenchResult {
  const ops: number[] = [];
  let lastMs = 0;
  for (let r = 0; r < rounds; r++) {
    const res = bench(name, () => {
      fn();
    }, iters);
    ops.push(res.opsPerSec);
    lastMs = res.ms;
  }
  return { name, opsPerSec: median(ops), ms: lastMs };
}

function loadBaseline(): Record<string, number> {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function recordResult(name: string, opsPerSec: number): void {
  if (!process.env.BENCH_WRITE) return;
  const all = loadBaseline();
  all[name] = opsPerSec;
  writeFileSync(BASELINE_PATH, JSON.stringify(all, null, 2) + '\n');
}

function assertNoRegression(name: string, opsPerSec: number): void {
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
  return `${r.name}: ${fmt(r.opsPerSec)} ops/s (${r.ms.toFixed(1)} ms)`;
}

test('bench: formatHex over 50k frames', () => {
  const r = benchMedian('formatHex_50k', () => {
    for (const f of FRAMES) formatHex(f.data);
  }, 1);
  console.log(`[bench] ${summarize(r)} | ${fmt(TOTAL_BYTES)} bytes total`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: formatUtf8 over 50k frames', () => {
  const r = benchMedian('formatUtf8_50k', () => {
    for (const f of FRAMES) formatUtf8(f.data);
  }, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: concatUint8Arrays (RX flush, 64-chunk batch)', () => {
  // Simulate one RAF flush: ~64 chunks concatenated into one frame.
  const batch = FRAMES.slice(0, 64).map((f) => f.data);
  const batchBytes = batch.reduce((sum, chunk) => sum + chunk.length, 0);
  const r = benchMedian('concat_64chunks', () => {
    concatUint8Arrays(batch, batchBytes);
  }, 10000);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: MERGED-view rebuild over 50k frames', () => {
  // Mirrors the visibleFrames() MERGED path: group consecutive same-direction
  // frames and concat. This is the per-render cost when packetViewMode=MERGED.
  function rebuildMerged(): DataFrame[] {
    const merged: DataFrame[] = [];
    let curDir: DataFrame['direction'] | null = null;
    let curTs = 0;
    let curId = '';
    let chunks: Uint8Array[] = [];
    let size = 0;
    function flush() {
      if (!curDir) return;
      const data = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        data.set(c, off);
        off += c.length;
      }
      merged.push(markRaw({ id: `merged-${curId}`, direction: curDir, timestamp: curTs, data }));
    }
    for (const f of FRAMES) {
      if (curDir !== f.direction) {
        flush();
        curDir = f.direction;
        curTs = f.timestamp;
        curId = f.id;
        chunks = [];
        size = 0;
      }
      chunks.push(f.data);
      size += f.data.length;
    }
    flush();
    return merged;
  }
  const r = benchMedian('merged_rebuild_50k', rebuildMerged, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: protocol parser feed over 50k frames', () => {
  const r = benchMedian('protocol_parser_feed_50k', () => {
    const parser = new ProtocolParser({ kind: 'fixed', frameSize: 64 });
    let parsed = 0;
    for (const f of FRAMES) {
      parsed += parser.feed(f.data).length;
    }
    if (parsed === 0) throw new Error('parser emitted no frames');
  }, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: waveform decode/parse over 50k frames', () => {
  const r = benchMedian('waveform_parse_50k', () => {
    let samples = 0;
    for (const f of WAVEFORM_FRAMES) {
      samples += parseSampleLine(decodeFrameText(f.data)).length;
    }
    if (samples === 0) throw new Error('waveform parser emitted no samples');
  }, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});

test('bench: LRU format cache hit rate (1000-entry, repeated display)', () => {
  const cache = new LRUCache<string, string>(1000);
  // Prime the cache as the formatter would, then measure steady-state hits.
  for (const f of FRAMES.slice(0, 1000)) {
    cache.set(`f${f.id}:HEX:true`, formatHex(f.data));
  }
  const subset = FRAMES.slice(0, 1000);
  const r = benchMedian('lru_hit_1000', () => {
    for (const f of subset) {
      const key = `f${f.id}:HEX:true`;
      const v = cache.get(key);
      if (v === undefined) cache.set(key, formatHex(f.data));
    }
  }, 100);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
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
  const r = benchMedian('serialrxqueue_drop_512', () => {
    queue.reset();
    for (let i = 0; i < 512; i++) queue.enqueue(chunk);
  }, 50);
  console.log(`[bench] ${summarize(r)} | dropped ${queue.totalDroppedBytes} bytes`);
  recordResult(r.name, r.opsPerSec);
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
  const r = benchMedian('sessions_push_50k', () => {
    setActivePinia(createPinia());
    const store = useSessionStore();
    const id = store.createSession('BENCH', cfg);
    for (let i = 0; i < seed.length; i++) {
      store.addFrame(id, { direction: seed[i].direction, data: seed[i].data });
    }
  }, 1);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
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
  const r = benchMedian('modbus_readbatch_256', () => {
    const batches = buildModbusReadBatches(regs);
    if (batches.length === 0) throw new Error('expected at least one batch');
  }, 200);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
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
  const r = benchMedian('modbus_scan_rtu_noise', () => {
    scanResponse('rtu', buf);
  }, 200);
  console.log(`[bench] ${summarize(r)}`);
  recordResult(r.name, r.opsPerSec);
  assertNoRegression(r.name, r.opsPerSec);
});
