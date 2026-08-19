// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import type {
  PluginAuthorizationRequestV2,
  PluginCommandContributionV2,
  PluginTaskViewV2,
} from '../../src/generated/ipc-contracts';
import PluginAuthorizationDialog from '../../src/components/plugins/PluginAuthorizationDialog.vue';
import PluginCommandList from '../../src/components/plugins/PluginCommandList.vue';
import PluginTaskCenter from '../../src/components/plugins/PluginTaskCenter.vue';

const runtime = {
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.mcumgr',
  instanceId: 1,
  generation: 2,
};

const request: PluginAuthorizationRequestV2 = {
  pluginId: 'dev.bbcom.mcumgr',
  displayName: 'MCUmgr',
  version: '1.0.0',
  digestSha256: 'a'.repeat(64),
  developmentSource: true,
  requestedCapabilities: ['file.open-read', 'serial.io', 'ui.workspace'],
  addedCapabilities: ['serial.io'],
};

describe('plugin v2 workflow components', () => {
  test('shows the complete capability list and emits an exact authorization decision', async () => {
    const wrapper = mount(PluginAuthorizationDialog, { props: { request } });
    expect(wrapper.attributes('role')).toBe('dialog');
    expect(wrapper.findAll('li')).toHaveLength(3);
    expect(wrapper.text()).toContain(request.digestSha256);
    expect(wrapper.get('[role="alert"]').text().length).toBeGreaterThan(0);

    await wrapper.findAll('footer button')[1]!.trigger('click');
    expect(wrapper.emitted('resolve')?.[0]).toEqual([request, 'approve']);
  });

  test('renders progress and emits the generation-bound task on cancel', async () => {
    const task: PluginTaskViewV2 = {
      runtime,
      taskId: 'upload-1',
      commandId: 'image-upload',
      title: 'Upload firmware',
      status: 'running',
      completed: 32,
      total: 128,
      statusText: 'Uploading',
      cancellable: true,
    };
    const wrapper = mount(PluginTaskCenter, { props: { tasks: [task] } });
    expect(wrapper.get('progress').attributes('value')).toBe('32');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('cancel')?.[0]?.[0]).toEqual(task);
  });

  test('marks dangerous command contributions and emits the exact command', async () => {
    const command: PluginCommandContributionV2 = {
      runtime,
      commandId: 'erase-storage',
      title: 'Erase storage',
      description: 'Erases Zephyr storage.',
      dangerous: true,
      confirmation: 'Erase Zephyr storage?',
    };
    const wrapper = mount(PluginCommandList, { props: { commands: [command] } });
    const button = wrapper.get('button');
    expect(button.classes()).toContain('plugin-commands__danger');
    await button.trigger('click');
    expect(wrapper.emitted('run')?.[0]?.[0]).toEqual(command);
  });
});
