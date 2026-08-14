import { mount } from '@vue/test-utils';
import { describe, expect, test } from 'vitest';
import PluginAuthorizationDialog from '../../src/components/plugins/PluginAuthorizationDialog.vue';
import PluginSerialProposalDialog from '../../src/components/plugins/PluginSerialProposalDialog.vue';
import type { PluginAuthorizationReview, PluginSerialProposal } from '../../src/features/plugins';

function authorizationReview(reviewId: string): PluginAuthorizationReview {
  return {
    reviewId,
    pluginId: `plugin.${reviewId}`,
    displayName: `Plugin ${reviewId}`,
    version: '1.0.0',
    persistentPermissions: ['session.capture.read'],
    perRequestPermissions: ['serial.write-proposal', 'file.open-save'],
    unavailableCapabilities: [],
    extraConfirmationReasons: [],
  };
}

const proposal: PluginSerialProposal = {
  proposalId: 'proposal-1',
  pluginId: 'plugin.proposal',
  pluginName: 'Proposal Plugin',
  sessionLabel: 'Session A',
  displayLabel: 'Send request',
  byteCount: 2,
  hexPreview: '01 02',
  expiresAtMs: 1_000,
};

describe('plugin dialog safety boundaries', () => {
  test('requires every per-request capability acknowledgement before authorization can be saved', async () => {
    const wrapper = mount(PluginAuthorizationDialog, {
      props: { review: authorizationReview('review-1'), busy: false },
    });
    const save = wrapper.get('.plugin-review__actions .primary');
    const perRequestInputs = wrapper.findAll('.plugin-review__group')[1]?.findAll('input') ?? [];

    expect(perRequestInputs).toHaveLength(2);
    expect(save.attributes('disabled')).toBeDefined();
    await perRequestInputs[0]?.setValue(true);
    expect(save.attributes('disabled')).toBeDefined();
    await perRequestInputs[1]?.setValue(true);
    expect(save.attributes('disabled')).toBeUndefined();

    wrapper.unmount();
  });

  test('clears authorization selections when the review identity changes', async () => {
    const wrapper = mount(PluginAuthorizationDialog, {
      props: { review: authorizationReview('review-1'), busy: false },
    });
    for (const input of wrapper.findAll('input')) await input.setValue(true);

    await wrapper.setProps({ review: authorizationReview('review-2') });

    expect(
      wrapper.findAll('input').every((input) => !(input.element as HTMLInputElement).checked),
    ).toBe(true);
    expect(wrapper.get('.plugin-review__actions .primary').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  test('does not dismiss authorization or reject a proposal while an action is busy', async () => {
    const authorization = mount(PluginAuthorizationDialog, {
      props: { review: authorizationReview('review-1'), busy: true },
    });
    expect(authorization.get('.plugin-dialog__close').attributes('disabled')).toBeDefined();
    await authorization.get('.plugin-dialog').trigger('keydown', { key: 'Escape' });
    expect(authorization.emitted('dismiss')).toBeUndefined();

    const serial = mount(PluginSerialProposalDialog, {
      props: { proposal, busy: true },
    });
    expect(serial.get('.plugin-dialog__close').attributes('disabled')).toBeDefined();
    await serial.get('.plugin-dialog').trigger('keydown', { key: 'Escape' });
    expect(serial.emitted('resolve')).toBeUndefined();

    authorization.unmount();
    serial.unmount();
  });
});
