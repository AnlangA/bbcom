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
  let disposed = false;
  const getState = deps.getState ?? getAiWindowState;
  const showWindow = deps.show ?? showAiWindow;
  const hideWindow = deps.hide ?? hideAiWindow;

  async function refresh() {
    if (disposed) return;
    try {
      const state = await getState();
      if (!disposed) visible.value = state.visible;
    } catch (e) {
      logger.debug('ai-window state query failed:', e);
      if (!disposed) visible.value = false;
    }
  }

  async function toggle() {
    if (disposed) return;
    try {
      if (visible.value) {
        await hideWindow();
        if (!disposed) visible.value = false;
      } else {
        await showWindow();
        if (!disposed) visible.value = true;
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
        if (!disposed) visible.value = event.payload.visible;
      })
        .then((cleanup) => {
          if (disposed) {
            cleanup();
            return;
          }
          unlisten = cleanup;
        })
        .catch((e) => {
          logger.debug('ai-window event bridge unavailable:', e);
        });
    });

    onUnmounted(() => {
      disposed = true;
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
