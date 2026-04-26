import { onMounted, onUnmounted } from 'vue';

interface AppShortcuts {
  onCreateSession: () => void;
  onCloseSession: () => void;
}

export function useAppShortcuts({ onCreateSession, onCloseSession }: AppShortcuts) {
  function handleKeydown(event: KeyboardEvent) {
    if (!event.ctrlKey && !event.metaKey) return;

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
