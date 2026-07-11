import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  aiRiskLabel,
  aiRiskTagType,
  getLogContextModeOptions,
} from '../../src/components/ai/ai-options.ts';
import { setLocale } from '../../src/lib/i18n.ts';

test('AI risk labels are localized', () => {
  setLocale('en');
  assert.equal(aiRiskLabel('safe'), 'Safe');
  assert.equal(aiRiskLabel('caution'), 'Caution');
  assert.equal(aiRiskLabel('dangerous'), 'Dangerous');

  setLocale('zh');
  assert.equal(aiRiskLabel('safe'), '安全');
  assert.equal(aiRiskLabel('caution'), '谨慎');
  assert.equal(aiRiskLabel('dangerous'), '危险');
});

test('log context mode options are localized', () => {
  setLocale('en');
  assert.deepEqual(
    getLogContextModeOptions().map((item) => item.label),
    ['Latest 10k chars', 'Latest N frames', 'Full log (50k cap)'],
  );

  setLocale('zh');
  assert.deepEqual(
    getLogContextModeOptions().map((item) => item.label),
    ['最新 10k 字符', '最新 N 帧', '全部日志(50k上限)'],
  );
});

test('aiRiskTagType maps to naive-ui tag severity', () => {
  assert.equal(aiRiskTagType('safe'), 'success');
  assert.equal(aiRiskTagType('caution'), 'warning');
  // dangerous is the conservative default for unknown levels too — must be 'error'.
  assert.equal(aiRiskTagType('dangerous'), 'error');
});
