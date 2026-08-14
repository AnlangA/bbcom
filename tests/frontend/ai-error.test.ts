import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getAiErrorMessage } from '../../src/lib/ai-error.ts';

const FALLBACK = 'something went wrong';

test('does not expose an unstructured provider string', () => {
  assert.equal(getAiErrorMessage('rate limited', FALLBACK), FALLBACK);
});

test('does not expose legacy nested provider prose', () => {
  const error = {
    type: 'AiError',
    details: { message: '请求过于频繁，请等待 3 秒后重试' },
  };
  assert.equal(getAiErrorMessage(error, FALLBACK), FALLBACK);
});

test('does not expose legacy top-level provider prose', () => {
  assert.equal(getAiErrorMessage({ message: 'network error' }, FALLBACK), FALLBACK);
});

test('ignores empty or non-contract legacy messages', () => {
  assert.equal(getAiErrorMessage({ details: { message: '' }, message: 'top' }, FALLBACK), FALLBACK);
});

test('returns the fallback for null, undefined, and message-less objects', () => {
  assert.equal(getAiErrorMessage(null, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage(undefined, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage({ unrelated: 1 }, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage(42, FALLBACK), FALLBACK);
});

test('does not crash when details is a non-object value', () => {
  assert.equal(getAiErrorMessage({ details: 'oops', message: 'top' }, FALLBACK), FALLBACK);
  assert.equal(getAiErrorMessage({ details: null }, FALLBACK), FALLBACK);
});

test('maps every stable AI cancellation and security code before considering backend prose', () => {
  assert.equal(
    getAiErrorMessage({ code: 'BUSY', message: 'must not expose provider prose' }, FALLBACK),
    '请求的资源正忙，请稍后重试。',
  );
  assert.equal(getAiErrorMessage({ code: 'CANCELLED' }, FALLBACK), '操作已取消。');
  assert.equal(getAiErrorMessage({ code: 'TIMEOUT' }, FALLBACK), '操作超时。');
  assert.equal(
    getAiErrorMessage({ code: 'AI_PROVIDER_FAILED' }, FALLBACK),
    'AI 服务商未能完成请求，请重试。',
  );
  assert.equal(
    getAiErrorMessage({ code: 'SECURITY_DENIED' }, FALLBACK),
    '当前窗口无权执行该操作。',
  );
});

test('uses only a stable localized messageKey', () => {
  assert.equal(
    getAiErrorMessage(
      { messageKey: 'error.ai_request_failed', message: 'provider secret detail' },
      FALLBACK,
    ),
    'AI 服务商未能完成请求，请重试。',
  );
});
