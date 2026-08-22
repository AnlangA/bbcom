// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { expect, test } from 'vitest';
import AppSelect from '@/design-system/AppSelect.vue';

test('AppSelect returns the original typed option value instead of a DOM string', async () => {
  const wrapper = mount(AppSelect, {
    props: {
      value: 115200,
      options: [
        { label: '9600', value: 9600 },
        { label: '115200', value: 115200 },
      ],
    },
  });

  expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('1');
  await wrapper.get('select').setValue('0');

  expect(wrapper.emitted('update:value')).toEqual([[9600]]);
});

test('AppSelect emits null only for a clearable empty selection', async () => {
  const wrapper = mount(AppSelect, {
    props: {
      value: 'COM1',
      clearable: true,
      placeholder: 'Choose a port',
      options: [{ label: 'COM1', value: 'COM1' }],
    },
  });

  await wrapper.get('select').setValue('');

  expect(wrapper.emitted('update:value')).toEqual([[null]]);
});
