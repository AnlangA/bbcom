import type {
  DirectionFilter,
  HighlightColor,
  HighlightMatchMode,
  HighlightRule,
  Trigger,
  TriggerMatchMode,
} from '@/types';

export interface TriggerDraft {
  name: string;
  matchMode: TriggerMatchMode;
  pattern: string;
  response: string;
  responseIsHex: boolean;
  cooldownMs: number;
}

export interface HighlightDraft {
  name: string;
  matchMode: HighlightMatchMode;
  pattern: string;
  direction: DirectionFilter;
  color: HighlightColor;
}

export const DEFAULT_TRIGGER_DRAFT: TriggerDraft = {
  name: '',
  matchMode: 'text',
  pattern: '',
  response: '',
  responseIsHex: false,
  cooldownMs: 500,
};

export const DEFAULT_HIGHLIGHT_DRAFT: HighlightDraft = {
  name: '',
  matchMode: 'text',
  pattern: '',
  direction: 'RX',
  color: 'amber',
};

export function createTriggerDraft(trigger?: Trigger): TriggerDraft {
  if (!trigger) return { ...DEFAULT_TRIGGER_DRAFT };
  return {
    name: trigger.name,
    matchMode: trigger.matchMode,
    pattern: trigger.pattern,
    response: trigger.response,
    responseIsHex: trigger.responseIsHex,
    cooldownMs: trigger.cooldownMs,
  };
}

export function createHighlightDraft(rule?: HighlightRule): HighlightDraft {
  if (!rule) return { ...DEFAULT_HIGHLIGHT_DRAFT };
  return {
    name: rule.name,
    matchMode: rule.matchMode,
    pattern: rule.pattern,
    direction: rule.direction,
    color: rule.color,
  };
}

export function clampRuleDelayMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function canSaveTriggerDraft(draft: TriggerDraft): boolean {
  return (
    draft.name.trim().length > 0 &&
    draft.pattern.trim().length > 0 &&
    draft.response.trim().length > 0
  );
}

export function canSaveHighlightDraft(draft: HighlightDraft): boolean {
  return draft.name.trim().length > 0 && draft.pattern.trim().length > 0;
}

export function triggerSavePayload(draft: TriggerDraft): Omit<Trigger, 'id'> | null {
  if (!canSaveTriggerDraft(draft)) return null;
  return {
    name: draft.name.trim(),
    enabled: true,
    matchMode: draft.matchMode,
    pattern: draft.pattern.trim(),
    response: draft.response,
    responseIsHex: draft.responseIsHex,
    cooldownMs: clampRuleDelayMs(draft.cooldownMs),
  };
}

export function highlightSavePayload(draft: HighlightDraft): Omit<HighlightRule, 'id'> | null {
  if (!canSaveHighlightDraft(draft)) return null;
  return {
    name: draft.name.trim(),
    enabled: true,
    matchMode: draft.matchMode,
    pattern: draft.pattern.trim(),
    direction: draft.direction,
    color: draft.color,
  };
}

export function formatTriggerSummary(
  trigger: Trigger,
  cooldownLabel: (ms: number) => string,
): string {
  const matchMode = trigger.matchMode === 'hex' ? 'HEX' : 'TXT';
  const responseMode = trigger.responseIsHex ? 'HEX' : 'TXT';
  const cooldown = trigger.cooldownMs ? ` (${cooldownLabel(trigger.cooldownMs)})` : '';
  return `${matchMode} "${trigger.pattern}" → ${responseMode} "${trigger.response}"${cooldown}`;
}

export function formatHighlightSummary(rule: HighlightRule): string {
  return `${rule.direction} ${rule.matchMode === 'hex' ? 'HEX' : 'TXT'} "${rule.pattern}"`;
}
