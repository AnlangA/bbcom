// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { bindParserVirtualWheel } from '@/lib/parser-virtual-list.ts';

function scrollBox(): HTMLDivElement {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => 80 },
    scrollHeight: { configurable: true, get: () => 800 },
    clientWidth: { configurable: true, get: () => 80 },
    scrollWidth: { configurable: true, get: () => 400 },
  });
  element.scrollTop = 0;
  element.scrollLeft = 0;
  return element;
}

test('bindParserVirtualWheel scrolls vertically and maps Shift+wheel to the horizontal axis', () => {
  const element = scrollBox();
  const unbind = bindParserVirtualWheel(element, 22);

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, deltaX: 12, cancelable: true }));
  assert.equal(element.scrollTop, 60);
  assert.equal(element.scrollLeft, 0);

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 24, cancelable: true }));
  assert.equal(element.scrollLeft, 24);

  const shiftWheel = new WheelEvent('wheel', { deltaY: 40, deltaX: 0, cancelable: true });
  Object.defineProperty(shiftWheel, 'shiftKey', { configurable: true, value: true });
  element.dispatchEvent(shiftWheel);
  assert.equal(element.scrollTop, 60);
  assert.equal(element.scrollLeft, 64);

  unbind();
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, cancelable: true }));
  assert.equal(element.scrollTop, 60);
});
