export function getAiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return fallback;

  const obj = error as Record<string, unknown>;

  if (obj.details && typeof obj.details === 'object') {
    const details = obj.details as Record<string, unknown>;
    if (typeof details.message === 'string' && details.message) return details.message;
  }

  if (typeof obj.message === 'string') return obj.message;

  return fallback;
}
