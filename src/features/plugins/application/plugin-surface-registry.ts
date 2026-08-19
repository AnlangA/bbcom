import type {
  PluginSurfacePatch,
  PluginSurfaceSnapshot,
  PluginSurfaceUpdateV2,
  RuntimeInstanceKey,
} from '../../../generated/ipc-contracts';
import {
  applyPluginSurfacePatch,
  freezeSurface,
  validatePluginSurface,
  type SurfaceValidationFailure,
} from '../domain/plugin-surface-v2';

export type PluginSurfaceRegistryResult =
  | Readonly<{ ok: true; changed: boolean }>
  | Readonly<{ ok: false; failure: SurfaceValidationFailure }>;

/** Application-owned revision gate for full snapshots and atomic patches. */
export class PluginSurfaceRegistry {
  private readonly surfaces = new Map<string, PluginSurfaceSnapshot>();

  replaceAll(surfaces: readonly PluginSurfaceSnapshot[]): PluginSurfaceRegistryResult {
    const next = new Map<string, PluginSurfaceSnapshot>();
    for (const surface of surfaces) {
      const validation = validatePluginSurface(surface);
      if (!validation.ok) return validation;
      const key = surfaceKey(surface.runtime, surface.surfaceId);
      if (next.has(key)) return duplicateFailure(surface.surfaceId);
      next.set(key, freezeSurface(surface));
    }
    this.surfaces.clear();
    for (const [key, surface] of next) this.surfaces.set(key, surface);
    return { ok: true, changed: true };
  }

  apply(update: PluginSurfaceUpdateV2): PluginSurfaceRegistryResult {
    switch (update.kind) {
      case 'snapshot':
        return this.publish(update.surface);
      case 'patch':
        return this.patch(update.patch);
      case 'remove':
        return {
          ok: true,
          changed: this.surfaces.delete(surfaceKey(update.runtime, update.surfaceId)),
        };
    }
  }

  snapshot(): readonly PluginSurfaceSnapshot[] {
    return Object.freeze(
      [...this.surfaces.values()].sort((left, right) =>
        surfaceKey(left.runtime, left.surfaceId).localeCompare(
          surfaceKey(right.runtime, right.surfaceId),
        ),
      ),
    );
  }

  revokeRuntime(runtime: RuntimeInstanceKey): number {
    const prefix = runtimePrefix(runtime);
    const keys = [...this.surfaces.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) this.surfaces.delete(key);
    return keys.length;
  }

  private publish(surface: PluginSurfaceSnapshot): PluginSurfaceRegistryResult {
    const validation = validatePluginSurface(surface);
    if (!validation.ok) return validation;
    const key = surfaceKey(surface.runtime, surface.surfaceId);
    const previous = this.surfaces.get(key);
    if (previous && surface.revision <= previous.revision) {
      return {
        ok: false,
        failure: { code: 'stale-revision', detail: 'snapshot revision' },
      };
    }
    this.surfaces.set(key, freezeSurface(surface));
    return { ok: true, changed: true };
  }

  private patch(patch: PluginSurfacePatch): PluginSurfaceRegistryResult {
    const key = surfaceKey(patch.runtime, patch.surfaceId);
    const current = this.surfaces.get(key);
    if (!current) {
      return {
        ok: false,
        failure: { code: 'stale-revision', detail: 'unknown surface' },
      };
    }
    const result = applyPluginSurfacePatch(current, patch);
    if (!result.ok) return result;
    this.surfaces.set(key, result.surface);
    return { ok: true, changed: true };
  }
}

function surfaceKey(runtime: RuntimeInstanceKey, surfaceId: string): string {
  return `${runtimePrefix(runtime)}${surfaceId}`;
}

function runtimePrefix(runtime: RuntimeInstanceKey): string {
  return `${runtime.workspaceId}\u0000${runtime.pluginId}\u0000${runtime.instanceId}\u0000${runtime.generation}\u0000`;
}

function duplicateFailure(surfaceId: string): {
  ok: false;
  failure: SurfaceValidationFailure;
} {
  return {
    ok: false,
    failure: { code: 'duplicate-node', detail: `duplicate surface ${surfaceId}` },
  };
}
