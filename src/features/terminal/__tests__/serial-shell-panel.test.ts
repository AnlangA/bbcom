/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';
import type { SerialShellConfig } from '@/types';
import { logger } from '@/lib/logger';

const xtermMocks = vi.hoisted(() => {
  const state: {
    constructorOptions: Record<string, unknown> | null;
    customKeyHandler: ((event: KeyboardEvent) => boolean) | null;
  } = {
    constructorOptions: null,
    customKeyHandler: null,
  };

  class TerminalMock {
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      state.constructorOptions = options;
      this.options = options;
    }

    loadAddon(): void {}
    open(): void {}
    write(_data: string, callback?: () => void): void {
      callback?.();
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      state.customKeyHandler = handler;
    }
    onData(): { dispose(): void } {
      return { dispose: () => undefined };
    }
    getSelection(): string {
      return '';
    }
    paste(): void {}
    focus(): void {}
    scrollToBottom(): void {}
    reset(): void {}
    dispose(): void {}
  }

  return { state, TerminalMock };
});

vi.mock('@xterm/xterm', () => ({ Terminal: xtermMocks.TerminalMock }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    findNext(): boolean {
      return false;
    }
    findPrevious(): boolean {
      return false;
    }
  },
}));
vi.mock('@/features/sessions', () => ({
  useSessionDocument: () => ({ setShellConfig: vi.fn() }),
}));
vi.mock('@/features/settings/store/app-store', () => ({
  useAppStore: () => ({ theme: 'dark' }),
}));

import SerialShellPanel from '@/features/terminal/ui/SerialShellPanel.vue';

const config: SerialShellConfig = {
  localEcho: false,
  txNewline: 'cr',
  rxNewline: 'auto',
  encoding: 'utf-8',
  backspace: 'bs',
};

const loadFont = vi.fn();
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

function mountShell() {
  const shell = {
    replay: vi.fn(() => ''),
    onOutput: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    handleTerminalData: vi.fn(),
    clear: vi.fn(),
  };
  const wrapper = shallowMount(SerialShellPanel, {
    props: { sessionId: 'session-shell', config, isConnected: true, shell },
  });
  return { wrapper, shell };
}

beforeEach(() => {
  xtermMocks.state.constructorOptions = null;
  xtermMocks.state.customKeyHandler = null;
  loadFont.mockReset().mockResolvedValue([]);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: loadFont },
  });
  document.documentElement.style.setProperty('--font-mono', '"JetBrains Mono", monospace');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
  document.documentElement.style.removeProperty('--font-mono');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('Shell terminal sends physical Enter directly without changing RX rendering semantics', async () => {
  const { wrapper, shell } = mountShell();
  const { handleTerminalData } = shell;
  await flushPromises();

  expect(xtermMocks.state.constructorOptions).not.toHaveProperty('convertEol');
  expect(xtermMocks.state.customKeyHandler).not.toBeNull();
  const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  const accepted = xtermMocks.state.customKeyHandler?.(enterEvent);
  expect(accepted).toBe(false);
  expect(enterEvent.defaultPrevented).toBe(true);
  expect(handleTerminalData).toHaveBeenCalledExactlyOnceWith('\r');

  const keyupEvent = new KeyboardEvent('keyup', { key: 'Enter', cancelable: true });
  expect(xtermMocks.state.customKeyHandler?.(keyupEvent)).toBe(true);
  expect(keyupEvent.defaultPrevented).toBe(false);
  expect(handleTerminalData).toHaveBeenCalledTimes(1);

  wrapper.unmount();
});

test('Shell waits for regular and bold fonts before measuring cells and replaying output', async () => {
  const regular = Promise.withResolvers<FontFace[]>();
  const bold = Promise.withResolvers<FontFace[]>();
  loadFont.mockReturnValueOnce(regular.promise).mockReturnValueOnce(bold.promise);
  const { wrapper, shell } = mountShell();

  expect(xtermMocks.state.constructorOptions).toBeNull();
  expect(shell.replay).not.toHaveBeenCalled();
  regular.resolve([]);
  await flushPromises();
  expect(xtermMocks.state.constructorOptions).toBeNull();

  bold.resolve([]);
  await flushPromises();
  expect(xtermMocks.state.constructorOptions?.fontFamily).toBe('"JetBrains Mono", monospace');
  expect(shell.replay).toHaveBeenCalledOnce();
  expect(shell.onOutput).toHaveBeenCalledOnce();
  expect(shell.onReset).toHaveBeenCalledOnce();
  wrapper.unmount();
  expect(shell.onOutput.mock.results[0]?.value).toHaveBeenCalledOnce();
  expect(shell.onReset.mock.results[0]?.value).toHaveBeenCalledOnce();
});

test('Shell closed during font loading never creates a terminal or subscribes to output', async () => {
  const pending = Promise.withResolvers<FontFace[]>();
  loadFont.mockReturnValue(pending.promise);
  const { wrapper, shell } = mountShell();
  wrapper.unmount();

  pending.resolve([]);
  await flushPromises();
  expect(xtermMocks.state.constructorOptions).toBeNull();
  expect(shell.replay).not.toHaveBeenCalled();
  expect(shell.onOutput).not.toHaveBeenCalled();
  expect(shell.onReset).not.toHaveBeenCalled();
});

test('Shell remains usable with system monospace if a bundled font fails to load', async () => {
  const error = new Error('Font unavailable');
  loadFont.mockRejectedValue(error);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const { wrapper, shell } = mountShell();
  await flushPromises();

  expect(xtermMocks.state.constructorOptions?.fontFamily).toBe('monospace');
  expect(shell.onOutput).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith('Shell font failed to load; using system monospace', error);
  wrapper.unmount();
});
