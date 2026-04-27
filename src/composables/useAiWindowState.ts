import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface AiWindowState {
  visible: boolean;
}

export function useAiWindowState() {
  const visible = ref(false);
  let unlisten: (() => void) | null = null;

  async function refresh() {
    try {
      const state = await invoke<AiWindowState>('get_ai_window_state');
      visible.value = state.visible;
    } catch {
      visible.value = false;
    }
  }

  async function toggle() {
    try {
      if (visible.value) {
        await invoke('hide_ai_window');
        visible.value = false;
      } else {
        await invoke('show_ai_window');
        visible.value = true;
      }
    } catch {
      visible.value = false;
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
