import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getAiErrorMessage } from '../../src/lib/ai-error.ts';

const FALLBACK = 'something went wrong';

test('passes a plain string error through unchanged', () => {
  assert.equal(getAiErrorMessage('rate limited', FALLBACK), 'rate limited');
});

test('extracts the nested details.message from a Tauri AppError shape', () => {
  const error = {
    type: 'AiError',
    details: { message: '请求过于频繁，请等待 3 秒后重试' },
  };
  assert.equal(getAiErrorMessage(error, FALLBACK), '请求过于频繁，请等待 3 秒后重试');
});

test('falls back to the top-level message when details is absent', () => {
  assert.equal(getAiErrorMessage({ message: 'network error' }, FALLBACK), 'network error');
});

test('ignores an empty details.message and keeps looking', () => {
  // details.message is "" (falsy) → should not return it; top-level message wins
  assert.equal(getAiErrorMessage({ details: { message: '' }, message: 'top' }, FALLBACK), 'top');
});

test('returns the fallback for null, undefined, and message-less objects', () => {
  assert.equal(getAiErrorMessage(null, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage(undefined, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage({ unrelated: 1 }, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage(42, FALLBACK), FALLBACK);
});

test('does not crash when details is a non-object value', () => {
  assert.equal(getAiErrorMessage({ details: 'oops', message: 'top' }, FALLBACK), 'top');
  assert.equal(getAiErrorMessage({ details: null }, FALLBACK), FALLBACK);
});

test('maps every stable AI cancellation and security code before considering backend prose', () => {
  assert.equal(
    getAiErrorMessage({ code: 'BUSY', message: 'must not expose provider prose' }, FALLBACK),
    'AI 请求正在处理中，请稍后重试',
  );
  assert.equal(getAiErrorMessage({ code: 'CANCELLED' }, FALLBACK), 'AI 请求已取消');
  assert.equal(getAiErrorMessage({ code: 'TIMEOUT' }, FALLBACK), 'AI 请求超时，请稍后重试');
  assert.equal(
    getAiErrorMessage({ code: 'SECURITY_DENIED' }, FALLBACK),
    'AI 密钥未配置或当前窗口无权执行该操作',
  );
});
