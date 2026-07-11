/**
 * Tiny structured logger for the frontend.
 *
 * The rest of `src/` is under `no-console: error`, so this is the single
 * sanctioned place that talks to the console. Routes go through here so
 * diagnostics survive (and are not silently swallowed) in the silent catch
 * blocks scattered across composables and components.
 *
 * `debug`/`info` are gated to dev builds to keep production output quiet;
 * `warn`/`error` always emit because they signal real problems.
 */

type Sink = (...args: unknown[]) => void;

// import.meta.env is Vite-injected; guard for non-Vite (e.g. node test) contexts.
const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
// Vitest intentionally exposes Vite's development flag. Test diagnostics must
// stay deterministic and be asserted explicitly, so it is not a development
// runtime for logger purposes.
const isDev = (env.DEV === true || env.MODE === 'development') && env.MODE !== 'test';

function safe(fn: Sink): Sink {
  return (...args: unknown[]) => {
    try {
      fn(...args);
    } catch {
      // Logging must never throw and break the caller's flow.
    }
  };
}

const prefix = '[bbcom]';

export const logger = {
  debug: safe((...args: unknown[]) => {
    if (isDev) console.debug(prefix, ...args);
  }),
  info: safe((...args: unknown[]) => {
    if (isDev) console.info(prefix, ...args);
  }),
  warn: safe((...args: unknown[]) => {
    console.warn(prefix, ...args);
  }),
  error: safe((...args: unknown[]) => {
    console.error(prefix, ...args);
  }),
};

export type Logger = typeof logger;
