import type { InjectionKey, Ref } from 'vue';
import type { ToolsTabId } from '../../../lib/tools-tabs';
import type { DirectionFilter } from '../../../types';

/**
 * View-local UI state owned by the session runtime so it survives SessionView
 * remounts (switching session tabs destroys the view; the runtime does not).
 * Mirrors the viewMode precedent: durable-enough to keep, deliberately NOT
 * part of the persisted session document.
 */
export interface SessionRuntimeUiState {
  /** Packet list search text (empty = no filter). */
  readonly packetSearch: Ref<string>;
  /** Packet list direction filter ('ALL' default). */
  readonly packetDirection: Ref<DirectionFilter>;
  /** Active bottom tools tab. */
  readonly toolsTab: Ref<ToolsTabId>;
  /** Modbus per-register pending value drafts, keyed by register id. */
  readonly modbusValueDrafts: Ref<Record<string, string>>;
}

/** Provided by SessionView from its runtime; panels inject optionally. */
export const SESSION_UI_STATE_KEY: InjectionKey<SessionRuntimeUiState> =
  Symbol('bbcom-session-ui-state');
