import { vi, type Mock } from 'vitest';

/**
 * Responder for one IPC command: either a constant value (a promise is
 * flattened by the async dispatcher, like a `return` inside an async mock) or
 * a function receiving `(args, command)`.
 */
export type InvokeResponder =
  ((args: unknown, command: string) => unknown) | Promise<unknown> | unknown;

export interface InvokeMockOptions {
  /**
   * Responses indexed by command name. A present-but-`undefined` entry is a
   * configured response, not a missing one (lookups use `in`, not truthiness).
   */
  responses?: Record<string, InvokeResponder>;
  /** Response for commands absent from `responses`. */
  fallback?: InvokeResponder;
  /**
   * Observes every call before dispatch. Mirrors the shared
   * `calls: Array<{ method, args }>` recording pattern used alongside
   * non-invoke Tauri plugin mocks.
   */
  onCall?: (command: string, args: unknown) => void;
}

/**
 * Fallback responder that rejects with the canonical unexpected-command error
 * used by the export and auto-log IPC suites:
 * `unexpected command <command>`.
 */
export function unexpectedCommand(_args: unknown, command: string): never {
  throw new Error(`unexpected command ${command}`);
}

/**
 * Plain per-command dispatcher, for `invoke.mockImplementation(...)` on an
 * existing hoisted `vi.fn()`. Behaviorally identical to the ad-hoc
 * `switch (command)` implementations it replaces, including the
 * `unexpected command` default throw when `fallback: unexpectedCommand`.
 */
export function createInvokeHandler(
  options: InvokeMockOptions = {},
): (command: string, args?: unknown) => Promise<unknown> {
  return async (command, args) => {
    options.onCall?.(command, args);
    const responder =
      options.responses !== undefined && command in options.responses
        ? options.responses[command]
        : options.fallback;
    return typeof responder === 'function' ? responder(args, command) : responder;
  };
}

export type InvokeMock = Mock<(command: string, args?: unknown) => Promise<unknown>>;

/**
 * `vi.fn()`-backed invoke mock with the shared dispatch behavior. Use it
 * inside a `vi.mock('@tauri-apps/api/core', ...)` factory (via dynamic
 * `import()`, since factories run before static imports) or anywhere a fresh
 * recording mock is needed. With no options it behaves like a bare
 * `vi.fn()` whose calls resolve to `undefined`.
 */
export function createInvokeMock(options: InvokeMockOptions = {}): InvokeMock {
  return vi.fn(createInvokeHandler(options));
}
