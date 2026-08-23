// @vitest-environment happy-dom

import { test } from 'vitest';
import { nextTick } from 'vue';
import assert from 'node:assert/strict';
import { mount } from '@vue/test-utils';
import AppModal from '@/design-system/AppModal.vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import SettingsSection from '@/design-system/SettingsSection.vue';
import ActionListItem from '@/design-system/ActionListItem.vue';
import InlineEditorActions from '@/design-system/InlineEditorActions.vue';
import AppSelect from '@/design-system/AppSelect.vue';

test('AppModal renders its named dialog only while shown', async () => {
  const wrapper = mount(AppModal, {
    props: { show: false, title: 'Confirm' },
    attachTo: document.body,
  });
  assert.equal(document.querySelector('[role="dialog"]'), null);

  await wrapper.setProps({ show: true });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const titleId = dialog.getAttribute('aria-labelledby');
  assert.ok(titleId);
  assert.equal(document.getElementById(titleId)?.textContent, 'Confirm');
  wrapper.unmount();
  assert.equal(
    document.querySelector('[role="dialog"]'),
    null,
    'teleported dialog is removed on unmount',
  );
});

test('AppModal ignores close requests while busy', async () => {
  const wrapper = mount(AppModal, {
    props: { show: true, title: 'Busy', busy: true },
    attachTo: document.body,
  });
  const closeButton = document.querySelector<HTMLButtonElement>('.app-modal__close');
  assert.ok(closeButton);
  closeButton.click();
  await nextTick();
  assert.equal(wrapper.emitted('close'), undefined);
  wrapper.unmount();
});

test('IconActionButton exposes a mandatory accessible name and pressed state', () => {
  const wrapper = mount(IconActionButton, {
    props: { label: 'Delete macro', tone: 'danger', toggleable: true, active: true },
  });
  const button = wrapper.find('button');
  assert.equal(button.attributes('aria-label'), 'Delete macro');
  assert.equal(button.attributes('aria-pressed'), 'true');
  assert.ok(button.text() !== undefined);
});

test('SettingsSection links its body to a stable heading id', () => {
  const wrapper = mount(SettingsSection, {
    props: { title: 'Appearance', description: 'Theme and locale' },
  });
  const section = wrapper.find('section');
  const heading = wrapper.find('h3');
  assert.ok(section.attributes('aria-labelledby'));
  assert.equal(heading.attributes('id'), section.attributes('aria-labelledby'));
  assert.equal(heading.text(), 'Appearance');
});

test('ActionListItem shows meta at the metadata size and keeps actions aligned', () => {
  const wrapper = mount(ActionListItem, {
    props: { title: 'Trigger A', description: 'RX contains OK', meta: 'v1.0.0' },
    slots: { actions: '<button>edit</button>' },
  });
  assert.equal(wrapper.find('.action-list-item__meta').text(), 'v1.0.0');
  assert.ok(wrapper.find('.action-list-item__actions button').exists());
});

test('InlineEditorActions disables save when invalid or busy and keeps cancel enabled', async () => {
  const wrapper = mount(InlineEditorActions, { props: { canSave: false } });
  assert.equal(
    (wrapper.find('.inline-editor-actions__save').element as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (wrapper.find('.inline-editor-actions__cancel').element as HTMLButtonElement).disabled,
    false,
  );

  await wrapper.setProps({ canSave: true, busy: true });
  assert.equal(
    (wrapper.find('.inline-editor-actions__save').element as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (wrapper.find('.inline-editor-actions__cancel').element as HTMLButtonElement).disabled,
    true,
  );

  await wrapper.setProps({ busy: false });
  await wrapper.find('.inline-editor-actions__save').trigger('click');
  assert.equal(wrapper.emitted('save')?.length, 1);
});

test('AppSelect takes explicit naming only and never infers from the current value', () => {
  const wrapper = mount(AppSelect, {
    props: {
      value: 'hex',
      ariaLabel: 'Display format',
      options: [
        { label: 'HEX', value: 'hex' },
        { label: 'ASCII', value: 'ascii' },
      ],
    },
  });
  const select = wrapper.find('select');
  assert.equal(select.attributes('aria-label'), 'Display format');

  const labelled = mount(AppSelect, {
    props: {
      value: 'hex',
      ariaLabelledby: 'format-label',
      options: [{ label: 'HEX', value: 'hex' }],
    },
  });
  assert.equal(labelled.find('select').attributes('aria-labelledby'), 'format-label');
  assert.equal(labelled.find('select').attributes('aria-label'), undefined);

  const unnamed = mount(AppSelect, {
    props: { value: 'hex', options: [{ label: 'HEX', value: 'hex' }] },
  });
  const attributes = unnamed.find('select').attributes();
  assert.equal(attributes['aria-label'], undefined, 'no fallback naming from the selected option');
});
