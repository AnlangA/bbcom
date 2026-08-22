import { describe, expect, it, vi } from 'vitest';
import { SessionRuntimeStatusRegistry } from '@/features/sessions';

describe('SessionRuntimeStatusRegistry', () => {
  it('starts stopped and never hydrates a persisted connected state', () => {
    const registry = new SessionRuntimeStatusRegistry();
    expect(registry.get('session-a')).toEqual({
      phase: 'stopped',
      droppedBytes: 0,
      failure: null,
    });
  });

  it('publishes one authority and reconciles hydrated sessions to stopped', () => {
    const registry = new SessionRuntimeStatusRegistry();
    const listener = vi.fn();
    registry.subscribe('session-a', listener);
    registry.publish('session-a', {
      phase: 'reconnecting',
      droppedBytes: 12,
      failure: 'SERIAL_DISCONNECTED',
    });
    expect(registry.get('session-a').phase).toBe('reconnecting');

    registry.reconcile(['session-a']);
    expect(registry.get('session-a')).toEqual({
      phase: 'stopped',
      droppedBytes: 0,
      failure: null,
    });
    expect(listener).toHaveBeenLastCalledWith(registry.get('session-a'));
  });

  it('rejects invalid counters and removes deleted identities', () => {
    const registry = new SessionRuntimeStatusRegistry();
    expect(() =>
      registry.publish('session-a', { phase: 'connected', droppedBytes: -1, failure: null }),
    ).toThrow(/dropped bytes/);
    registry.publish('session-a', { phase: 'connected', droppedBytes: 0, failure: null });
    registry.reconcile([]);
    expect(registry.get('session-a').phase).toBe('stopped');
  });
});
