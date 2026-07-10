import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  canSaveHighlightDraft,
  canSaveTriggerDraft,
  clampRuleDelayMs,
  createHighlightDraft,
  createTriggerDraft,
  formatHighlightSummary,
  formatTriggerSummary,
  highlightSavePayload,
  triggerSavePayload,
} from '../../src/lib/send-rules-editor.ts';
import type { HighlightRule, Trigger } from '../../src/types/index.ts';

test('creates default trigger and highlight drafts', () => {
  assert.deepEqual(createTriggerDraft(), {
    name: '',
    matchMode: 'text',
    pattern: '',
    response: '',
    responseIsHex: false,
    cooldownMs: 500,
  });
  assert.deepEqual(createHighlightDraft(), {
    name: '',
    matchMode: 'text',
    pattern: '',
    direction: 'RX',
    color: 'amber',
  });
});

test('creates edit drafts from existing trigger and highlight records', () => {
  const trigger: Trigger = {
    id: 't1',
    name: 'Login',
    enabled: false,
    matchMode: 'text',
    pattern: 'login:',
    response: 'root',
    responseIsHex: false,
    cooldownMs: 1200,
  };
  const highlight: HighlightRule = {
    id: 'h1',
    name: 'Error',
    enabled: false,
    matchMode: 'hex',
    pattern: '45 52',
    direction: 'ALL',
    color: 'red',
  };

  assert.deepEqual(createTriggerDraft(trigger), {
    name: 'Login',
    matchMode: 'text',
    pattern: 'login:',
    response: 'root',
    responseIsHex: false,
    cooldownMs: 1200,
  });
  assert.deepEqual(createHighlightDraft(highlight), {
    name: 'Error',
    matchMode: 'hex',
    pattern: '45 52',
    direction: 'ALL',
    color: 'red',
  });
});

test('validates drafts before saving', () => {
  assert.equal(
    canSaveTriggerDraft({
      name: 'Login',
      matchMode: 'text',
      pattern: 'login:',
      response: 'root',
      responseIsHex: false,
      cooldownMs: 0,
    }),
    true,
  );
  assert.equal(
    canSaveTriggerDraft({
      name: 'Login',
      matchMode: 'text',
      pattern: ' ',
      response: 'root',
      responseIsHex: false,
      cooldownMs: 0,
    }),
    false,
  );
  assert.equal(
    canSaveHighlightDraft({
      name: 'Error',
      matchMode: 'text',
      pattern: 'error',
      direction: 'RX',
      color: 'red',
    }),
    true,
  );
  assert.equal(
    canSaveHighlightDraft({
      name: 'Error',
      matchMode: 'text',
      pattern: ' ',
      direction: 'RX',
      color: 'red',
    }),
    false,
  );
});

test('builds normalized trigger and highlight save payloads', () => {
  assert.deepEqual(
    triggerSavePayload({
      name: '  Login  ',
      matchMode: 'hex',
      pattern: ' AA BB ',
      response: ' CC DD ',
      responseIsHex: true,
      cooldownMs: 999.9,
    }),
    {
      name: 'Login',
      enabled: true,
      matchMode: 'hex',
      pattern: 'AA BB',
      response: ' CC DD ',
      responseIsHex: true,
      cooldownMs: 999,
    },
  );
  assert.deepEqual(
    highlightSavePayload({
      name: '  Errors  ',
      matchMode: 'text',
      pattern: ' error ',
      direction: 'TX',
      color: 'violet',
    }),
    {
      name: 'Errors',
      enabled: true,
      matchMode: 'text',
      pattern: 'error',
      direction: 'TX',
      color: 'violet',
    },
  );
});

test('rejects invalid save payloads and clamps cooldowns', () => {
  assert.equal(triggerSavePayload(createTriggerDraft()), null);
  assert.equal(highlightSavePayload(createHighlightDraft()), null);
  assert.equal(clampRuleDelayMs(10.8), 10);
  assert.equal(clampRuleDelayMs(-1), 0);
  assert.equal(clampRuleDelayMs(Number.POSITIVE_INFINITY), 0);
});

test('formats trigger and highlight summaries', () => {
  const trigger: Trigger = {
    id: 't1',
    name: 'Login',
    enabled: true,
    matchMode: 'text',
    pattern: 'login:',
    response: 'root',
    responseIsHex: false,
    cooldownMs: 500,
  };
  const highlight: HighlightRule = {
    id: 'h1',
    name: 'Error',
    enabled: true,
    matchMode: 'hex',
    pattern: '45 52',
    direction: 'ALL',
    color: 'red',
  };

  assert.equal(
    formatTriggerSummary(trigger, (ms) => `${ms}ms`),
    'TXT "login:" → TXT "root" (500ms)',
  );
  assert.equal(formatHighlightSummary(highlight), 'ALL HEX "45 52"');
});
