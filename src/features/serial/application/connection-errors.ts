import { t } from '@/lib/i18n';
import type { SerialConnectionFailure } from '@/features/serial/application/serial-connection-failure';

export * from '@/features/serial/application/serial-connection-failure';

/** UI-only localization adapter for the structured application failure. */
export function serialConnectionFailureMessage(failure: SerialConnectionFailure): string {
  switch (failure.category) {
    case 'port-in-use':
      return t('serial.open.portInUse', {
        session: failure.conflict?.ownerSessionName ?? failure.conflict?.ownerSessionId ?? '',
      });
    case 'device-missing':
      return t('serial.open.deviceMissing');
    case 'permission-denied':
      return t('serial.open.permissionDenied');
    case 'backend-failure':
      return t('serial.open.backendFailure');
    case 'invalid-port':
      return t('error.invalid_input');
  }
}
