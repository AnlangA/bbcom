import { getCurrentInstance, inject } from 'vue';
import { createDiscreteApi } from 'naive-ui';
import { useSessionStore } from '../stores/sessions';
import { useSerialStore } from '../stores/serial';
import { useAppStore } from '../stores/app';
import { t } from '../lib/i18n';
import type { PortConfig } from '../types';
import { SESSION_APPLICATION_SERVICES_KEY } from '../features/sessions/runtime/session-application-services';

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
  const applicationServices = getCurrentInstance()
    ? inject(SESSION_APPLICATION_SERVICES_KEY, null)
    : null;

  function createSession(portName: string, config: PortConfig): string | null {
    if (!portName || !sessionStore.userMutationsAllowed) return null;
    const id = sessionStore.createSession(portName, { ...config });
    if (!id) return null;
    serialStore.setPortConfig(config);
    const pendingCommand = appStore.consumePendingAiCommand();
    if (pendingCommand) {
      sessionStore.setSendDraft(id, pendingCommand);
    }
    return id;
  }

  function requestCloseSession(id: string) {
    if (!sessionStore.userMutationsAllowed) return;
    const session = sessionStore.sessions.find((s) => s.id === id);
    if (!session) return;

    if (!isImportantSession(id)) {
      void sessionStore.removeSession(id);
      return;
    }

    getDialog().warning({
      title: t('dialog.closeImportantTitle'),
      content: t('dialog.closeImportantContent', {
        name: session.portName || id,
        frames: session.frames.length + session.pausedFrames.length,
      }),
      positiveText: t('common.close'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        void sessionStore.removeSession(id);
      },
    });
  }

  function isImportantSession(sessionId: string): boolean {
    const session = sessionStore.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    if (
      session.frames.length > 0 ||
      session.pausedFrames.length > 0 ||
      session.isConnected ||
      session.autoLogEnabled ||
      sessionStore.isSessionConfigurationDirty(sessionId)
    ) {
      return true;
    }

    const runtime = applicationServices?.runtimeRegistry.get(sessionId);
    if (
      runtime &&
      (runtime.isConnecting.value ||
        runtime.reconnecting.value ||
        runtime.looping.value ||
        runtime.macro.running.value ||
        runtime.modbus.master.running.value ||
        runtime.modbus.master.replaying.value ||
        runtime.modbus.master.writing.value)
    ) {
      return true;
    }

    return Boolean(
      applicationServices?.operationRegistry
        .snapshot()
        .some(
          (operation) =>
            operation.sessionId === sessionId &&
            (operation.status === 'queued' ||
              operation.status === 'running' ||
              operation.status === 'cancelling'),
        ),
    );
  }

  function requestClearFrames(sessionId: string) {
    if (!sessionStore.userMutationsAllowed) return;
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
    isImportantSession,
    requestClearFrames,
  };
}
