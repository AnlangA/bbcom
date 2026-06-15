import { onMounted, onUnmounted } from 'vue';

interface AppShortcuts {
  onCreateSession: () => void;
  onCloseSession: () => void;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (INPUT_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
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
}
