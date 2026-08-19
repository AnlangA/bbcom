// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import type { PluginSurfaceSnapshot } from '../../src/generated/ipc-contracts';
import PluginSurfaceRenderer from '../../src/components/plugins/PluginSurfaceRenderer.vue';

function surface(overrides: Partial<PluginSurfaceSnapshot> = {}): PluginSurfaceSnapshot {
  return {
    runtime: {
      workspaceId: 'workspace-1',
      pluginId: 'dev.bbcom.mcumgr',
      instanceId: 1,
      generation: 2,
    },
    surfaceId: 'main',
    revision: 1,
    title: 'MCUmgr',
    placement: 'workspace',
    detachedAllowed: true,
    editable: true,
    root: {
      kind: 'column',
      id: 'root',
      children: [
        {
          kind: 'tabs',
          id: 'tabs',
          selectedId: 'overview',
          tabs: [
            {
              id: 'overview',
              label: 'Overview',
              children: [{ kind: 'text', id: 'status', text: 'Connected', tone: 'success' }],
            },
            {
              id: 'settings',
              label: 'Settings',
              children: [
                {
                  kind: 'select',
                  id: 'transport',
                  label: 'Transport',
                  value: 'console',
                  options: [
                    { value: 'console', label: 'Console' },
                    { value: 'raw', label: 'Raw UART' },
                  ],
                  disabled: false,
                },
                {
                  kind: 'button',
                  id: 'erase',
                  label: 'Erase storage',
                  disabled: false,
                  dangerous: true,
                  confirmation: 'Erase storage?',
                },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('PluginSurfaceRenderer', () => {
  test('renders the host vocabulary and emits revision-bound validated events', async () => {
    const wrapper = mount(PluginSurfaceRenderer, { props: { surface: surface() } });
    expect(wrapper.get('h3').text()).toBe('MCUmgr');
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('Overview');

    await wrapper.findAll('[role="tab"]')[1]?.trigger('click');
    expect(wrapper.emitted('event')?.[0]?.[0]).toMatchObject({
      surfaceId: 'main',
      revision: 1,
      nodeId: 'tabs',
      event: 'select-tab',
      value: 'settings',
    });

    await wrapper.get('select').setValue('raw');
    expect(wrapper.emitted('event')?.[1]?.[0]).toMatchObject({
      nodeId: 'transport',
      event: 'change',
      value: 'raw',
    });
  });

  test('requires host confirmation before a dangerous activation is emitted', async () => {
    const reject = vi.fn(() => false);
    const wrapper = mount(PluginSurfaceRenderer, {
      props: { surface: surface(), confirmDangerous: reject },
    });
    await wrapper.get('.plugin-node--danger').trigger('click');
    await flushPromises();
    expect(reject).toHaveBeenCalledWith('Erase storage?');
    expect(wrapper.emitted('event')).toBeUndefined();

    await wrapper.setProps({ confirmDangerous: () => true });
    await wrapper.get('.plugin-node--danger').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('event')?.[0]?.[0]).toMatchObject({
      nodeId: 'erase',
      event: 'activate',
    });
  });

  test('supports the WAI-ARIA tab keyboard pattern', async () => {
    const wrapper = mount(PluginSurfaceRenderer, {
      attachTo: document.body,
      props: { surface: surface() },
    });
    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[0]?.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(wrapper.emitted('event')?.[0]?.[0]).toMatchObject({
      nodeId: 'tabs',
      event: 'select-tab',
      value: 'settings',
    });
    expect(document.activeElement).toBe(tabs[1]?.element);
    wrapper.unmount();
  });

  test('keeps the main workspace read-only while the surface is detached', async () => {
    const wrapper = mount(PluginSurfaceRenderer, {
      props: { surface: surface({ placement: 'detached-window' }) },
    });
    expect(wrapper.get('[role="status"]').text().length).toBeGreaterThan(0);
    expect(wrapper.find('select').exists()).toBe(false);
    await wrapper.get('.plugin-surface__header button').trigger('click');
    expect(wrapper.emitted('attach')).toHaveLength(1);
  });

  test('refuses to render a malformed surface', () => {
    const invalid = surface({
      root: { kind: 'text', id: 'status', text: '/Users/alice/secret.bin', tone: 'danger' },
    });
    const wrapper = mount(PluginSurfaceRenderer, { props: { surface: invalid } });
    expect(wrapper.get('[role="alert"]').text()).toContain('unsafe-text');
    expect(wrapper.find('h3').exists()).toBe(false);
  });
});
