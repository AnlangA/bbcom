import { t } from './i18n';

export function getAiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return fallback;
  if (!error || typeof error !== 'object') return fallback;

  const obj = error as Record<string, unknown>;

  const messageKey = typeof obj.messageKey === 'string' ? obj.messageKey : null;
  if (messageKey?.startsWith('error.')) return t(messageKey);

  // Commands expose a stable code/messageKey contract instead of backend
  // prose. Keep all user-facing text in the active locale and never display an
  // accidental native error that could contain sensitive context.
  switch (obj.code) {
    case 'BUSY':
      return t('error.busy');
    case 'CANCELLED':
      return t('error.cancelled');
    case 'TIMEOUT':
      return t('error.timeout');
    case 'AI_PROVIDER_FAILED':
      return t('error.ai_request_failed');
    case 'SECURITY_DENIED':
      return t('error.security_denied');
    default:
      break;
  }

  return fallback;
}
