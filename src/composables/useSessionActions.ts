import { createDiscreteApi } from 'naive-ui';
import { useSessionStore } from '../stores/sessions';
import { useSerialStore } from '../stores/serial';
import { useAppStore } from '../stores/app';
import type { PortConfig } from '../types';

const { dialog } = createDiscreteApi(['dialog']);

export function useSessionActions() {
  const sessionStore = useSessionStore();
  const serialStore = useSerialStore();
  const appStore = useAppStore();

  function createSession(portName: string, config: PortConfig): string | null {
    if (!portName) return null;
    serialStore.setPortConfig(config);
    const id = sessionStore.createSession(portName, { ...config });
    const pendingCommand = appStore.consumePendingAiCommand();
    if (pendingCommand) {
      sessionStore.setSendDraft(id, pendingCommand);
    }
    return id;
  }

  function requestCloseSession(id: string) {
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (!session) return;

    if (!session.isConnected) {
      void sessionStore.removeSession(id);
      return;
    }

    dialog.warning({
      title: '关闭连接中的会话',
      content: `会话 ${session.portName} 正在连接中，确定要关闭吗？`,
      positiveText: '关闭',
      negativeText: '取消',
      onPositiveClick: () => {
        void sessionStore.removeSession(id);
      },
    });
  }

  function requestClearFrames(sessionId: string) {
    const session = sessionStore.sessions.find((s) => s.id === sessionId);
    if (!session || session.frames.length === 0) return;

    dialog.warning({
      title: '清空数据',
      content: '确定要清空所有数据吗？此操作不可恢复。',
      positiveText: '清空',
      negativeText: '取消',
      onPositiveClick: () => {
        sessionStore.clearFrames(sessionId);
      },
    });
  }

  return {
    createSession,
    requestCloseSession,
    requestClearFrames,
  };
}
