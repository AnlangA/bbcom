// @vitest-environment happy-dom
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vitest';
import { useSidebarResize } from '../application/use-sidebar-resize';

afterEach(() => {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

test.each(['unmount', 'blur', 'collapse'])(
  '%s releases a sidebar drag and restores pre-existing body styles',
  async (reason) => {
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    const collapsed = ref(false);
    const onResize = vi.fn();
    const wrapper = mount(
      defineComponent({
        setup() {
          const resize = useSidebarResize({
            width: () => 292,
            collapsed: () => collapsed.value,
            onResize,
          });
          return () => h('button', { onMousedown: resize.startResize });
        },
      }),
    );
    await wrapper.get('button').trigger('mousedown', { clientX: 100, button: 0 });
    expect(document.body.style.cursor).toBe('col-resize');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120 }));
    expect(onResize).toHaveBeenLastCalledWith(312);
    if (reason === 'unmount') wrapper.unmount();
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else {
      collapsed.value = true;
      await wrapper.vm.$nextTick();
    }
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 130 }));
    expect(onResize).toHaveBeenCalledTimes(1);
    if (reason !== 'unmount') wrapper.unmount();
  },
);
