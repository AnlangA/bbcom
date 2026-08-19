import { test } from 'vitest';
import assert from 'node:assert/strict';
import { exportMacros, importMacros, defaultExportFilename } from '../../src/lib/macro-library.ts';
import { setLocale, t } from '../../src/lib/i18n.ts';
import type { Macro } from '../../src/types.ts';

setLocale('zh');

const MACROS: Macro[] = [
  {
    id: 'abc',
    name: 'Boot ESP32',
    steps: [
      { data: 'AT', isHex: false, delayMs: 100 },
      { data: 'AA BB', isHex: true, delayMs: 0 },
    ],
  },
];

test('exportMacros produces a versioned, id-stripped JSON document', () => {
  const json = exportMacros(MACROS);
  const parsed = JSON.parse(json);
  assert.equal(parsed.app, 'bbcom');
  assert.equal(parsed.kind, 'macro-library');
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.macros));
  assert.equal(parsed.macros.length, 1);
  // ids are stripped (session-scoped) so import can reassign them.
  assert.equal(parsed.macros[0].id, undefined);
  assert.equal(parsed.macros[0].name, 'Boot ESP32');
});

test('export → import round-trips macros (with fresh empty ids)', () => {
  const json = exportMacros(MACROS);
  const imported = importMacros(json);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, 'Boot ESP32');
  assert.equal(imported[0].id, '', 'imported macros carry empty ids for reassignment');
  assert.equal(imported[0].steps.length, 2);
  assert.deepEqual(imported[0].steps[0], { data: 'AT', isHex: false, delayMs: 100 });
});

test('importMacros rejects non-JSON input', () => {
  assert.throws(() => importMacros('not json at all'), {
    message: t('macroLibrary.jsonParseFailed'),
  });
});

test('importMacros rejects files missing the app/kind marker', () => {
  assert.throws(() => importMacros(JSON.stringify({ macros: [] })), {
    message: t('macroLibrary.notMacroFile'),
  });
});

test('importMacros rejects future versions instead of guessing their shape', () => {
  const payload = JSON.stringify({
    app: 'bbcom',
    kind: 'macro-library',
    version: 2,
    macros: [],
  });
  assert.throws(() => importMacros(payload), {
    message: t('macroLibrary.unsupportedVersion'),
  });
});

test('importMacros rejects a file whose macros field is not an array', () => {
  const payload = JSON.stringify({
    app: 'bbcom',
    kind: 'macro-library',
    version: 1,
    macros: null,
  });
  assert.throws(() => importMacros(payload), {
    message: t('macroLibrary.missingMacros'),
  });
});

test('importMacros rejects a file with no valid macros', () => {
  const payload = JSON.stringify({ app: 'bbcom', kind: 'macro-library', version: 1, macros: [] });
  assert.throws(() => importMacros(payload), {
    message: t('macroLibrary.noImportableMacros'),
  });
});

test('importMacros filters malformed steps but keeps valid ones', () => {
  const payload = JSON.stringify({
    app: 'bbcom',
    kind: 'macro-library',
    version: 1,
    macros: [
      {
        name: 'Mixed',
        steps: [
          { data: 'ok', isHex: false, delayMs: 10 }, // valid
          { data: '', isHex: false }, // empty data -> dropped
          { isHex: true }, // no data -> dropped
          { data: 'AA', isHex: 'yes', delayMs: -5 }, // delayMs coerced; non-boolean isHex -> false
        ],
      },
    ],
  });
  const imported = importMacros(payload);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].steps.length, 2);
  assert.equal(imported[0].steps[1].delayMs, 0, 'negative delay clamped to 0');
  assert.equal(imported[0].steps[1].isHex, false, 'non-boolean isHex coerced to false');
});

test('importMacros drops macros with empty names or no valid steps', () => {
  const payload = JSON.stringify({
    app: 'bbcom',
    kind: 'macro-library',
    version: 1,
    macros: [
      { name: '', steps: [{ data: 'x', isHex: false }] }, // empty name -> dropped
      { name: 'NoSteps', steps: [{ data: '', isHex: false }] }, // all steps invalid -> dropped
      { name: 'Good', steps: [{ data: 'x', isHex: false }] }, // kept
    ],
  });
  const imported = importMacros(payload);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, 'Good');
});

test('importMacros ignores non-object macros and invalid field types', () => {
  const payload = JSON.stringify({
    app: 'bbcom',
    kind: 'macro-library',
    version: 1,
    macros: [
      null,
      { name: 42, steps: [{ data: 'x', isHex: false }] },
      { name: 'Missing steps', steps: null },
      { name: 'Good', steps: [{ data: 'x', isHex: false }] },
    ],
  });
  const imported = importMacros(payload);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, 'Good');
});

test('defaultExportFilename is safe (no spaces/colons) and ends in .json', () => {
  const name = defaultExportFilename();
  assert.ok(name.endsWith('.json'));
  assert.ok(!/\s/.test(name), 'no spaces');
  assert.ok(!/[:]/.test(name), 'no colons');
});
