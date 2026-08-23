import type { QuickCommand, SendHistoryEntry } from '@/features/serial/domain/serial';
import type { SerialSession } from '@/features/sessions/domain/session';
import { truncate } from '@/lib/format';

export type ToolsTabId = 'quick' | 'macros' | 'triggers' | 'highlights' | 'history' | 'checksum';

export interface ToolsTabCounts {
  quick: number;
  macros: number;
  triggers: number;
  highlights: number;
  history: number;
  checksum: number;
}

export interface QuickCommandPayload {
  name: string;
  data: string;
  isHex: boolean;
}

export function activeToolCounts(
  session: SerialSession | undefined,
  quickCommands: readonly QuickCommand[],
  history: readonly SendHistoryEntry[],
): ToolsTabCounts {
  return {
    quick: quickCommands.length,
    macros: session?.macros.length ?? 0,
    triggers: session?.triggers.filter((trigger) => trigger.enabled).length ?? 0,
    highlights: session?.highlights.filter((highlight) => highlight.enabled).length ?? 0,
    history: history.length,
    checksum: 0,
  };
}

export function defaultToolsTab(currentTab: ToolsTabId, counts: ToolsTabCounts): ToolsTabId {
  if (currentTab !== 'quick') return currentTab;
  if (counts.quick > 0) return currentTab;
  if (counts.macros > 0) return 'macros';
  if (counts.triggers > 0) return 'triggers';
  if (counts.highlights > 0) return 'highlights';
  if (counts.history > 0) return 'history';
  return currentTab;
}

export function buildQuickCommandPayload(
  input: string,
  quickName: string,
  isHex: boolean,
): QuickCommandPayload | null {
  if (!input.trim()) return null;
  return {
    name: quickName.trim() || truncate(input, 12),
    data: input,
    isHex,
  };
}

export function canRunToolAction(disabled?: boolean): boolean {
  return disabled !== true;
}
