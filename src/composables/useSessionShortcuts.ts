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
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (INPUT_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return false;
}

export function useSessionShortcuts({
  onClear,
  onTogglePause,
  isConnected,
}: SessionShortcutHandlers) {
  function handleKeydown(event: KeyboardEvent) {
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
}
