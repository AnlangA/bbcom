import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PluginCenterService,
  TauriPluginCenterPort,
  type PluginCenterData,
  type PluginCenterPort,
  type PluginPortOutcome,
} from '../../src/features/plugins';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

function data(overrides: Partial<PluginCenterData> = {}): PluginCenterData {
  return {
    revision: 1,
    catalog: [],
    installed: [],
    serialProposals: [],
    panels: [],
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
    declaredCapabilities: [],
    effectiveCapabilities: [],
    unavailableCapabilities: [],
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
    resolveSerialProposal: vi.fn(async () => completed(data({ revision: 2 }))),
    emitPanelEvent: vi.fn(async () => completed(data({ revision: 2 }))),
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

  test('keeps serial proposals per request without an authorization workflow', async () => {
    const proposal = {
      runtime: {
        workspaceId: 'workspace-1',
        pluginId: 'tools.capture',
        instanceId: 1,
        generation: 1,
      },
      proposalId: 'proposal-1',
      pluginId: 'tools.capture',
      pluginName: 'Capture Tools',
      sessionLabel: 'Session A',
      displayLabel: 'Send query',
      byteCount: 2,
      hexPreview: '01 02',
      expiresAtMs: 1000,
    };
    const { port } = createPort(data({ serialProposals: [proposal] }));
    const service = new PluginCenterService(port);
    await service.start();
    await service.resolveSerialProposal(proposal.proposalId, 'approve');
    expect(port.resolveSerialProposal).toHaveBeenCalledWith(
      proposal,
      'approve',
      expect.any(AbortSignal),
    );
  });

  test('accepts native development source ids derived from dotted plugin ids', async () => {
    const { port } = createPort(
      data({
        sources: [
          {
            sourceId: 'dev-dev.bbcom.hello-panel',
            kind: 'dev-directory',
            displayName: 'Hello Panel Example',
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
    expect(service.snapshot().sources[0]?.sourceId).toBe('dev-dev.bbcom.hello-panel');
    expect(service.snapshot().failure).toBeNull();
  });

  test('filters unsafe declarative panels before the renderer sees them', async () => {
    const { port } = createPort(
      data({
        panels: [
          {
            runtime: {
              workspaceId: 'workspace-1',
              pluginId: 'unsafe.plugin',
              instanceId: 1,
              generation: 1,
            },
            title: '<img src=x>',
            fields: [
              {
                id: 'run',
                label: 'Run',
                kind: 'button',
                value: '',
                options: [],
                disabled: false,
              },
            ],
          },
        ],
      }),
    );
    const service = new PluginCenterService(port);
    await service.start();
    expect(service.snapshot().panels).toEqual([]);
    expect(service.snapshot().failure?.code).toBe('invalid-panel');
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
});
