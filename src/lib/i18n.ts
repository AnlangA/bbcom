/**
 * Minimal dependency-free i18n.
 *
 * A flat key → string catalog with `en` and `zh` locales. `t(key, params?)`
 * resolves a key and interpolates `{name}` placeholders. Falls back to `en`
 * when a key is missing from the active locale, then to the key itself — so a
 * missing translation never throws or renders blank.
 *
 * Kept as a tiny hand-rolled module (rather than vue-i18n) to avoid pulling a
 * large dependency into the first-paint bundle for what is, today, a few
 * hundred strings. The lookup is O(1) and the catalog is tree-shakeable.
 *
 * The locale catalogs live in `i18n/en.ts` and `i18n/zh.ts` (split by file so
 * each is independently editable; T3.4). This module owns the runtime: the
 * active locale ref, `t`, `setLocale`, and the parity-check helpers the tests
 * use as a missing-key compile-time gate.
 */
import { ref } from 'vue';
import en from './locales/en';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

import type { Catalog } from './locales/catalog';
export type { Catalog };

const CATALOGS: Record<Locale, Catalog> = { en, zh };

/** The active locale (reactive — components re-render on change). */
export const locale = ref<Locale>('zh');

/** Programmatically set the active locale. Also reflects onto <html lang>
 *  for accessibility / screen readers. */
export function setLocale(next: Locale): void {
  locale.value = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }
}

/** Resolve a key to a localized string, interpolating `{name}` placeholders.
 *  Falls back to English, then to the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  const active = CATALOGS[locale.value];
  let raw = active[key] ?? en[key] ?? key;
  if (params) {
    for (const name of Object.keys(params)) {
      raw = raw.replace(new RegExp(`\\{${name}\\}`, 'g'), String(params[name]));
    }
  }
  return raw;
}

/** Return the list of supported locales (for a settings dropdown). */
export function supportedLocales(): Array<{ label: string; value: Locale }> {
  return [
    { label: '中文', value: 'zh' },
    { label: 'English', value: 'en' },
  ];
}

/** Return keys present in `source` but missing from `target`.
 *  Used by tests so catalog drift is caught before a release. */
export function missingLocaleKeys(target: Locale, source: Locale = 'en'): string[] {
  const targetCatalog = CATALOGS[target];
  return Object.keys(CATALOGS[source]).filter((key) => !(key in targetCatalog));
}

/** Return keys that exist only in `localeToCheck`. */
export function extraLocaleKeys(localeToCheck: Locale, source: Locale = 'en'): string[] {
  const sourceCatalog = CATALOGS[source];
  return Object.keys(CATALOGS[localeToCheck]).filter((key) => !(key in sourceCatalog));
}
