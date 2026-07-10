import { onMounted, onUnmounted } from 'vue';

/**
 * Session-scoped keyboard shortcuts that mirror professional serial terminals:
 *
 * - `Ctrl/Cmd+L` — clear the capture buffer (the classic terminal "clear").
 * - `Esc`        — toggle capture pause/resume (freeze the live view without
 *                 losing data, then resume to flush). Matches the pause button.
 *
 * Both are skipped while focus is in an editable element (input, textarea,
 * contenteditable) so typing `L` or pressing Esc to blur an input is never
 * hijacked. Esc intentionally only toggles pause when the session is connected
 * — pausing an already-disconnected session is a no-op the UI would surface
 * as a confusing state.
 */
interface SessionShortcutHandlers {
  onClear: () => void;
  onTogglePause: () => void;
  isConnected: () => boolean;
  /** Resident session views remain mounted; only the active one may consume
   * application-wide keyboard shortcuts. Defaults to true for compatibility. */
  isActive?: () => boolean;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Exported for unit testing — true when the focused element would consume
 *  keyboard input, so shortcuts must be suppressed. Uses a tagName duck-type
 *  rather than `instanceof HTMLElement` so it is decoupled from the DOM global
 *  (and unit-testable in a DOM-less runtime). */
export function isEditable(el: EventTarget | null): boolean {
  if (el === null || typeof el !== 'object') return false;
  const tag = (el as { tagName?: unknown }).tagName;
  if (typeof tag !== 'string') return false;
  if (INPUT_TAGS.has(tag)) return true;
  if ((el as { isContentEditable?: unknown }).isContentEditable === true) return true;
  return false;
}

export function useSessionShortcuts({
  onClear,
  onTogglePause,
  isConnected,
  isActive = () => true,
}: SessionShortcutHandlers) {
  function handleKeydown(event: KeyboardEvent) {
    if (!isActive()) return;
    // Esc: never preventDefault unconditionally — it must still close dropdowns,
    // blur inputs, etc. Only act when not in an editable element AND connected.
    if (event.key === 'Escape') {
      if (isEditable(event.target)) return;
      if (!isConnected()) return;
      event.preventDefault();
      onTogglePause();
      return;
    }

    // Ctrl/Cmd+L: clear (the terminal-standard "clear screen" chord).
    if ((event.ctrlKey || event.metaKey) && (event.key === 'l' || event.key === 'L')) {
      if (isEditable(event.target)) return;
      event.preventDefault();
      onClear();
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  // Exposed for unit testing the dispatch logic without a DOM.
  return { handleKeydown };
}
