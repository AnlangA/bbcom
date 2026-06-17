/** Shared catalog type — kept in a dependency-free module so the locale files
 *  (en/zh) and the i18n runtime can both depend on it without creating a cycle
 *  (i18n.ts → locales/en → i18n.ts). */
export type Catalog = Record<string, string>;
