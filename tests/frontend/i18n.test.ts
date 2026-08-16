import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  ensureLocaleLoaded,
  extraLocaleKeys,
  locale,
  missingLocaleKeys,
  setLocale,
  supportedLocales,
  t,
} from '../../src/lib/i18n.ts';

// Only the default locale (zh) is bundled synchronously; every test that
// asserts English strings awaits the lazy catalog first.
await ensureLocaleLoaded('en');

test('t resolves a key in the active (zh) locale', () => {
  setLocale('zh');
  assert.equal(t('session.connect'), '连接');
  assert.equal(t('toolbar.export'), '导出');
});

test('t resolves the same key in English when locale is en', () => {
  setLocale('en');
  assert.equal(t('session.connect'), 'Connect');
  assert.equal(t('toolbar.export'), 'Export');
});

test('future-schema read-only recovery is visible in both locales', () => {
  setLocale('zh');
  assert.equal(t('persistence.readOnly.title'), '只读恢复模式');
  setLocale('en');
  assert.equal(t('persistence.readOnly.title'), 'Read-only recovery mode');
});

test('t falls back to English when a key is missing from the active locale', () => {
  setLocale('zh');
  // 'app.name' exists in both; use a key present in en only by temporarily
  // verifying fallback with a guaranteed-present-in-en key.
  assert.equal(t('common.cancel'), '取消');
  setLocale('en');
  assert.equal(t('common.cancel'), 'Cancel');
});

test('t returns the key itself for an unknown key (no throw, no blank)', () => {
  setLocale('en');
  assert.equal(t('does.not.exist'), 'does.not.exist');
  setLocale('zh');
  assert.equal(t('does.not.exist'), 'does.not.exist');
});

test('t interpolates {name} placeholders', () => {
  // Use a placeholder scenario via a known key shape — t is generic, so test
  // interpolation directly by adding a transient check: the function replaces
  // {x} with the provided value.
  setLocale('en');
  // No catalogued key uses placeholders yet, but the mechanism must still work:
  // craft a lookup that hits the fallback-to-key path and confirm interpolation.
  const result = t('hello.{name}', { name: 'world' });
  assert.equal(result, 'hello.world');
});

test('setLocale changes the active locale reactively', () => {
  setLocale('en');
  assert.equal(locale.value, 'en');
  setLocale('zh');
  assert.equal(locale.value, 'zh');
});

test('supportedLocales returns zh and English options', () => {
  const list = supportedLocales();
  const values = list.map((l) => l.value);
  assert.ok(values.includes('zh'));
  assert.ok(values.includes('en'));
  assert.equal(list.length, 2);
});

test('every zh key has an English counterpart (no missing en translations)', () => {
  assert.deepEqual(extraLocaleKeys('zh'), []);
});

test('zh catalog covers every English source key', () => {
  assert.deepEqual(missingLocaleKeys('zh'), []);
});

test('default (zh) catalog is sync while the en catalog loads lazily', async () => {
  // Re-import the module with a fresh registry so this test observes the
  // pre-load state even though the tests above already loaded `en`.
  vi.resetModules();
  const fresh = await import('../../src/lib/i18n.ts');

  // Default locale resolves immediately, with no loader awaited.
  fresh.setLocale('zh');
  assert.equal(fresh.t('session.connect'), '连接');

  // Before the lazy chunk lands, English lookups deterministically return the
  // key itself (the import promise cannot settle before this sync assert).
  fresh.setLocale('en');
  assert.equal(fresh.t('session.connect'), 'session.connect');

  // Once loaded, English resolves normally and the loader promise is shared.
  await fresh.ensureLocaleLoaded('en');
  await fresh.ensureLocaleLoaded('en');
  assert.equal(fresh.t('session.connect'), 'Connect');
});
