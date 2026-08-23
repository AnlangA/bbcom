import { getCurrentInstance, inject } from 'vue';
import { useDialog } from 'naive-ui';
import { useSerialStore } from '@/features/serial/store/serial-store';
import { useAppStore } from '@/features/settings/store/app-store';
import { logger } from '@/lib/logger';
import { t } from '@/lib/i18n';
import type { PortConfig } from '@/types';
import { sessionHasClearableCapture } from '@/lib/session-store-helpers';
import {
  SESSION_APPLICATION_SERVICES_KEY,
  type SessionApplicationServices,
} from '@/features/sessions/runtime/session-application-services';
import {
  SessionApplicationService,
  useSessionCapture,
  useSessionCatalog,
  useSessionDocument,
  useSessionMutationPolicy,
  useSessionRuntimeStatuses,
} from '@/features/sessions';

export function useSessionActions() {
  const catalog = useSessionCatalog();
  const mutationPolicy = useSessionMutationPolicy();
  const serialStore = useSerialStore();
  const appStore = useAppStore();
  const applicationServices = getCurrentInstance()
    ? (inject(SESSION_APPLICATION_SERVICES_KEY, null) as SessionApplicationServices | null)
    : null;
  const { isConnected } = useSessionRuntimeStatuses();
  const sessions = new SessionApplicationService({
    catalog,
    mutationPolicy,
    captureFor: useSessionCapture,
    documentFor: useSessionDocument,
    runtimeIsImportant: (sessionId) => {
      if (isConnected(sessionId)) return true;
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
    },
  });
  // The dialog provider is mounted in App.vue; createDiscreteApi would drag a
  // second provider tree into the startup bundle for the same confirmations.
  const dialog = getCurrentInstance() ? useDialog() : null;

  function getDialog() {
    if (!dialog) {
      logger.warn('session confirmation dialog is unavailable without a dialog provider');
      return null;
    }
    return dialog;
  }

  function createSession(portName: string, config: PortConfig): string | null {
    const id = sessions.createSession(portName, config);
    if (!id) return null;
    serialStore.setPortConfig(config);
    const pendingCommand = appStore.consumePendingAiCommand();
    if (pendingCommand) {
      useSessionDocument(id).setSendDraft(id, pendingCommand);
    }
    return id;
  }

  function requestCloseSession(id: string) {
    if (!mutationPolicy.userMutationsAllowed.value) return;
    const session = sessions.session(id);
    if (!session) return;

    if (!isImportantSession(id)) {
      void sessions.remove(id);
      return;
    }

    getDialog()?.warning({
      title: t('dialog.closeImportantTitle'),
      content: t('dialog.closeImportantContent', {
        name: session.portName || id,
        frames: session.frames.length + session.pausedFrames.length,
      }),
      positiveText: t('common.close'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        void sessions.remove(id);
      },
    });
  }

  function isImportantSession(sessionId: string): boolean {
    return sessions.isImportant(sessionId);
  }

  function requestClearFrames(
    sessionId: string,
    clear: () => void = () => {
      sessions.clearCapture(sessionId);
    },
  ) {
    if (!mutationPolicy.userMutationsAllowed.value) return;
    const session = sessions.session(sessionId);
    if (!session || !sessionHasClearableCapture(session)) return;

    getDialog()?.warning({
      title: t('dialog.clearDataTitle'),
      content: t('dialog.clearDataContent'),
      positiveText: t('common.clear'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        clear();
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
