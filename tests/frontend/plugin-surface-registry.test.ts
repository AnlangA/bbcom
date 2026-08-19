import { describe, expect, test } from 'vitest';
import type { PluginSurfaceSnapshot } from '../../src/generated/ipc-contracts';
import { PluginSurfaceRegistry } from '../../src/features/plugins';

function surface(revision = 1, text = 'one'): PluginSurfaceSnapshot {
  return {
    runtime: {
      workspaceId: 'workspace-1',
      pluginId: 'example.plugin',
      instanceId: 1,
      generation: 1,
    },
    surfaceId: 'main',
    revision,
    title: 'Example',
    placement: 'workspace',
    detachedAllowed: false,
    editable: true,
    root: { kind: 'text', id: 'status', text, tone: 'default' },
  };
}

describe('PluginSurfaceRegistry', () => {
  test('accepts newer resync snapshots and rejects stale publication', () => {
    const registry = new PluginSurfaceRegistry();
    expect(registry.apply({ kind: 'snapshot', surface: surface() })).toEqual({
      ok: true,
      changed: true,
    });
    expect(registry.apply({ kind: 'snapshot', surface: surface() })).toMatchObject({
      ok: false,
      failure: { code: 'stale-revision' },
    });
    expect(registry.apply({ kind: 'snapshot', surface: surface(2, 'two') })).toEqual({
      ok: true,
      changed: true,
    });
    expect(JSON.stringify(registry.snapshot()[0]?.root)).toContain('two');
  });

  test('applies exact-base patches and preserves current state on conflicts', () => {
    const registry = new PluginSurfaceRegistry();
    registry.replaceAll([surface()]);
    const runtime = surface().runtime;
    expect(
      registry.apply({
        kind: 'patch',
        patch: {
          runtime,
          surfaceId: 'main',
          baseRevision: 1,
          nextRevision: 2,
          operations: [{ kind: 'set-text', nodeId: 'status', text: 'patched' }],
        },
      }),
    ).toEqual({ ok: true, changed: true });
    expect(
      registry.apply({
        kind: 'patch',
        patch: {
          runtime,
          surfaceId: 'main',
          baseRevision: 1,
          nextRevision: 2,
          operations: [{ kind: 'set-text', nodeId: 'status', text: 'stale' }],
        },
      }),
    ).toMatchObject({ ok: false, failure: { code: 'stale-revision' } });
    expect(JSON.stringify(registry.snapshot()[0]?.root)).toContain('patched');
    expect(JSON.stringify(registry.snapshot()[0]?.root)).not.toContain('stale');
  });

  test('revoke is exact to workspace, instance, and generation', () => {
    const registry = new PluginSurfaceRegistry();
    const previous = surface();
    const current = {
      ...surface(),
      runtime: { ...surface().runtime, generation: 2 },
    };
    registry.replaceAll([previous, current]);
    expect(registry.revokeRuntime(previous.runtime)).toBe(1);
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]?.runtime.generation).toBe(2);
  });
});
