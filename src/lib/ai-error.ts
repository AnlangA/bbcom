export function getAiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return fallback;

  const obj = error as Record<string, unknown>;

  // v0.5 Rust commands expose a stable code/messageKey contract instead of
  // returning backend prose. Keep user-facing text local and never display an
  // accidental native error that could contain sensitive context.
  switch (obj.code) {
    case 'BUSY':
      return 'AI 请求正在处理中，请稍后重试';
    case 'CANCELLED':
      return 'AI 请求已取消';
    case 'TIMEOUT':
      return 'AI 请求超时，请稍后重试';
    case 'SECURITY_DENIED':
      return 'AI 密钥未配置或当前窗口无权执行该操作';
    default:
      break;
  }

  if (obj.details && typeof obj.details === 'object') {
    const details = obj.details as Record<string, unknown>;
    if (typeof details.message === 'string' && details.message) return details.message;
  }

  if (typeof obj.message === 'string') return obj.message;

  return fallback;
}
