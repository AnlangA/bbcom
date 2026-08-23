import { getCurrentInstance, ref, onMounted, onUnmounted } from 'vue';
import {
  getAiWindowState,
  hideAiWindow,
  listenNativeEvent,
  showAiWindow,
  type AiWindowState,
} from '@/features/platform/native';
import { logger } from '@/lib/logger';

/** Injectable AI-window control surface so the toggle/refresh logic is
 *  unit-testable without a Tauri runtime. Defaults wire through to the real IPC. */
export interface UseAiWindowStateDeps {
  getState?: () => Promise<AiWindowState>;
  show?: () => Promise<void>;
  hide?: () => Promise<void>;
}

export function useAiWindowState(deps: UseAiWindowStateDeps = {}) {
  const visible = ref(false);
  let unlisten: (() => void) | null = null;
  const getState = deps.getState ?? getAiWindowState;
  const showWindow = deps.show ?? showAiWindow;
  const hideWindow = deps.hide ?? hideAiWindow;

  async function refresh() {
    try {
      const state = await getState();
      visible.value = state.visible;
    } catch (e) {
      logger.debug('ai-window state query failed:', e);
      visible.value = false;
    }
  }

  async function toggle() {
    try {
      if (visible.value) {
        await hideWindow();
        visible.value = false;
      } else {
        await showWindow();
        visible.value = true;
      }
    } catch (e) {
      // User clicked the AI toggle but show/hide failed — surface it so the
      // silent no-op is at least diagnosable, then re-query instead of
      // guessing: assuming `false` after a failed hide leaves the toggle
      // showing the opposite of the still-visible window.
      logger.warn('ai-window toggle failed:', e);
      await refresh();
    }
  }

  if (getCurrentInstance()) {
    onMounted(() => {
      void refresh();
      void listenNativeEvent<AiWindowState>('ai-window-state', (event) => {
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
  }

  return {
    visible,
    refresh,
    toggle,
  };
}
