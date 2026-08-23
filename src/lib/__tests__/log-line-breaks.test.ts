import { test } from 'vitest';
import assert from 'node:assert/strict';
import { splitLogDisplayLines } from '@/lib/log-line-breaks.ts';

test('splits explicit CR, LF, and CRLF while ignoring one terminal cursor line', () => {
  assert.deepEqual(splitLogDisplayLines('one\r\ntwo\nthree\rfour'), [
    'one',
    'two',
    'three',
    'four',
  ]);
  assert.deepEqual(splitLogDisplayLines('one\r\n'), ['one', '']);
  assert.deepEqual(splitLogDisplayLines('one\n\n'), ['one', '', '']);
});

test('splits concatenated MCUboot and Zephyr records without changing their text', () => {
  const input =
    '*** Using Zephyr OS build v4.4.1 ***I: Starting bootloader' +
    'I: Primary slot: version=0.6.0+0I: Secondary slot: version=0.7.0+0' +
    '[00:00:00.101,000] <inf> flash: ready' +
    '[00:00:00.102,000] <wrn> app: warning' +
    '*** Booting Zephyr OS build v4.4.1 ***';

  assert.deepEqual(splitLogDisplayLines(input), [
    '*** Using Zephyr OS build v4.4.1 ***',
    'I: Starting bootloader',
    'I: Primary slot: version=0.6.0+0',
    'I: Secondary slot: version=0.7.0+0',
    '[00:00:00.101,000] <inf> flash: ready',
    '[00:00:00.102,000] <wrn> app: warning',
    '*** Booting Zephyr OS build v4.4.1 ***',
  ]);
});

test('does not mistake ordinary protocol tokens such as SPI for severity prefixes', () => {
  assert.deepEqual(splitLogDisplayLines('mode=SPI: QUAD'), ['mode=SPI: QUAD']);
});

test('recognizes Zephyr prefixes after ANSI HTML escaping', () => {
  assert.deepEqual(
    splitLogDisplayLines(
      'I: Jumping to slot[00:00:00.101,000] &lt;inf&gt; flash: ready' +
        '[00:00:00.102,000] &lt;err&gt; app: failed',
    ),
    [
      'I: Jumping to slot',
      '[00:00:00.101,000] &lt;inf&gt; flash: ready',
      '[00:00:00.102,000] &lt;err&gt; app: failed',
    ],
  );
});
