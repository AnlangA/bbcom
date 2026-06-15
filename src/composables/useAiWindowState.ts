import { ref, onMounted, onUnmounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import { getAiWindowState, hideAiWindow, showAiWindow, type AiWindowState } from '../lib/ipc';
import { logger } from '../lib/logger';

export function useAiWindowState() {
  const visible = ref(false);
  let unlisten: (() => void) | null = null;

  async function refresh() {
    try {
      const state = await getAiWindowState();
      visible.value = state.visible;
    } catch (e) {
      logger.debug('ai-window state query failed:', e);
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
    } catch (e) {
      // User clicked the AI toggle but show/hide failed — surface it so the
      // silent no-op is at least diagnosable.
      logger.warn('ai-window toggle failed:', e);
      visible.value = false;
    }
  }

  onMounted(() => {
    void refresh();
    void listen<AiWindowState>('ai-window-state', (event) => {
      visible.value = event.payload.visible;
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((e) => {
        logger.debug('ai-window event bridge unavailable:', e);
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
