import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getCommandErrorMessage } from '../../src/lib/ipc.ts';
import { setLocale } from '../../src/lib/i18n.ts';

test('stable command errors are localized from their code without backend prose', () => {
  const native = {
    code: 'IO_PERMISSION_DENIED',
    messageKey: 'error.io_permission_denied',
    operation: 'finish_export',
    message: '/secret/path must not be rendered',
  };
  setLocale('en');
  assert.equal(
    getCommandErrorMessage(native, 'fallback'),
    'The target file cannot be written because permission was denied.',
  );
  setLocale('zh');
  assert.equal(getCommandErrorMessage(native, 'fallback'), '没有写入目标文件的权限。');
});

test('every export boundary code has a deterministic local message', () => {
  setLocale('en');
  for (const code of [
    'INVALID_INPUT',
    'LIMIT_EXCEEDED',
    'SECURITY_DENIED',
    'IO_PERMISSION_DENIED',
    'IO_DISK_FULL',
    'EXPORT_REPLACE_FAILED',
  ]) {
    assert.notEqual(getCommandErrorMessage({ code }, 'fallback'), 'fallback', code);
  }
  assert.equal(getCommandErrorMessage({ code: 'UNKNOWN_CODE' }, 'fallback'), 'fallback');
});
