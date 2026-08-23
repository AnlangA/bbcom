import type { HighlightColor, HighlightRule } from '@/features/send-panel/domain/macros';
import type { DataFrame } from '@/features/serial/domain/serial';

export const HIGHLIGHT_COLORS: HighlightColor[] = ['amber', 'red', 'blue', 'green', 'violet'];

export interface HighlightSearchAccessors {
  getHexSearchData: (frame: DataFrame) => string;
  getTextSearchData: (frame: DataFrame) => string;
}

export function normalizeHighlightHexPattern(pattern: string): string {
  return pattern.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

export function highlightRuleMatchesFrame(
  rule: HighlightRule,
  frame: DataFrame,
  accessors: HighlightSearchAccessors,
): boolean {
  const pattern = rule.pattern.trim();
  if (!rule.enabled || pattern.length === 0) return false;
  if (rule.direction !== 'ALL' && rule.direction !== frame.direction) return false;

  if (rule.matchMode === 'hex') {
    const needle = normalizeHighlightHexPattern(pattern);
    return needle.length > 0 && accessors.getHexSearchData(frame).includes(needle);
  }

  return accessors.getTextSearchData(frame).includes(pattern.toLowerCase());
}

export function findFrameHighlight(
  rules: HighlightRule[],
  frame: DataFrame,
  accessors: HighlightSearchAccessors,
): HighlightRule | null {
  for (const rule of rules) {
    if (highlightRuleMatchesFrame(rule, frame, accessors)) return rule;
  }
  return null;
}
