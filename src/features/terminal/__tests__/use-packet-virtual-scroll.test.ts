import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isPinnedToBottom } from '@/features/terminal/application/use-packet-virtual-scroll.ts';

// ROW_HEIGHT is 28; isPinnedToBottom uses a 2× row-height (56px) slack so a user
// parked slightly above the bottom still keeps auto-follow.

test('isPinnedToBottom: true when scrolled to the exact bottom', () => {
  // clientHeight 800, content 800 → scrollTop 0, distance 0 → pinned.
  assert.equal(isPinnedToBottom(0, 800, 800), true);
});

test('isPinnedToBottom: true within the 2x-row-height slack', () => {
  // content 1000, viewport 800, scrolled to 950 → distance 1000-950-800 < 0? No:
  // distance = scrollHeight - scrollTop - clientHeight = 1000 - 950 - 800 = -750.
  // scrollTop cannot exceed scrollHeight-clientHeight (750) in a real element;
  // at max scrollTop (200) distance = 0 → pinned.
  assert.equal(isPinnedToBottom(200, 1000, 800), true, 'at max scroll distance 0');
  // 55px slack just inside the threshold → still pinned.
  assert.equal(isPinnedToBottom(145, 1000, 800), true, '55px above bottom still pinned');
});

test('isPinnedToBottom: false once the user scrolls beyond the slack', () => {
  // 57px above the bottom → beyond 56px slack → not pinned.
  assert.equal(isPinnedToBottom(143, 1000, 800), false, '57px above bottom not pinned');
  // Scrolled well up.
  assert.equal(isPinnedToBottom(0, 2000, 800), false, 'top of a long list not pinned');
});

test('isPinnedToBottom: boundary exactly at the slack threshold', () => {
  // distance exactly 56 (ROW_HEIGHT*2): the check is strict `<`, so 56 is NOT pinned.
  // scrollHeight 856, clientHeight 800, scrollTop 0 → distance 56.
  assert.equal(isPinnedToBottom(0, 856, 800), false, 'distance == 2x row height is not pinned');
  // distance 55 → pinned.
  assert.equal(isPinnedToBottom(1, 856, 800), true, 'distance 55 is pinned');
});
