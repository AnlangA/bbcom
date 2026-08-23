import type { Ref } from 'vue';
import type { ToolsTabId } from '@/features/send-panel/application/tools-tabs';
import type { DirectionFilter } from '@/types';

export { SESSION_UI_STATE_KEY } from '@/bootstrap/provide-keys';

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
  /** Serial-shell scrollback search text (empty = no filter). */
  readonly shellSearch: Ref<string>;
}
