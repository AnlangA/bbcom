import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  canSaveMacroDraft,
  clampMacroDelayMs,
  createMacroDraft,
  createMacroStep,
  formatMacroSummary,
  formatMacroStepSummary,
  macroSavePayload,
  normalizeMacroSteps,
} from '@/lib/macro-editor.ts';
import type { Macro } from '@/types/index.ts';

test('creates empty macro steps and drafts for new macros', () => {
  assert.deepEqual(createMacroStep(), { data: '', isHex: false, delayMs: 0 });
  assert.deepEqual(createMacroDraft(), {
    name: '',
    steps: [{ data: '', isHex: false, delayMs: 0 }],
  });
});

test('creates edit drafts by cloning macro steps', () => {
  const macro: Macro = {
    id: 'm1',
    name: 'Boot',
    steps: [{ data: 'AT', isHex: false, delayMs: 100 }],
  };

  const draft = createMacroDraft(macro);
  draft.steps[0].data = 'CHANGED';

  assert.equal(draft.name, 'Boot');
  assert.equal(macro.steps[0].data, 'AT');
});

test('normalizes macro steps by dropping empty data and coercing fields', () => {
  assert.deepEqual(
    normalizeMacroSteps([
      { data: '  ', isHex: true, delayMs: 10 },
      { data: 'AT', isHex: 'yes', delayMs: 1.9 },
      { data: 'AA BB', isHex: true, delayMs: -5 },
      { data: 'PING', isHex: false, delayMs: Number.POSITIVE_INFINITY },
      { isHex: true, delayMs: 50 },
    ]),
    [
      { data: 'AT', isHex: false, delayMs: 1 },
      { data: 'AA BB', isHex: true, delayMs: 0 },
      { data: 'PING', isHex: false, delayMs: 0 },
    ],
  );
});

test('clamps macro delay to a non-negative integer', () => {
  assert.equal(clampMacroDelayMs(25.9), 25);
  assert.equal(clampMacroDelayMs(-1), 0);
  assert.equal(clampMacroDelayMs(null), 0);
});

test('checks and builds save payloads from macro drafts', () => {
  assert.equal(
    canSaveMacroDraft({ name: '', steps: [{ data: 'AT', isHex: false, delayMs: 0 }] }),
    false,
  );
  assert.equal(
    canSaveMacroDraft({ name: 'Boot', steps: [{ data: ' ', isHex: false, delayMs: 0 }] }),
    false,
  );

  const payload = macroSavePayload({
    name: '  Boot  ',
    steps: [
      { data: ' ', isHex: false, delayMs: 0 },
      { data: 'AT', isHex: false, delayMs: 10.8 },
    ],
  });

  assert.deepEqual(payload, {
    name: 'Boot',
    steps: [{ data: 'AT', isHex: false, delayMs: 10 }],
  });
});

test('formats macro step and macro summaries', () => {
  assert.equal(
    formatMacroStepSummary({ data: '12345678901234567', isHex: false, delayMs: 250 }),
    'TXT: 1234567890123456… (+250ms)',
  );
  assert.equal(formatMacroStepSummary({ data: 'AA BB', isHex: true, delayMs: 0 }), 'HEX: AA BB');
  assert.equal(
    formatMacroSummary(
      {
        steps: [
          { data: 'AT', isHex: false, delayMs: 100 },
          { data: 'AA BB', isHex: true, delayMs: 0 },
        ],
      },
      { separator: ' | ' },
    ),
    'TXT: AT (+100ms) | HEX: AA BB',
  );
});
