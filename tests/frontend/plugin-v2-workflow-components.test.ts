// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import type {
  PluginCommandContributionV2,
  PluginTaskViewV2,
} from '../../src/generated/ipc-contracts';
import PluginCommandList from '../../src/components/plugins/PluginCommandList.vue';
import PluginTaskCenter from '../../src/components/plugins/PluginTaskCenter.vue';

const runtime = {
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.mcumgr',
  instanceId: 1,
  generation: 2,
};

describe('plugin v2 workflow components', () => {
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
