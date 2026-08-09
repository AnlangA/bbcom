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

test('selected and striped rows expose their state classes', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: 'A',
      timestamp: '00:00:00.000',
      showTimestamp: false,
      columns: '50px 1fr 50px',
      displayLabel: 'UTF8',
      useHtml: false,
      selected: true,
      striped: true,
    },
  });

  assert.equal(wrapper.classes().includes('selected'), true);
  assert.equal(wrapper.classes().includes('striped'), true);
});

test('direction badges carry an arrow glyph matching the direction', () => {
  const props = {
    formatted: 'A',
    timestamp: '00:00:00.000',
    showTimestamp: false,
    columns: '50px 1fr 50px',
    displayLabel: 'UTF8',
    useHtml: false,
  };
  const tx = mount(PacketRow, { props: { ...props, frame: { ...frame(), direction: 'TX' } } });
  const rx = mount(PacketRow, { props: { ...props, frame: { ...frame(), direction: 'RX' } } });

  assert.equal(tx.get('.direction-badge .dir-arrow').text(), '↑');
  assert.match(tx.get('.direction-badge').text(), /TX/);
  assert.equal(rx.get('.direction-badge .dir-arrow').text(), '↓');
  assert.match(rx.get('.direction-badge').text(), /RX/);
});

test('log line-break mode preserves explicit newlines', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: 'first\r\nsecond',
      timestamp: '00:00:00.000',
      showTimestamp: true,
      columns: '50px 160px 1fr 50px',
      displayLabel: 'UTF8',
      useHtml: false,
      preserveLineBreaks: true,
    },
  });

  assert.equal(wrapper.get('.col-data').classes().includes('preserve-line-breaks'), true);
  assert.equal(wrapper.findAll('.col-data br').length, 1);
  assert.equal(wrapper.get('.col-data').text(), 'firstsecond');
});

test('HTML/ANSI log rendering turns CR, LF, and CRLF into explicit breaks', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: 'one\r\ntwo\n<span style="color:red">three</span>\rfour',
      timestamp: '00:00:00.000',
      showTimestamp: false,
      columns: '50px 1fr 50px',
      displayLabel: 'ANSI',
      useHtml: true,
      preserveLineBreaks: true,
    },
  });

  assert.equal(wrapper.findAll('.col-data br').length, 3);
  assert.equal(wrapper.get('.col-data').text(), 'onetwothreefour');
});

test('concatenated Zephyr records render on separate lines without CR/LF bytes', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: 'I: bootingI: ready[00:00:00.101,000] <inf> app: running',
      timestamp: '00:00:00.000',
      showTimestamp: false,
      columns: '50px 1fr 50px',
      displayLabel: 'UTF8',
      useHtml: false,
      preserveLineBreaks: true,
    },
  });

  assert.equal(wrapper.findAll('.col-data br').length, 2);
});

test('ANSI-rendered Zephyr timestamps split after angle brackets are escaped', () => {
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted:
        'I: Jumping[00:00:00.101,000] &lt;inf&gt; flash: ready' +
        '[00:00:00.102,000] &lt;wrn&gt; app: warning',
      timestamp: '00:00:00.000',
      showTimestamp: false,
      columns: '50px 1fr 50px',
      displayLabel: 'ANSI',
      useHtml: true,
      preserveLineBreaks: true,
    },
  });

  assert.equal(wrapper.findAll('.col-data br').length, 2);
  assert.match(wrapper.get('.col-data').text(), /<inf> flash: ready/);
});

test('hex dump rows split on raw newlines only, never on log-record prefixes', () => {
  // The dump's ASCII gutter contains "I: ", which the log-prefix heuristic
  // would otherwise re-flow onto its own line and corrupt the dump layout.
  const dump = '49 3A 20 61  |I: a|\n62  |b|';
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: dump,
      timestamp: '00:00:00.000',
      showTimestamp: true,
      columns: '50px 160px 1fr 50px',
      displayLabel: 'HEXASCII',
      useHtml: false,
      preserveLineBreaks: true,
      plainLineBreaks: true,
    },
  });

  assert.equal(wrapper.get('.col-data').classes().includes('preserve-line-breaks'), true);
  assert.equal(wrapper.findAll('.col-data br').length, 0);
  assert.equal(wrapper.get('.col-data').element.textContent, dump);
});

test('without plainLineBreaks the prefix heuristic would re-flow the same payload', () => {
  const dump = '49 3A 20 61  |I: a|\n62  |b|';
  const wrapper = mount(PacketRow, {
    props: {
      frame: frame(),
      formatted: dump,
      timestamp: '00:00:00.000',
      showTimestamp: true,
      columns: '50px 160px 1fr 50px',
      displayLabel: 'UTF8',
      useHtml: false,
      preserveLineBreaks: true,
    },
  });

  assert.equal(wrapper.findAll('.col-data br').length, 2);
});
