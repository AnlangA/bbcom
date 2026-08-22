import { describe, expect, it, vi } from 'vitest';
import {
  SessionRuntimeWorkspaceParticipant,
  WorkspaceTransitionCoordinator,
  type WorkspaceTransitionParticipant,
} from '@/features/workspace';

function participant(id: string, calls: string[]): WorkspaceTransitionParticipant {
  return {
    id,
    quiesce: () => calls.push(`${id}:quiesce`),
    dispose: () => calls.push(`${id}:dispose`),
    restore: () => calls.push(`${id}:restore`),
    activateStopped: () => calls.push(`${id}:activate`),
    commit: () => calls.push(`${id}:commit`),
  };
}

describe('WorkspaceTransitionCoordinator', () => {
  it('runs forward phases in registration order and restore in reverse', async () => {
    const calls: string[] = [];
    const coordinator = new WorkspaceTransitionCoordinator([
      participant('session', calls),
      participant('plugin', calls),
    ]);
    const persistence = { workspaceId: 'old', accepting: false } as never;
    await coordinator.quiesce({ transitionId: 't1', previousWorkspaceId: 'old', persistence });
    await coordinator.dispose({
      transitionId: 't1',
      previousWorkspaceId: 'old',
      nextWorkspaceId: 'new',
    });
    await coordinator.restore({
      transitionId: 't1',
      previousWorkspaceId: 'old',
      failedWorkspaceId: 'new',
    });
    expect(calls).toEqual([
      'session:quiesce',
      'plugin:quiesce',
      'session:dispose',
      'plugin:dispose',
      'plugin:restore',
      'session:restore',
    ]);
  });

  it('does not repeat a completed phase for one transition id', async () => {
    const calls: string[] = [];
    const coordinator = new WorkspaceTransitionCoordinator([participant('session', calls)]);
    const context = {
      transitionId: 't1',
      previousWorkspaceId: 'old',
      persistence: { workspaceId: 'old', accepting: false } as never,
    };
    await coordinator.quiesce(context);
    await coordinator.quiesce(context);
    expect(calls).toEqual(['session:quiesce']);
  });

  it('continues reverse restore and reports all failures', async () => {
    const restoreFirst = vi.fn(() => {
      throw new Error('first');
    });
    const restoreSecond = vi.fn();
    const coordinator = new WorkspaceTransitionCoordinator([
      { ...participant('first', []), restore: restoreFirst },
      { ...participant('second', []), restore: restoreSecond },
    ]);
    const persistence = { workspaceId: 'old', accepting: false } as never;
    await coordinator.quiesce({ transitionId: 't1', previousWorkspaceId: 'old', persistence });
    await expect(
      coordinator.restore({
        transitionId: 't1',
        previousWorkspaceId: 'old',
        failedWorkspaceId: 'new',
      }),
    ).rejects.toThrow(/restore failed/);
    expect(restoreSecond).toHaveBeenCalledOnce();
    expect(restoreFirst).toHaveBeenCalledOnce();
  });
});

describe('workspace transition participants', () => {
  it('drains, disposes, restores, activates, and commits resident sessions', async () => {
    const sessions = [
      { sessionId: 's1', session: { id: 's1' } },
      { sessionId: 's2', session: { id: 's2' } },
    ] as never;
    const registry = {
      list: vi.fn(() => sessions),
      disposeSession: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      ensure: vi.fn(async () => undefined),
    } as never;
    const statuses = { reconcile: vi.fn() };
    const beginPersistenceDrain = vi.fn();
    const endPersistenceDrain = vi.fn();
    const setMutationPermissions = vi.fn();
    const preflightRuntimeCapture = vi.fn(() => true);
    const participant = new SessionRuntimeWorkspaceParticipant({
      registry,
      statuses,
      prepareRuntimes: vi.fn(async () => undefined),
      beginPersistenceDrain,
      endPersistenceDrain,
      setMutationPermissions,
      preflightRuntimeCapture,
    });
    const persistence = { workspaceId: 'old', accepting: false } as never;
    await participant.quiesce({ transitionId: 't1', previousWorkspaceId: 'old', persistence });
    expect(beginPersistenceDrain).toHaveBeenCalledWith(persistence);
    expect(endPersistenceDrain).toHaveBeenCalledWith(persistence);
    expect(setMutationPermissions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userMutations: false, runtimeCapture: true }),
    );
    expect(setMutationPermissions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userMutations: false, runtimeCapture: false }),
    );

    await participant.dispose({
      transitionId: 't1',
      previousWorkspaceId: 'old',
      nextWorkspaceId: 'new',
    });
    expect(registry.disposeSession).toHaveBeenCalledTimes(2);
    expect(statuses.reconcile).toHaveBeenCalledWith([]);

    await participant.restore({
      transitionId: 't1',
      previousWorkspaceId: 'old',
      failedWorkspaceId: 'new',
    });
    expect(registry.ensure).toHaveBeenCalledTimes(2);
    await participant.activateStopped({
      transitionId: 't2',
      workspace: { workspaceId: 'new', sessions: [{ session: { id: 's3' } }] },
    } as never);
    expect(statuses.reconcile).toHaveBeenLastCalledWith(['s3']);
    participant.commit({ transitionId: 't1', workspaceId: 'old' });
  });

  it('always closes the persistence drain when runtime preparation fails', async () => {
    const endPersistenceDrain = vi.fn();
    const participant = new SessionRuntimeWorkspaceParticipant({
      registry: { list: () => [] } as never,
      statuses: { reconcile: vi.fn() },
      prepareRuntimes: vi.fn(async () => {
        throw new Error('prepare failed');
      }),
      beginPersistenceDrain: vi.fn(),
      endPersistenceDrain,
      setMutationPermissions: vi.fn(),
      preflightRuntimeCapture: vi.fn(() => false),
    });
    await expect(
      participant.quiesce({
        transitionId: 'failure',
        previousWorkspaceId: null,
        persistence: {} as never,
      }),
    ).rejects.toThrow('prepare failed');
    expect(endPersistenceDrain).toHaveBeenCalledOnce();
  });
});
