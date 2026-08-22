import { test } from 'vitest';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { isEditable, useSessionShortcuts } from '@/features/sessions/application/use-session-shortcuts.ts';

/** Minimal KeyboardEvent stub sufficient for the dispatch logic. */
function key(
  keyName: string,
  opts: {
    ctrl?: boolean;
    meta?: boolean;
    target?: { tagName?: string; isContentEditable?: boolean } | null;
  } = {},
): KeyboardEvent {
  return {
    key: keyName,
    ctrlKey: opts.ctrl === true,
    metaKey: opts.meta === true,
    target: (opts.target ?? null) as EventTarget | null,
    preventDefault() {},
  } as unknown as KeyboardEvent;
}

function fakeEl(tagName: string, isContentEditable = false): HTMLElement {
  return { tagName, isContentEditable } as unknown as HTMLElement;
}

function setup(handlers: {
  onClear: () => void;
  onTogglePause: () => void;
  isConnected: () => boolean;
  isActive?: () => boolean;
}): { handleKeydown: (e: KeyboardEvent) => void } {
  // useSessionShortcuts registers onMounted/onUnmounted lifecycle hooks; calling
  // it inside an effectScope silences the "lifecycle without active instance"
  // warning. The returned handleKeydown is the pure dispatch logic under test.
  const scope = effectScope();
  let api!: { handleKeydown: (e: KeyboardEvent) => void };
  scope.run(() => {
    api = useSessionShortcuts(handlers);
  });
  return api;
}

test('isEditable: recognizes input, textarea, select and contenteditable', () => {
  assert.equal(isEditable(null), false, 'null target is not editable');
  assert.equal(isEditable(fakeEl('DIV', true)), true, 'contenteditable div counts');
  assert.equal(isEditable(fakeEl('INPUT')), true, 'INPUT counts');
  assert.equal(isEditable(fakeEl('TEXTAREA')), true, 'TEXTAREA counts');
  assert.equal(isEditable(fakeEl('SELECT')), true, 'SELECT counts');
  assert.equal(isEditable(fakeEl('DIV')), false, 'plain div is not editable');
});

test('Ctrl/Cmd+L clears the capture buffer when not focused in an input', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
  });

  handleKeydown(key('l', { ctrl: true }));
  handleKeydown(key('L', { meta: true }));
  assert.deepEqual(calls, ['clear', 'clear'], 'both ctrl+l and cmd+L clear');
});

test('Ctrl+L is suppressed while typing in an input', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
  });

  handleKeydown(key('l', { ctrl: true, target: fakeEl('INPUT') }));
  assert.deepEqual(calls, [], 'clear suppressed inside an input');
});

test('Escape toggles pause only when connected and not in an editable element', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
  });

  handleKeydown(key('Escape'));
  assert.deepEqual(calls, ['pause'], 'Esc toggles pause when connected');

  // Now disconnected — Esc must be a no-op (no confusing state change).
  const { handleKeydown: hk2 } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => false,
  });
  hk2(key('Escape'));
  assert.deepEqual(calls, ['pause'], 'Esc ignored when disconnected');
});

test('Escape is suppressed inside an editable element', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
  });

  handleKeydown(key('Escape', { target: fakeEl('TEXTAREA') }));
  assert.deepEqual(calls, [], 'Esc inside a textarea does not toggle pause');
});

test('Ctrl+L without ctrl/meta does nothing', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
  });

  handleKeydown(key('l'));
  handleKeydown(key('x', { ctrl: true }));
  assert.deepEqual(calls, [], 'plain l and ctrl+x are ignored');
});

test('resident inactive sessions never consume global shortcuts', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onClear: () => calls.push('clear'),
    onTogglePause: () => calls.push('pause'),
    isConnected: () => true,
    isActive: () => false,
  });

  handleKeydown(key('l', { ctrl: true }));
  handleKeydown(key('Escape'));
  assert.deepEqual(calls, []);
});
