import { getCurrentInstance, onMounted, onUnmounted } from 'vue';

interface AppShortcuts {
  onCreateSession: () => void;
  onCloseSession: () => void;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Selectors for every modal/overlay system in the app (AppModal, Naive's
 *  NModal, the shutdown dialog, and the legacy reset gate). */
const MODAL_OVERLAY_SELECTORS = [
  '.app-modal-overlay',
  '.n-modal-container',
  '.shutdown-backdrop',
  '.legacy-reset-gate',
].join(', ');

/** Exported for unit testing — true when any modal overlay is currently
 *  mounted. App-level shortcuts must not fire behind a dialog (e.g. Ctrl+W
 *  closing a session while the settings modal is open). */
export function isModalOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector(MODAL_OVERLAY_SELECTORS));
}

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
    if (isModalOverlayOpen()) return;

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

  // Keep the dispatch function usable as a pure utility in non-component
  // contexts (tests, command adapters) without registering invalid lifecycle
  // hooks. Component setup always has a current instance.
  if (getCurrentInstance()) {
    onMounted(() => {
      window.addEventListener('keydown', handleKeydown);
    });

    onUnmounted(() => {
      window.removeEventListener('keydown', handleKeydown);
    });
  }

  // Exposed for unit testing the dispatch logic without a DOM.
  return { handleKeydown };
}
