import { createDiscreteApi } from 'naive-ui';
import { useSessionStore } from '../stores/sessions';
import { useSerialStore } from '../stores/serial';
import { useAppStore } from '../stores/app';
import { t } from '../lib/i18n';
import type { PortConfig } from '../types';

let dialogInstance: ReturnType<typeof createDiscreteApi>['dialog'] | null = null;

function getDialog() {
  if (!dialogInstance) {
    dialogInstance = createDiscreteApi(['dialog']).dialog;
  }
  return dialogInstance;
}

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

    getDialog().warning({
      title: t('dialog.closeConnectedTitle'),
      content: t('dialog.closeConnectedContent', { port: session.portName }),
      positiveText: t('common.close'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        void sessionStore.removeSession(id);
      },
    });
  }

  function requestClearFrames(sessionId: string) {
    const session = sessionStore.sessions.find((s) => s.id === sessionId);
    if (!session || session.frames.length === 0) return;

    getDialog().warning({
      title: t('dialog.clearDataTitle'),
      content: t('dialog.clearDataContent'),
      positiveText: t('common.clear'),
      negativeText: t('common.cancel'),
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
