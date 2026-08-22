// @vitest-environment happy-dom

import { expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import { NButton, NConfigProvider } from 'naive-ui';
import { h } from 'vue';
import { themeOverrides } from '../../src/design-system/naive-theme';

// Naive-ui derives secondary/tertiary/dashed button colors in JavaScript via
// seemly's changeColor(), which throws on var() expressions. These variants
// with a colored type must render under the app's overrides without crashing
// the component tree (regression: the sidebar AI toggle crashed AppShell).
test.each(['secondary', 'tertiary', 'dashed', 'quaternary'])(
  '%s buttons with colored type render under theme overrides',
  (variant) => {
    const wrapper = mount(NConfigProvider, {
      props: { themeOverrides },
      slots: {
        default: () => h(NButton, { type: 'primary', [variant]: true }, { default: () => 'AI' }),
      },
    });
    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.text()).toContain('AI');
  },
);

test('error-typed secondary buttons render under theme overrides', () => {
  const wrapper = mount(NConfigProvider, {
    props: { themeOverrides },
    slots: {
      default: () => h(NButton, { type: 'error', secondary: true }, { default: () => '删除' }),
    },
  });
  expect(wrapper.find('button').exists()).toBe(true);
});
