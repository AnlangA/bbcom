import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatHexAscii } from '../../src/lib/format.ts';
import { APP_VERSION } from '../../src/lib/version.ts';
import {
  createExportPreview,
  createExportFrameSnapshot,
  filterFramesByTimeRange,
  isValidCustomTimeRange,
  iterateExportFrames,
  resolveExportFilter,
  type TimeRangeFilter,
} from '../../src/lib/export-filters.ts';
import type { DataFrame } from '../../src/types.ts';

test('application version is injected without bundling the package manifest', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(APP_VERSION, manifest.version);
  assert.doesNotMatch(readFileSync('src/lib/version.ts', 'utf8'), /package\.json/);
});

test('production CSP excludes development HTTP and WebSocket origins', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
    app: { security: { csp: string; devCsp: string } };
  };
  const { csp, devCsp } = config.app.security;
  assert.equal(csp.includes('localhost:5173'), false);
  assert.equal(csp.includes('ws://'), false);
  assert.equal(devCsp.includes('http://localhost:5173'), true);
  assert.equal(devCsp.includes('ws://localhost:5173'), true);
});

test('frontend capabilities cannot open arbitrary native file dialogs', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')) as {
    permissions: string[];
  };
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
  };

  assert.equal(
    capability.permissions.some((item) => item.startsWith('dialog:')),
    false,
  );
  assert.equal('@tauri-apps/plugin-dialog' in manifest.dependencies, false);
});

test('file-writing commands stay registered behind main-window-only native services', () => {
  const mainCapability = JSON.parse(
    readFileSync('src-tauri/capabilities/default.json', 'utf8'),
  ) as { windows: string[]; permissions: string[] };
  const aiCapability = JSON.parse(
    readFileSync('src-tauri/capabilities/ai-assistant.json', 'utf8'),
  ) as { windows: string[]; permissions: string[] };
  const handlers = readFileSync('src-tauri/src/lib.rs', 'utf8');

  assert.deepEqual(mainCapability.windows, ['main']);
  assert.deepEqual(aiCapability.windows, ['ai-assistant']);
  assert.equal(
    aiCapability.permissions.some((item) => item.startsWith('serialplugin:')),
    false,
  );
  assert.equal(
    aiCapability.permissions.some((item) => item.startsWith('dialog:')),
    false,
  );

  for (const registration of [
    '.manage(commands::file_grants::FileGrantManager::default())',
    '.manage(export::session::ExportSessionManager::default())',
    '.manage(commands::log::AutoLogSessionManager::default())',
    'commands::file_grants::request_save_target',
    'commands::file_grants::revoke_file_grant',
    'commands::export::begin_export',
    'commands::export::append_export_batch',
    'commands::export::finish_export',
    'commands::export::abort_export',
    'commands::log::begin_auto_log',
    'commands::log::append_auto_log_batch',
    'commands::log::finish_auto_log',
    'commands::log::abort_auto_log',
  ]) {
    assert.ok(handlers.includes(registration), `${registration} must stay registered`);
  }
  assert.equal(handlers.includes('commands::log::append_log'), false);
});

// ---- F-h: HEX+ASCII dual display mode ----

test('formatHexAscii: renders hex pairs + ASCII side by side, 16 per line', () => {
  // "Hi" = 0x48 0x69, both printable.
  const result = formatHexAscii(new Uint8Array([0x48, 0x69]));
  const lines = result.split('\n');
  assert.equal(lines.length, 1, 'one line for 2 bytes');
  assert.ok(lines[0].includes('48 69'), 'hex pairs present');
  assert.ok(lines[0].includes('Hi'), 'ASCII column present');
});

test('formatHexAscii: non-printable bytes become dots', () => {
  const result = formatHexAscii(new Uint8Array([0x00, 0x41, 0x7f]));
  assert.ok(result.includes('.A.'), '0x00 and 0x7f are dots, 0x41 is A');
});

test('formatHexAscii: wraps at bytesPerLine boundary', () => {
  const data = new Uint8Array(20); // 20 zero bytes
  const result = formatHexAscii(data, 16);
  const lines = result.split('\n');
  assert.equal(lines.length, 2, '20 bytes at 16/line = 2 lines');
});

test('formatHexAscii: empty input produces empty string', () => {
  assert.equal(formatHexAscii(new Uint8Array(0)), '');
});

// ---- F-e: Export time-range filtering ----

function frame(dir: 'TX' | 'RX', timestamp: number, id: string): DataFrame {
  return { id, direction: dir, timestamp, data: new Uint8Array([1]) };
}

test('filterFramesByTimeRange: keeps frames within [start, end)', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b'), frame('RX', 200, 'c')];
  const filter: TimeRangeFilter = { startMs: 50, endMs: 200, direction: null };
  const result = filterFramesByTimeRange(frames, filter);
  assert.deepEqual(
    result.map((f) => f.id),
    ['b'],
    'only the frame in [50,200)',
  );
});

test('filterFramesByTimeRange: open-ended ranges (null start/end)', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b')];
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: null, endMs: null, direction: null }).length,
    2,
  );
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: 50, endMs: null, direction: null }).length,
    1,
  );
  assert.equal(
    filterFramesByTimeRange(frames, { startMs: null, endMs: 50, direction: null }).length,
    1,
  );
});

test('filterFramesByTimeRange: direction filter', () => {
  const frames = [frame('TX', 0, 'a'), frame('RX', 0, 'b'), frame('TX', 0, 'c')];
  const result = filterFramesByTimeRange(frames, { startMs: null, endMs: null, direction: 'RX' });
  assert.deepEqual(
    result.map((f) => f.id),
    ['b'],
  );
});

test('filterFramesByTimeRange: does not mutate the input', () => {
  const frames = [frame('RX', 0, 'a'), frame('RX', 100, 'b')];
  const original = [...frames];
  filterFramesByTimeRange(frames, { startMs: 50, endMs: null, direction: null });
  assert.deepEqual(frames, original, 'input unchanged');
});

test('resolveExportFilter: relative presets anchor to the newest captured timestamp', () => {
  const frames = [frame('RX', 500_000, 'latest'), frame('TX', 10_000, 'old')];
  assert.deepEqual(
    resolveExportFilter(frames, {
      direction: 'TX',
      timePreset: 'last-1m',
      customStartMs: null,
      customEndMs: null,
    }),
    { startMs: 440_000, endMs: null, direction: 'TX' },
  );
  assert.deepEqual(
    resolveExportFilter(frames, {
      direction: 'all',
      timePreset: 'last-5m',
      customStartMs: null,
      customEndMs: null,
    }),
    { startMs: 200_000, endMs: null, direction: null },
  );
});

test('custom export ranges require finite start < end', () => {
  assert.equal(isValidCustomTimeRange(1, 2), true);
  assert.equal(isValidCustomTimeRange(2, 2), false);
  assert.equal(isValidCustomTimeRange(3, 2), false);
  assert.equal(isValidCustomTimeRange(null, 2), false);
  assert.throws(() =>
    resolveExportFilter([], {
      direction: 'all',
      timePreset: 'custom',
      customStartMs: 2,
      customEndMs: 1,
    }),
  );
});

test('createExportPreview returns exact filtered frame and raw-byte totals', () => {
  const frames = [frame('RX', 1, 'rx'), frame('TX', 2, 'tx')];
  frames[0].data = new Uint8Array(3);
  frames[1].data = new Uint8Array(7);
  const preview = createExportPreview(frames, {
    direction: 'TX',
    timePreset: 'all',
    customStartMs: null,
    customEndMs: null,
  });
  assert.equal(preview.frameCount, 1);
  assert.equal(preview.rawBytes, 7);
  assert.equal(preview.maxFrameBytes, 7);
});

test('export snapshot copies the confirmed references while capture keeps appending', () => {
  const frames = [frame('RX', 1, 'first'), frame('TX', 2, 'second')];
  const snapshot = createExportFrameSnapshot(frames, {
    direction: 'all',
    timePreset: 'all',
    customStartMs: null,
    customEndMs: null,
  });
  assert.notEqual(snapshot.frames, frames, 'selection owns a stable reference array');
  assert.equal(snapshot.frames[0], frames[0], 'frame objects are not copied');
  assert.equal(snapshot.frames[0].data, frames[0].data, 'payloads are not copied');
  frames.push(frame('RX', 3, 'later'));
  assert.deepEqual(
    Array.from(iterateExportFrames(snapshot), (item) => item.id),
    ['first', 'second'],
  );
});
