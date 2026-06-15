import type { Macro, MacroStep } from '../types';
import { t } from './i18n';
import { logger } from './logger';

/**
 * Cross-session macro library import/export.
 *
 * Macros are normally per-session, but a user often wants to reuse a scripted
 * bring-up sequence across sessions/devices (e.g. the same AT-command init).
 * This module serializes a macro set to a portable JSON shape and validates it
 * on import so a hand-edited or third-party file can't crash the app.
 */

/** The portable shape we write to disk / clipboard. Versioned for future migration. */
interface MacroLibraryFile {
  app: 'bbcom';
  kind: 'macro-library';
  version: 1;
  exportedAt: string;
  macros: Array<Omit<Macro, 'id'>>;
}

const FILE_APP = 'bbcom';
const FILE_KIND = 'macro-library';

/** Serialize a list of macros to a pretty-printed JSON string (no ids — they are
 * session-scoped and would collide on import). */
export function exportMacros(macros: Macro[]): string {
  const payload: MacroLibraryFile = {
    app: FILE_APP,
    kind: FILE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    macros: macros.map((m) => ({ name: m.name, steps: cleanSteps(m.steps) })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Validate and parse an imported macro-library string. Returns the macros
 * (without ids — the caller assigns fresh ones) or throws on a malformed file. */
export function importMacros(raw: string): Macro[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(t('macroLibrary.jsonParseFailed'));
  }
  const file = parsed as Partial<MacroLibraryFile>;
  if (!file || file.app !== FILE_APP || file.kind !== FILE_KIND) {
    throw new Error(t('macroLibrary.notMacroFile'));
  }
  if (!Array.isArray(file.macros)) {
    throw new Error(t('macroLibrary.missingMacros'));
  }
  const macros: Macro[] = [];
  for (const entry of file.macros) {
    const validated = validateMacro(entry);
    if (validated) macros.push(validated);
  }
  if (macros.length === 0) {
    throw new Error(t('macroLibrary.noImportableMacros'));
  }
  logger.info(`macro-library: imported ${macros.length} macros`);
  return macros;
}

/** Coerce an unknown object into a clean MacroStep, or null if invalid. */
function validateStep(raw: unknown): MacroStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<MacroStep> & Record<string, unknown>;
  if (typeof s.data !== 'string' || s.data.length === 0) return null;
  const isHex = s.isHex === true;
  let delayMs = 0;
  if (typeof s.delayMs === 'number' && Number.isFinite(s.delayMs)) {
    delayMs = Math.max(0, Math.floor(s.delayMs));
  }
  return { data: s.data, isHex, delayMs };
}

function validateMacro(raw: unknown): Macro | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<Macro> & Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.trim().length === 0) return null;
  if (!Array.isArray(m.steps)) return null;
  const steps = m.steps.map(validateStep).filter((s): s is MacroStep => s !== null);
  if (steps.length === 0) return null;
  return { id: '', name: m.name.trim(), steps };
}

/** Drop empty/invalid steps before export so the file only carries real payloads. */
function cleanSteps(steps: MacroStep[]): MacroStep[] {
  return steps
    .filter((s) => s && typeof s.data === 'string' && s.data.trim().length > 0)
    .map((s) => ({
      data: s.data,
      isHex: s.isHex === true,
      delayMs: typeof s.delayMs === 'number' ? Math.max(0, Math.floor(s.delayMs)) : 0,
    }));
}

/** Default filename for an export (safe across platforms). */
export function defaultExportFilename(prefix = 'bbcom-macros'): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${prefix}-${stamp}.json`;
}
