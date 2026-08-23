import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { McumgrError } from '@/generated/ipc-contracts';
import {
  formatMcumgrErrorDetail,
  getMcumgrActionLabel,
  getMcumgrErrorMessage,
} from '@/lib/mcumgr-error';
import { ensureLocaleLoaded, setLocale } from '@/lib/i18n';

test('getMcumgrErrorMessage localizes SMP not-supported codes', async () => {
  await ensureLocaleLoaded('en');
  setLocale('en');
  const error: McumgrError = {
    kind: 'device',
    message: 'MGMT_ERR_ENOTSUP',
    rc: 8,
    group: 0,
  };
  assert.equal(getMcumgrErrorMessage(error), 'Command not supported by device firmware.');
  assert.match(formatMcumgrErrorDetail(error), /Image → Image state/);
});

test('getMcumgrErrorMessage localizes SMP codes in Chinese', async () => {
  await ensureLocaleLoaded('en');
  setLocale('zh');
  const error: McumgrError = {
    kind: 'device',
    message: 'MGMT_ERR_ENOTSUP',
    rc: 8,
    group: 0,
  };
  assert.equal(getMcumgrErrorMessage(error), '设备固件不支持此命令。');
  assert.match(formatMcumgrErrorDetail(error), /镜像 → 镜像状态/);
});

test('getMcumgrErrorMessage maps port open failures', async () => {
  await ensureLocaleLoaded('en');
  setLocale('en');
  const error: McumgrError = {
    kind: 'port',
    message: 'failed to open serial port: Device or resource busy',
  };
  assert.equal(
    getMcumgrErrorMessage(error),
    'Could not open the serial port: Device or resource busy',
  );
});

test('getMcumgrActionLabel resolves known action ids', async () => {
  await ensureLocaleLoaded('en');
  setLocale('en');
  assert.equal(getMcumgrActionLabel('echo'), 'Echo');
  setLocale('zh');
  assert.equal(getMcumgrActionLabel('image-state'), '镜像状态');
});
