import { invoke } from '@tauri-apps/api/core';

export async function invokeWithTimeout<T>(
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    invoke<T>(cmd, args),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`操作超时 (${timeoutMs / 1000}s)`)), timeoutMs),
    ),
  ]);
}
