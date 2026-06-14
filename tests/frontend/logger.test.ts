import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/lib/logger.ts';

/** Stub a console method, return a spy + restore function. */
function stubConsole(method: 'debug' | 'info' | 'warn' | 'error') {
  const calls: unknown[][] = [];
  const original = console[method];
  // eslint-disable-next-line no-console
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      console[method] = original;
    },
  };
}

test('warn and error always emit to their console sinks with the bbcom prefix', () => {
  const warn = stubConsole('warn');
  const error = stubConsole('error');
  try {
    logger.warn('a', 1);
    logger.error('boom', { x: 2 });
  } finally {
    warn.restore();
    error.restore();
  }

  assert.equal(warn.calls.length, 1);
  assert.equal(error.calls.length, 1);
  assert.equal(warn.calls[0]?.[0], '[bbcom]');
  assert.equal(warn.calls[0]?.[1], 'a');
  assert.equal(error.calls[0]?.[1], 'boom');
});

test('debug and info are no-ops outside dev builds (test env has no Vite DEV flag)', () => {
  const debug = stubConsole('debug');
  const info = stubConsole('info');
  try {
    logger.debug('should be skipped');
    logger.info('also skipped');
  } finally {
    debug.restore();
    info.restore();
  }

  assert.equal(debug.calls.length, 0);
  assert.equal(info.calls.length, 0);
});

test('logger never throws even when the console sink throws', () => {
  const warn = stubConsole('warn');
  // Make the sink throw on the next call
  // eslint-disable-next-line no-console
  console.warn = () => {
    throw new Error('sink exploded');
  };
  try {
    assert.doesNotThrow(() => logger.warn('survives a broken sink'));
  } finally {
    warn.restore();
  }
});
