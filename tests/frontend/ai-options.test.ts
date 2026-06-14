import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_RISK_LABELS, aiRiskTagType } from '../../src/components/ai/ai-options.ts';

test('AI risk labels map each level to its Chinese display string', () => {
  assert.equal(AI_RISK_LABELS.safe, '安全');
  assert.equal(AI_RISK_LABELS.caution, '谨慎');
  assert.equal(AI_RISK_LABELS.dangerous, '危险');
});

test('aiRiskTagType maps to naive-ui tag severity', () => {
  assert.equal(aiRiskTagType('safe'), 'success');
  assert.equal(aiRiskTagType('caution'), 'warning');
  // dangerous is the conservative default for unknown levels too — must be 'error'.
  assert.equal(aiRiskTagType('dangerous'), 'error');
});
