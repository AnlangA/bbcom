import type { Macro, MacroStep } from '../types';

export interface MacroDraft {
  name: string;
  steps: MacroStep[];
}

export interface MacroStepLike {
  data?: unknown;
  isHex?: unknown;
  delayMs?: unknown;
}

export function createMacroStep(): MacroStep {
  return { data: '', isHex: false, delayMs: 0 };
}

export function cloneMacroStep(step: MacroStep): MacroStep {
  return {
    data: step.data,
    isHex: step.isHex,
    delayMs: step.delayMs,
  };
}

export function createMacroDraft(macro?: Pick<Macro, 'name' | 'steps'>): MacroDraft {
  if (!macro) {
    return { name: '', steps: [createMacroStep()] };
  }
  return {
    name: macro.name,
    steps: macro.steps.map(cloneMacroStep),
  };
}

export function clampMacroDelayMs(delayMs: unknown): number {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) return 0;
  return Math.max(0, Math.floor(delayMs));
}

export function normalizeMacroSteps(steps: readonly MacroStepLike[]): MacroStep[] {
  return steps
    .filter((step) => typeof step.data === 'string' && step.data.trim().length > 0)
    .map((step) => ({
      data: step.data as string,
      isHex: step.isHex === true,
      delayMs: clampMacroDelayMs(step.delayMs),
    }));
}

export function canSaveMacroDraft(draft: MacroDraft): boolean {
  return draft.name.trim().length > 0 && normalizeMacroSteps(draft.steps).length > 0;
}

export function macroSavePayload(draft: MacroDraft): Omit<Macro, 'id'> | null {
  if (!canSaveMacroDraft(draft)) return null;
  return {
    name: draft.name.trim(),
    steps: normalizeMacroSteps(draft.steps),
  };
}

export function formatMacroStepSummary(step: MacroStep, maxDataLength = 16): string {
  const mode = step.isHex ? 'HEX' : 'TXT';
  const data =
    step.data.length > maxDataLength ? `${step.data.slice(0, maxDataLength)}…` : step.data;
  const delay = step.delayMs ? ` (+${step.delayMs}ms)` : '';
  return `${mode}: ${data}${delay}`;
}

export function formatMacroSummary(
  macro: Pick<Macro, 'steps'>,
  options: { maxDataLength?: number; separator?: string } = {},
): string {
  const maxDataLength = options.maxDataLength ?? 16;
  const separator = options.separator ?? '  →  ';
  return macro.steps.map((step) => formatMacroStepSummary(step, maxDataLength)).join(separator);
}
