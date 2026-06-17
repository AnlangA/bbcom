import { onMounted, onUnmounted } from 'vue';

interface AppShortcuts {
  onCreateSession: () => void;
  onCloseSession: () => void;
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

export function useAppShortcuts({ onCreateSession, onCloseSession }: AppShortcuts) {
  function handleKeydown(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    if (isEditable(event.target)) return;

    if (event.key === 'n') {
      event.preventDefault();
      onCreateSession();
      return;
    }

    if (event.key === 'w') {
      event.preventDefault();
      onCloseSession();
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
