// @vitest-environment happy-dom

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mount } from '@vue/test-utils';
import PacketRow from '../../src/components/terminal/PacketRow.vue';
import type { DataFrame } from '../../src/types/index.ts';

function frame(omittedBytes?: number): DataFrame {
  return {
    id: 'merged-1',
    direction: 'RX',
    timestamp: 0,
    data: new Uint8Array([0x41]),
    contentVersion: 2,
    omittedBytes,
  };
}

test('merged rows visibly identify the omitted byte count', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(64 * 1024),
      formatted: 'A',
      timestamp: '00:00:00.000',
      showTimestamp: true,
      columns: '50px 160px 1fr 50px',
      displayLabel: 'UTF8*',
      useHtml: false,
    },
  });

  assert.match(wrapper.text(), /64\.0 KB omitted/);
  assert.match(wrapper.get('.col-data').attributes('title') ?? '', /65,536 bytes omitted/);
});

test('ordinary rows do not render an omission marker', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: 'A',
      timestamp: '00:00:00.000',
      showTimestamp: false,
      columns: '50px 1fr 50px',
      displayLabel: 'UTF8',
      useHtml: false,
    },
  });

  assert.equal(wrapper.find('.data-omitted').exists(), false);
});
