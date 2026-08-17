/**
 * Minimal dependency-free i18n.
 *
 * A flat key → string catalog with `en` and `zh` locales. `t(key, params?)`
 * resolves a key and interpolates `{name}` placeholders. Falls back to `en`
 * when a key is missing from the active locale, then to the key itself — so a
 * missing translation never throws or renders blank.
 *
 * Startup cost: only the DEFAULT locale (`zh`) is imported statically. The
 * `en` catalog is fetched lazily through a dynamic import, so it ships as its
 * own chunk and stays out of the first-paint graph until someone actually
 * needs English (a persisted setting or an explicit `setLocale('en')`).
 *
 * Transient behavior while `en` has not finished loading (deterministic
 * contract): a key missing from `zh` resolves to the KEY itself instead of
 * the English string. Once the chunk lands, the English fallback resumes;
 * the loader bumps a revision ref that `t()` reads, so reactive callers that
 * already rendered re-run and pick up the English strings. Keys present in
 * the active locale are unaffected at all times.
 *
 * Kept as a tiny hand-rolled module (rather than vue-i18n) to avoid pulling a
 * large dependency into the first-paint bundle for what is, today, a few
 * hundred strings. The lookup is O(1) and the catalog is tree-shakeable.
 *
 * The locale catalogs live in `locales/en.ts` and `locales/zh.ts` (split by
 * file so each is independently editable). This module owns the runtime: the
 * active locale ref, `t`, `setLocale`, lazy catalog loading, and the
 * parity-check helpers the tests use as a missing-key compile-time gate.
 */
import { ref } from 'vue';
import zh from './locales/zh';

export type Locale = 'en' | 'zh';

import type { Catalog } from './locales/catalog';
export type { Catalog };

/** The locale that must always be available synchronously. */
const DEFAULT_LOCALE: Locale = 'zh';

/** Loaded catalogs. `zh` is static; `en` is filled in by its lazy loader. */
const CATALOGS: Partial<Record<Locale, Catalog>> = { zh };

/** Bumped when a lazy catalog lands so reactive `t()` callers re-render. */
const lazyCatalogRevision = ref(0);

let englishCatalogLoad: Promise<void> | null = null;

function loadEnglishCatalog(): Promise<void> {
  englishCatalogLoad ??= import('./locales/en').then((module) => {
    CATALOGS.en = module.default;
    lazyCatalogRevision.value += 1;
  });
  return englishCatalogLoad;
}

/**
 * Ensure a locale's catalog is resident. The default locale (`zh`) is always
 * available synchronously; every other locale resolves once its lazy chunk
 * has loaded. Repeated calls share the same load promise.
 */
export function ensureLocaleLoaded(which: Locale): Promise<void> {
  if (CATALOGS[which]) return Promise.resolve();
  return loadEnglishCatalog();
}

/** The active locale (reactive — components re-render on change). */
export const locale = ref<Locale>(DEFAULT_LOCALE);

/** Programmatically set the active locale. Also reflects onto <html lang>
 *  for accessibility / screen readers. Switching to a locale that has not
 *  loaded yet starts its loader (fire-and-forget); callers that need to
 *  await the catalog can use `ensureLocaleLoaded`. */
export function setLocale(next: Locale): void {
  locale.value = next;
  void ensureLocaleLoaded(next);
  // Some test environments define `document` without a full DOM tree.
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  }
}

/** Resolve a key to a localized string, interpolating `{name}` placeholders.
 *  Falls back to English (once its lazy catalog has loaded), then to the key
 *  itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  void lazyCatalogRevision.value; // track lazy catalog arrivals for reactive callers
  const active = CATALOGS[locale.value] ?? {};
  const english = CATALOGS.en;
  let raw = active[key] ?? english?.[key] ?? key;
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

function requireLoadedCatalog(which: Locale): Catalog {
  const catalog = CATALOGS[which];
  if (!catalog) {
    throw new Error(
      `i18n catalog for "${which}" is not loaded yet; await ensureLocaleLoaded("${which}") first`,
    );
  }
  return catalog;
}

/** Return keys present in `source` but missing from `target`.
 *  Used by tests so catalog drift is caught before a release. Both catalogs
 *  must be loaded — call `ensureLocaleLoaded` first for lazy locales. */
export function missingLocaleKeys(target: Locale, source: Locale = 'en'): string[] {
  const targetCatalog = requireLoadedCatalog(target);
  return Object.keys(requireLoadedCatalog(source)).filter((key) => !(key in targetCatalog));
}

/** Return keys that exist only in `localeToCheck`. */
export function extraLocaleKeys(localeToCheck: Locale, source: Locale = 'en'): string[] {
  const sourceCatalog = requireLoadedCatalog(source);
  return Object.keys(requireLoadedCatalog(localeToCheck)).filter((key) => !(key in sourceCatalog));
}
