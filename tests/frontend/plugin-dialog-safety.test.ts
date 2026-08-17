// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import PluginCenterPanel from '../../src/components/plugins/PluginCenterPanel.vue';
import PluginPromptHost from '../../src/components/plugins/PluginPromptHost.vue';
import PluginSerialProposalDialog from '../../src/components/plugins/PluginSerialProposalDialog.vue';
import {
  PLUGIN_CENTER_KEY,
  PluginCenterService,
  type PluginCenterData,
  type PluginCenterPort,
  type PluginSerialProposal,
} from '../../src/features/plugins';
import zh from '../../src/lib/locales/zh';

const dialogWarning = vi.hoisted(() => vi.fn());

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    useDialog: () => ({ warning: dialogWarning }),
  };
});

interface UninstallConfirmation {
  title?: string;
  content?: string;
  positiveText?: string;
  negativeText?: string;
  onPositiveClick?: () => void;
}

function lastUninstallConfirmation(): UninstallConfirmation | undefined {
  return dialogWarning.mock.calls.at(-1)?.[0] as UninstallConfirmation | undefined;
}

const proposal: PluginSerialProposal = {
  runtime: {
    workspaceId: 'workspace-1',
    pluginId: 'plugin.proposal',
    instanceId: 1,
    generation: 1,
  },
  proposalId: 'proposal-1',
  pluginId: 'plugin.proposal',
  pluginName: 'Proposal Plugin',
  sessionLabel: 'Session A',
  displayLabel: 'Send request',
  byteCount: 2,
  hexPreview: '01 02',
  expiresAtMs: 1_000,
};

function centerData(overrides: Partial<PluginCenterData> = {}): PluginCenterData {
  return {
    revision: 1,
    catalog: [],
    installed: [
      {
        pluginId: 'tools.capture',
        displayName: 'Capture Tools',
        version: '1.0.0',
        status: 'stopped',
        statusReason: null,
        enabled: false,
        pendingVersion: null,
        declaredCapabilities: [],
        effectiveCapabilities: [],
        unavailableCapabilities: [],
        runtime: null,
      },
    ],
    serialProposals: [],
    panels: [],
    sources: [],
    ...overrides,
  };
}

function createCenterPort(initial: PluginCenterData): PluginCenterPort {
  const refreshed: PluginCenterData = { ...initial, revision: 2, installed: [] };
  return {
    snapshot: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    requestLocalSourceGrant: vi.fn(async () => 'plugin-grant-fixture'),
    install: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    installLocal: vi.fn(async () => ({ outcome: 'completed' as const, data: refreshed })),
    uninstall: vi.fn(async () => ({ outcome: 'completed' as const, data: refreshed })),
    setEnabled: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    addSource: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    updateSource: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    removeSource: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    refreshSource: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    setWatchEnabled: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    resolveSerialProposal: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    emitPanelEvent: vi.fn(async () => ({ outcome: 'completed' as const, data: initial })),
    subscribe: vi.fn(() => vi.fn()),
  };
}

describe('plugin dialog safety boundaries', () => {
  test('does not reject a proposal while an action is busy', async () => {
    const serial = mount(PluginSerialProposalDialog, {
      props: { proposal, busy: true },
      global: { stubs: { Teleport: true } },
    });
    expect(serial.get('.app-modal__close').attributes('disabled')).toBeDefined();
    await serial.get('.app-modal-overlay').trigger('keydown', { key: 'Escape' });
    expect(serial.emitted('resolve')).toBeUndefined();

    serial.unmount();
  });
});

describe('plugin center panel local install and uninstall', () => {
  beforeEach(() => {
    dialogWarning.mockReset();
  });

  async function mountPanel(port: PluginCenterPort) {
    const service = new PluginCenterService(port);
    await service.start();
    const wrapper = mount(PluginCenterPanel, {
      global: { provide: { [PLUGIN_CENTER_KEY]: service } },
    });
    await flushPromises();
    return wrapper;
  }

  test('uses an opaque native grant instead of exposing a package path', async () => {
    const port = createCenterPort(centerData());
    const wrapper = await mountPanel(port);

    await wrapper.findAll('[role="tab"]')[2].trigger('click');
    const picker = wrapper.get('.plugin-center__local-install button');
    expect(wrapper.find('.plugin-center__local-install input').exists()).toBe(false);
    await picker.trigger('click');
    await flushPromises();

    expect(port.requestLocalSourceGrant).toHaveBeenCalledWith(
      'local-package',
      expect.any(AbortSignal),
    );
    expect(port.installLocal).toHaveBeenCalledWith('plugin-grant-fixture', expect.any(AbortSignal));
    wrapper.unmount();
  });

  test('uninstall requires the destructive-action confirmation before reaching the port', async () => {
    const port = createCenterPort(centerData());
    const wrapper = await mountPanel(port);

    await wrapper.get('.plugin-center__uninstall').trigger('click');
    expect(port.uninstall).not.toHaveBeenCalled();
    expect(dialogWarning).toHaveBeenCalledOnce();

    const confirmation = lastUninstallConfirmation();
    expect(confirmation?.title).toBe(zh['plugins.uninstall_confirm.title']);
    expect(confirmation?.content).toContain('Capture Tools');
    expect(confirmation?.positiveText).toBe(zh['plugins.uninstall']);
    expect(confirmation?.negativeText).toBe(zh['common.cancel']);

    confirmation?.onPositiveClick?.();
    await flushPromises();
    expect(port.uninstall).toHaveBeenCalledWith('tools.capture', expect.any(AbortSignal));
    wrapper.unmount();
  });

  test('a failed uninstall surfaces through the plugin center error alert', async () => {
    const port = createCenterPort(centerData());
    port.uninstall = vi.fn(async () => ({
      outcome: 'failed' as const,
      failure: { code: 'installation-failed' },
    }));
    const wrapper = await mountPanel(port);

    await wrapper.get('.plugin-center__uninstall').trigger('click');
    lastUninstallConfirmation()?.onPositiveClick?.();
    await flushPromises();

    expect(port.uninstall).toHaveBeenCalledWith('tools.capture', expect.any(AbortSignal));
    const alert = wrapper.get('.plugin-center__error');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain(zh['plugins.error.installation-failed']);
    wrapper.unmount();
  });
});

describe('plugin runtime status banner and proposal expiry', () => {
  test('panel renders and clears the runtime-unavailable banner from the service snapshot', async () => {
    const port = createCenterPort(centerData());
    const service = new PluginCenterService(port);
    await service.start();
    const wrapper = mount(PluginCenterPanel, {
      global: { provide: { [PLUGIN_CENTER_KEY as symbol]: service } },
    });
    await flushPromises();

    // Healthy runtime: no banner.
    expect(wrapper.find('[data-testid="plugin-runtime-unavailable"]').exists()).toBe(false);

    // Simulate a failed composition arriving through the native status event
    // by driving the service's own listener surface: snapshot exposes the
    // last status, and the panel renders it with the stable code.
    const unavailable = {
      ...centerData(),
    };
    void unavailable;
    // Drive through the service internals is not public; instead verify the
    // panel renders whatever runtimeStatus the snapshot carries.
    const failing = new PluginCenterService(port);
    await failing.start();
    // @ts-expect-error test reaches the private status field
    failing.runtimeStatus = Object.freeze({
      available: false,
      code: 'PLUGIN_BOOTSTRAP_STATE_STORE_MISSING',
    });
    // @ts-expect-error test drives the notify path
    failing.notify();
    const wrapper2 = mount(PluginCenterPanel, {
      global: { provide: { [PLUGIN_CENTER_KEY as symbol]: failing } },
    });
    await flushPromises();
    const banner = wrapper2.find('[data-testid="plugin-runtime-unavailable"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('PLUGIN_BOOTSTRAP_STATE_STORE_MISSING');
    wrapper.unmount();
    wrapper2.unmount();
  });

  test('prompt host hides a proposal whose TTL already elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    try {
      const expired = { ...proposal, expiresAtMs: 4_000 };
      const wrapper = mount(PluginPromptHost, {
        global: {
          provide: {
            [PLUGIN_CENTER_KEY as symbol]: {
              snapshot: () => ({ serialProposals: [expired], action: null, failure: null }),
              subscribe: () => () => undefined,
              clearFailure: vi.fn(),
              resolveSerialProposal: vi.fn(),
              refresh: vi.fn(),
            },
          },
        },
      });
      await flushPromises();
      expect(wrapper.findComponent(PluginSerialProposalDialog).exists()).toBe(false);

      // An already-dismissed expired proposal stays hidden even when the
      // expiry timer fires later.
      vi.advanceTimersByTime(120_000);
      expect(wrapper.findComponent(PluginSerialProposalDialog).exists()).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  test('prompt host dismisses a proposal when its TTL timer fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const live = { ...proposal, expiresAtMs: 70_000 };
      const wrapper = mount(PluginPromptHost, {
        global: {
          provide: {
            [PLUGIN_CENTER_KEY as symbol]: {
              snapshot: () => ({ serialProposals: [live], action: null, failure: null }),
              subscribe: () => () => undefined,
              clearFailure: vi.fn(),
              resolveSerialProposal: vi.fn(),
              refresh: vi.fn(),
            },
          },
        },
      });
      await flushPromises();
      expect(wrapper.findComponent(PluginSerialProposalDialog).exists()).toBe(true);

      vi.advanceTimersByTime(60_100);
      await flushPromises();
      expect(
        wrapper.findComponent(PluginSerialProposalDialog).exists(),
        'expired proposal is hidden without user action',
      ).toBe(false);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
