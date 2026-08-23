import { test } from 'vitest';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { isEditable, useAppShortcuts } from '@/features/app-shell/application/use-app-shortcuts.ts';

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

function setup(handlers: { onCreateSession: () => void; onCloseSession: () => void }): {
  handleKeydown: (e: KeyboardEvent) => void;
} {
  const scope = effectScope();
  let api!: { handleKeydown: (e: KeyboardEvent) => void };
  scope.run(() => {
    api = useAppShortcuts(handlers);
  });
  return api;
}

test('isEditable: recognizes editable elements via duck-typing', () => {
  assert.equal(isEditable(null), false);
  assert.equal(isEditable(fakeEl('INPUT')), true);
  assert.equal(isEditable(fakeEl('DIV', true)), true);
  assert.equal(isEditable(fakeEl('DIV')), false);
});

test('Cmd/Ctrl+N creates a session; Cmd/Ctrl+W closes it', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onCreateSession: () => calls.push('create'),
    onCloseSession: () => calls.push('close'),
  });

  handleKeydown(key('n', { ctrl: true }));
  handleKeydown(key('w', { meta: true }));
  assert.deepEqual(calls, ['create', 'close']);
});

test('shortcuts are ignored without a ctrl/cmd modifier', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onCreateSession: () => calls.push('create'),
    onCloseSession: () => calls.push('close'),
  });

  handleKeydown(key('n'));
  handleKeydown(key('w'));
  assert.deepEqual(calls, [], 'plain keys do nothing');
});

test('shortcuts are suppressed while typing in an input', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onCreateSession: () => calls.push('create'),
    onCloseSession: () => calls.push('close'),
  });

  handleKeydown(key('n', { ctrl: true, target: fakeEl('INPUT') }));
  handleKeydown(key('w', { ctrl: true, target: fakeEl('TEXTAREA') }));
  assert.deepEqual(calls, [], 'ctrl+n/w suppressed inside editable elements');
});

test('only n and w are bound', () => {
  const calls: string[] = [];
  const { handleKeydown } = setup({
    onCreateSession: () => calls.push('create'),
    onCloseSession: () => calls.push('close'),
  });

  handleKeydown(key('a', { ctrl: true }));
  handleKeydown(key('t', { ctrl: true }));
  assert.deepEqual(calls, [], 'other ctrl+key combos are ignored');
});
