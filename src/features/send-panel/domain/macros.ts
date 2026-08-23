import type { DirectionFilter } from '@/types/display';

/** A single step of a sequenced macro. `delayMs` is waited AFTER this step's
 * payload is sent (the inter-step gap), matching CoolTerm's macro model. */
export interface MacroStep {
  data: string;
  isHex: boolean;
  /** Delay in ms applied after sending this step. 0 = no delay. */
  delayMs: number;
}

/** A named, ordered sequence of sends with inter-step delays — the
 * CoolTerm/TeraTerm "macro" pattern for scripted device bring-up (e.g. boot
 * commands with wait-for-boot gaps). Persisted per-session like quickCommands. */
export interface Macro {
  id: string;
  name: string;
  steps: MacroStep[];
  /** Native plugin contribution owner. Missing/null means a normal user item. */
  ownerPluginId?: string | null;
}

/** Match mode for a scripted trigger: substring in decoded text, or a hex byte
 * sequence matched against raw RX bytes. */
export type TriggerMatchMode = 'text' | 'hex';

/** A scripted trigger: when `pattern` appears in the RX stream, automatically
 *  send `response`. Persisted per-session like macros/quickCommands. */
export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  matchMode: TriggerMatchMode;
  pattern: string;
  response: string;
  responseIsHex: boolean;
  /** Minimum ms between firings (anti-loop cooldown). */
  cooldownMs: number;
}

export type HighlightMatchMode = 'text' | 'hex';
export type HighlightColor = 'amber' | 'red' | 'blue' | 'green' | 'violet';

/** A terminal highlight rule. Matching is done against the decoded text search
 * index or continuous HEX search index, and can be scoped to TX/RX/all. */
export interface HighlightRule {
  id: string;
  name: string;
  enabled: boolean;
  matchMode: HighlightMatchMode;
  pattern: string;
  direction: DirectionFilter;
  color: HighlightColor;
}
