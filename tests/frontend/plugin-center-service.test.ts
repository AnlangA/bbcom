import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PluginCenterService,
  TauriPluginCenterPort,
  type PluginCenterData,
  type PluginCenterPort,
  type PluginPortOutcome,
  type PluginSurfaceSnapshot,
} from '../../src/features/plugins';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

function data(overrides: Partial<PluginCenterData> = {}): PluginCenterData {
  return {
    revision: 1,
    catalog: [],
    installed: [],
    sources: [],
    ...overrides,
  };
}

function installedPlugin(pluginId = 'tools.capture') {
  return {
    pluginId,
    displayName: 'Capture Tools',
    version: '1.0.0',
    status: 'stopped' as const,
    statusReason: null,
    enabled: false,
    pendingVersion: null,
    requestedCapabilities: [],
    effectiveCapabilities: [],
    runtime: null,
  };
}

function completed(next: PluginCenterData): PluginPortOutcome {
  return { outcome: 'completed', data: next };
}

function createPort(initial: PluginCenterData = data()) {
  let listener: ((snapshot: PluginCenterData) => void) | null = null;
  const port: PluginCenterPort = {
    requestLocalSourceGrant: vi.fn(async () => 'plugin-grant-fixture'),
    snapshot: vi.fn(async () => completed(initial)),
    install: vi.fn(async () => completed(data({ revision: 2 }))),
    installLocal: vi.fn(async () => completed(data({ revision: 2 }))),
    uninstall: vi.fn(async () => completed(data({ revision: 2 }))),
    setEnabled: vi.fn(async () => completed(data({ revision: 2 }))),
    addSource: vi.fn(async () => completed(data({ revision: 2 }))),
    updateSource: vi.fn(async () => completed(data({ revision: 2 }))),
    removeSource: vi.fn(async () => completed(data({ revision: 2 }))),
    refreshSource: vi.fn(async () => completed(data({ revision: 2 }))),
    setWatchEnabled: vi.fn(async () => completed(data({ revision: 2 }))),
    subscribe: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  return { port, push: (next: PluginCenterData) => listener?.(next) };
}

describe('PluginCenterService', () => {
  test('owns snapshots outside renderer lifetimes and rejects stale pushes', async () => {
    const { port, push } = createPort();
    const service = new PluginCenterService(port);
    const listener = vi.fn();
    const detach = service.subscribe(listener);
    await service.start();
    detach();
    push(data({ revision: 0 }));
    expect(service.snapshot().failure?.code).toBe('invalid-response');
    expect(service.snapshot().revision).toBe(1);
    expect(port.subscribe).toHaveBeenCalledOnce();
  });

  test('retries an expected-enabled plugin after the renderer bridge is ready', async () => {
    const plugin = { ...installedPlugin(), status: 'failed' as const, enabled: true };
    const { port } = createPort(data({ installed: [plugin] }));
    const service = new PluginCenterService(port);

    await service.start();

    expect(port.setEnabled).toHaveBeenCalledOnce();
    expect(port.setEnabled).toHaveBeenCalledWith(plugin.pluginId, true, expect.any(AbortSignal));
  });

  test('accepts native development source ids derived from dotted plugin ids', async () => {
    const { port } = createPort(
      data({
        sources: [
          {
            sourceId: 'dev-dev.bbcom.counter-v2',
            kind: 'dev-directory',
            displayName: 'Counter v2 Example',
            url: null,
            enabled: true,
            watchEnabled: false,
            health: 'healthy',
            lastAttemptMs: null,
            lastSuccessMs: 1,
            etag: null,
            lastModified: null,
          },
        ],
      }),
    );
    const service = new PluginCenterService(port);
    await service.start();
    expect(service.snapshot().sources[0]?.sourceId).toBe('dev-dev.bbcom.counter-v2');
    expect(service.snapshot().failure).toBeNull();
  });

  test('moves a running operation through cancellation without starting another action', async () => {
    let resolve: ((outcome: PluginPortOutcome) => void) | null = null;
    const { port } = createPort(
      data({
        catalog: [
          {
            catalogId: 'catalog.tools',
            pluginId: 'tools.capture',
            displayName: 'Capture Tools',
            description: 'Tools',
            version: '1.0.0',
            publisherName: 'Publisher',
            installedVersion: null,
          },
        ],
      }),
    );
    vi.mocked(port.install).mockImplementation(
      (_catalogId, signal) =>
        new Promise((done) => {
          resolve = done;
          signal.addEventListener('abort', () => done({ outcome: 'cancelled' }), { once: true });
        }),
    );
    const service = new PluginCenterService(port);
    await service.start();
    const installing = service.install('catalog.tools');
    service.cancelAction();
    expect(service.snapshot().action?.status).toBe('cancelling');
    await installing;
    expect(service.snapshot().action).toBeNull();
    expect(resolve).not.toBeNull();
  });

  test('installs only from a native opaque local-source grant', async () => {
    const { port } = createPort();
    const service = new PluginCenterService(port);
    await service.start();

    await service.installLocal('   ');
    expect(port.installLocal).not.toHaveBeenCalled();
    expect(service.snapshot().failure?.code).toBe('invalid-response');

    await service.installLocal('local-package');
    expect(port.requestLocalSourceGrant).toHaveBeenCalledWith(
      'local-package',
      expect.any(AbortSignal),
    );
    expect(port.installLocal).toHaveBeenCalledWith('plugin-grant-fixture', expect.any(AbortSignal));
    expect(service.snapshot().revision).toBe(2);
  });

  test('uninstalls only plugins that are currently installed', async () => {
    const { port } = createPort(data({ installed: [installedPlugin()] }));
    const service = new PluginCenterService(port);
    await service.start();

    await service.uninstall('missing.plugin');
    expect(port.uninstall).not.toHaveBeenCalled();
    expect(service.snapshot().failure?.code).toBe('invalid-response');

    await service.uninstall('tools.capture');
    expect(port.uninstall).toHaveBeenCalledWith('tools.capture', expect.any(AbortSignal));
    expect(service.snapshot().revision).toBe(2);
  });

  test('can explicitly preserve plugin contributions as user-owned entries', async () => {
    const { port } = createPort(data({ installed: [installedPlugin()] }));
    const service = new PluginCenterService(port);
    await service.start();

    await service.uninstall('tools.capture', 'convert-to-user');
    expect(port.uninstall).toHaveBeenCalledWith(
      'tools.capture',
      expect.any(AbortSignal),
      'convert-to-user',
    );
  });

  test('routes only current generation-bound v2 surface, task, command and authorization actions', async () => {
    const runtime = {
      workspaceId: 'workspace-1',
      pluginId: 'dev.bbcom.mcumgr',
      instanceId: 1,
      generation: 2,
    };
    const surface: PluginSurfaceSnapshot = {
      runtime,
      surfaceId: 'main',
      revision: 1,
      title: 'MCUmgr',
      placement: 'workspace',
      detachedAllowed: true,
      editable: true,
      root: {
        kind: 'button',
        id: 'refresh',
        label: 'Refresh',
        disabled: false,
        dangerous: false,
      },
    };
    const task = {
      runtime,
      taskId: 'upload-1',
      commandId: 'image-upload',
      title: 'Upload firmware',
      status: 'running' as const,
      completed: 1,
      total: 2,
      statusText: 'Uploading',
      cancellable: true,
    };
    const command = {
      runtime,
      commandId: 'image-state',
      title: 'Image state',
      description: 'Read image state',
      dangerous: false,
    };
    const authorization = {
      pluginId: runtime.pluginId,
      displayName: 'MCUmgr',
      version: '1.0.0',
      digestSha256: 'a'.repeat(64),
      developmentSource: false,
      requestedCapabilities: ['serial.io', 'ui.workspace'] as const,
      addedCapabilities: ['serial.io', 'ui.workspace'] as const,
    };
    const initial = data({
      surfaces: [surface],
      tasks: [task],
      commandContributions: [command],
      authorizationRequests: [authorization],
    });
    const { port } = createPort(initial);
    const unchanged = completed({ ...initial, revision: 2 });
    port.emitSurfaceEvent = vi.fn(async () => unchanged);
    port.resolveAuthorization = vi.fn(async () => unchanged);
    port.cancelTask = vi.fn(async () => unchanged);
    port.runCommand = vi.fn(async () => unchanged);
    port.setSurfacePlacement = vi.fn(async () => unchanged);
    const service = new PluginCenterService(port);
    await service.start();

    await service.emitSurfaceEvent({
      runtime,
      surfaceId: 'main',
      revision: 1,
      nodeId: 'refresh',
      event: 'activate',
    });
    await service.resolveAuthorization(authorization, 'approve');
    await service.cancelTask(task);
    await service.runCommand(command);
    await service.setSurfacePlacement(surface, 'detached-window');

    expect(port.emitSurfaceEvent).toHaveBeenCalledOnce();
    expect(port.resolveAuthorization).toHaveBeenCalledOnce();
    expect(port.cancelTask).toHaveBeenCalledOnce();
    expect(port.runCommand).toHaveBeenCalledOnce();
    expect(port.setSurfacePlacement).toHaveBeenCalledOnce();

    await service.emitSurfaceEvent({
      runtime: { ...runtime, generation: 3 },
      surfaceId: 'main',
      revision: 1,
      nodeId: 'refresh',
      event: 'activate',
    });
    expect(port.emitSurfaceEvent).toHaveBeenCalledOnce();
    expect(service.snapshot().failure?.code).toBe('invalid-response');
  });

  test('validates catalog, enablement, local grants, and every source lifecycle transition', async () => {
    const httpsSource = {
      sourceId: 'official.source',
      kind: 'https' as const,
      displayName: 'Official',
      url: 'https://plugins.example.com/catalog.json',
      enabled: true,
      watchEnabled: false,
      health: 'healthy' as const,
      lastAttemptMs: 1,
      lastSuccessMs: 1,
      etag: null,
      lastModified: null,
    };
    const devSource = {
      ...httpsSource,
      sourceId: 'dev.source',
      kind: 'dev-directory' as const,
      displayName: 'Development',
      url: null,
      enabled: true,
      watchEnabled: false,
    };
    const packageSource = {
      ...devSource,
      sourceId: 'package.source',
      kind: 'local-package' as const,
      displayName: 'Package',
    };
    const catalog = [
      {
        catalogId: 'catalog.new',
        pluginId: 'tools.new',
        displayName: 'New',
        description: 'New plugin',
        version: '1.0.0',
        publisherName: 'Publisher',
        installedVersion: null,
      },
      {
        catalogId: 'catalog.update',
        pluginId: 'tools.update',
        displayName: 'Update',
        description: 'Update plugin',
        version: '2.0.0',
        publisherName: 'Publisher',
        installedVersion: '1.0.0',
      },
      {
        catalogId: 'catalog.same',
        pluginId: 'tools.same',
        displayName: 'Same',
        description: 'Same plugin',
        version: '1.0.0',
        publisherName: 'Publisher',
        installedVersion: '1.0.0',
      },
      {
        catalogId: 'catalog.older',
        pluginId: 'tools.older',
        displayName: 'Older',
        description: 'Older plugin',
        version: '1.0.0',
        publisherName: 'Publisher',
        installedVersion: '2.0.0',
      },
    ];
    const disabled = installedPlugin('tools.disabled');
    const enabled = { ...installedPlugin('tools.enabled'), enabled: true };
    const initial = data({
      catalog,
      installed: [disabled, enabled],
      sources: [httpsSource, devSource, packageSource],
    });
    const { port } = createPort(initial);
    const unchanged = completed({ ...initial, revision: 2 });
    for (const method of [
      'install',
      'installLocal',
      'setEnabled',
      'addSource',
      'updateSource',
      'removeSource',
      'refreshSource',
      'setWatchEnabled',
    ] as const) {
      vi.mocked(port[method]).mockResolvedValue(unchanged);
    }
    vi.mocked(port.requestLocalSourceGrant)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('dev-grant');

    const service = new PluginCenterService(port);
    await service.start();
    await service.start();

    await service.install('missing');
    await service.install('catalog.same');
    await service.install('catalog.older');
    await service.install('catalog.new');
    await service.install('catalog.update');
    expect(port.install).toHaveBeenCalledTimes(2);

    await service.setEnabled('missing', true);
    await service.setEnabled('tools.disabled', false);
    await service.setEnabled('tools.disabled', true);
    await service.setEnabled('tools.enabled', false);
    expect(port.setEnabled).toHaveBeenCalledTimes(2);

    await service.installLocal('local-package');
    expect(port.installLocal).not.toHaveBeenCalled();
    await service.installLocal('dev-directory');
    expect(port.installLocal).toHaveBeenCalledWith('dev-grant', expect.any(AbortSignal));

    await service.addSource('x', 'https://plugins.example.com/new.json');
    await service.addSource('new.source', 'http://plugins.example.com/new.json');
    await service.addSource('official.source', 'https://plugins.example.com/new.json');
    await service.addSource('new.source', 'https://plugins.example.com/new.json', false);
    expect(port.addSource).toHaveBeenCalledOnce();

    await service.updateSource('missing.source', 'https://plugins.example.com/new.json', true);
    await service.updateSource('dev.source', 'https://plugins.example.com/new.json', true);
    await service.updateSource(
      'official.source',
      'https://plugins.example.com/new.json?query=1',
      true,
    );
    await service.updateSource('official.source', 'https://plugins.example.com/new.json', false);
    expect(port.updateSource).toHaveBeenCalledOnce();

    await service.removeSource('missing.source');
    await service.removeSource('package.source');
    expect(port.removeSource).toHaveBeenCalledOnce();
    await service.refreshSource('missing.source');
    await service.refreshSource('dev.source');
    await service.refreshSource('official.source');
    expect(port.refreshSource).toHaveBeenCalledOnce();

    await service.setWatchEnabled('missing.source', true);
    await service.setWatchEnabled('official.source', true);
    await service.setWatchEnabled('dev.source', false);
    await service.setWatchEnabled('dev.source', true);
    expect(port.setWatchEnabled).toHaveBeenCalledOnce();
  });

  test('falls back safely when optional v2 action ports are absent', async () => {
    const runtime = {
      workspaceId: 'workspace-1',
      pluginId: 'dev.bbcom.fixture',
      instanceId: 1,
      generation: 1,
    };
    const surface: PluginSurfaceSnapshot = {
      runtime,
      surfaceId: 'main',
      revision: 1,
      title: 'Fixture',
      placement: 'workspace',
      detachedAllowed: true,
      editable: true,
      root: { kind: 'button', id: 'run', label: 'Run', disabled: false, dangerous: false },
    };
    const task = {
      runtime,
      taskId: 'task',
      commandId: 'command',
      title: 'Task',
      status: 'running' as const,
      completed: 0,
      total: 1,
      statusText: '',
      cancellable: true,
    };
    const command = {
      runtime,
      commandId: 'command',
      title: 'Command',
      description: '',
      dangerous: false,
    };
    const authorization = {
      pluginId: runtime.pluginId,
      displayName: 'Fixture',
      version: '1.0.0',
      digestSha256: 'b'.repeat(64),
      developmentSource: false,
      requestedCapabilities: ['ui.workspace'] as const,
      addedCapabilities: ['ui.workspace'] as const,
    };
    const { port } = createPort(
      data({
        surfaces: [surface],
        tasks: [task],
        commandContributions: [command],
        authorizationRequests: [authorization],
      }),
    );
    const service = new PluginCenterService(port);
    await service.start();

    await service.emitSurfaceEvent({
      runtime,
      surfaceId: surface.surfaceId,
      revision: surface.revision,
      nodeId: 'run',
      event: 'activate',
    });
    expect(service.snapshot().failure?.code).toBe('unavailable');
    await service.resolveAuthorization(authorization, 'reject');
    expect(service.snapshot().failure?.code).toBe('unavailable');
    await service.cancelTask(task);
    expect(service.snapshot().failure?.code).toBe('unavailable');
    await service.runCommand(command);
    expect(service.snapshot().failure?.code).toBe('unavailable');
    await service.setSurfacePlacement(surface, 'detached-window');
    expect(service.snapshot().failure?.code).toBe('unavailable');

    await service.resolveAuthorization(authorization, 'invalid' as never);
    await service.cancelTask({ ...task, cancellable: false });
    await service.runCommand({ ...command, commandId: 'missing' });
    await service.setSurfacePlacement(surface, 'workspace');
    expect(service.snapshot().failure?.code).toBe('invalid-response');

    const restrictedSurface = { ...surface, detachedAllowed: false };
    const { port: restrictedPort } = createPort(data({ surfaces: [restrictedSurface] }));
    const restrictedService = new PluginCenterService(restrictedPort);
    await restrictedService.start();
    await restrictedService.setSurfacePlacement(restrictedSurface, 'detached-window');
    expect(restrictedService.snapshot().failure?.code).toBe('invalid-response');
  });
});

describe('TauriPluginCenterPort local install and uninstall transport', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReset();
  });

  test('install_local sends only the opaque grant and accepts the refreshed snapshot', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockImplementation(async (command: string, args: unknown) => {
      expect(command).toBe('plugin_install_local');
      const request = (args as { request: Record<string, unknown> }).request;
      expect(request.grantId).toBe('plugin-grant-fixture');
      expect(typeof request.requestId).toBe('string');
      expect(typeof request.operationId).toBe('string');
      expect(request.revision).toBe(0);
      return {
        outcome: 'completed',
        requestId: request.requestId,
        operationId: request.operationId,
        revision: 2,
        data: data({ revision: 2 }),
      };
    });

    const port = new TauriPluginCenterPort();
    const observed: number[] = [];
    port.subscribe((next) => observed.push(next.revision));
    const outcome = await port.installLocal('plugin-grant-fixture', new AbortController().signal);

    expect(outcome).toEqual({ outcome: 'completed', data: data({ revision: 2 }) });
    expect(observed).toEqual([2]);
  });

  test('plugin_uninstall passes the plugin identity through and maps command failures', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockImplementation(async (command: string, args: unknown) => {
      expect(command).toBe('plugin_uninstall');
      const request = (args as { request: Record<string, unknown> }).request;
      expect(request.pluginId).toBe('tools.capture');
      expect(request.contributionDisposition).toBe('delete');
      expect(typeof request.requestId).toBe('string');
      expect(typeof request.operationId).toBe('string');
      return {
        outcome: 'failed',
        requestId: request.requestId,
        operationId: request.operationId,
        revision: 1,
        failure: { code: 'installation-failed' },
      };
    });

    const outcome = await new TauriPluginCenterPort().uninstall(
      'tools.capture',
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      outcome: 'failed',
      failure: { code: 'installation-failed' },
    });
  });

  test('local commands stay unavailable outside the native runtime', async () => {
    tauri.isTauri.mockReturnValue(false);
    const port = new TauriPluginCenterPort();
    expect(await port.installLocal('/tmp/plugin-package', new AbortController().signal)).toEqual({
      outcome: 'failed',
      failure: { code: 'unavailable' },
    });
    expect(await port.uninstall('tools.capture', new AbortController().signal)).toEqual({
      outcome: 'failed',
      failure: { code: 'unavailable' },
    });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  test('native rejections map AppErrorCode strings to failure codes', async () => {
    tauri.isTauri.mockReturnValue(true);
    const rejections: [unknown, string][] = [
      [{ code: 'INVALID_INPUT' }, 'invalid-input'],
      [{ code: 'BUSY' }, 'operation-conflict'],
      [{ code: 'REVISION_CONFLICT' }, 'operation-conflict'],
      [{ code: 'SECURITY_DENIED' }, 'unavailable'],
      ['not-a-tauri-error', 'unavailable'],
    ];
    for (const [rejection, expected] of rejections) {
      tauri.invoke.mockImplementation(async () => {
        throw rejection;
      });
      const outcome = await new TauriPluginCenterPort().installLocal(
        '/tmp/plugin-package',
        new AbortController().signal,
      );
      expect(outcome).toEqual({ outcome: 'failed', failure: { code: expected } });
    }
  });

  test('v2 UI actions use generated generation-bound request contracts', async () => {
    tauri.isTauri.mockReturnValue(true);
    const seen: string[] = [];
    tauri.invoke.mockImplementation(async (commandName: string, args: unknown) => {
      seen.push(commandName);
      const request = (args as { request: Record<string, unknown> }).request;
      return {
        outcome: 'completed',
        requestId: request.requestId,
        operationId: request.operationId,
        revision: 1,
        data: data(),
      };
    });
    const port = new TauriPluginCenterPort();
    const runtime = {
      workspaceId: 'workspace-1',
      pluginId: 'dev.bbcom.mcumgr',
      instanceId: 1,
      generation: 2,
    };

    await port.emitSurfaceEvent(
      {
        runtime,
        surfaceId: 'main',
        revision: 1,
        nodeId: 'refresh',
        event: 'activate',
      },
      new AbortController().signal,
    );
    await port.resolveAuthorization(
      {
        pluginId: runtime.pluginId,
        displayName: 'MCUmgr',
        version: '1.0.0',
        digestSha256: 'a'.repeat(64),
        developmentSource: false,
        requestedCapabilities: ['serial.io', 'ui.workspace'],
        addedCapabilities: ['serial.io', 'ui.workspace'],
      },
      'approve',
      new AbortController().signal,
    );

    expect(seen).toEqual(['plugin_emit_surface_event_v2', 'plugin_resolve_authorization_v2']);
    expect(tauri.invoke.mock.calls[0]?.[1]).not.toHaveProperty('path');
  });
});
