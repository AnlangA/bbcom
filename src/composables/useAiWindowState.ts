import { ref, onMounted, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { getAiWindowState, hideAiWindow, showAiWindow, type AiWindowState } from '../lib/ipc';

export function useAiWindowState() {
  const visible = ref(false);
  let unlisten: (() => void) | null = null;

  async function refresh() {
    try {
      const state = await getAiWindowState();
      visible.value = state.visible;
    } catch {
      visible.value = false;
    }
  }

  async function toggle() {
    try {
      if (visible.value) {
        await hideAiWindow();
        visible.value = false;
      } else {
        await showAiWindow();
        visible.value = true;
      }
    } catch {
      // ignore
    }
  }

  onMounted(() => {
    void refresh();
    void listen<AiWindowState>('ai-window-state', (event) => {
      visible.value = event.payload.visible;
    }).then((cleanup) => {
      unlisten = cleanup;
    });
  });

  onUnmounted(() => {
    unlisten?.();
    unlisten = null;
  });

  return {
    visible,
    refresh,
    toggle,
  };
}
