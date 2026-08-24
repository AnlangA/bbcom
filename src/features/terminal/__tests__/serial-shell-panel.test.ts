/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import type { SerialShellConfig } from '@/types';

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

beforeEach(() => {
  xtermMocks.state.constructorOptions = null;
  xtermMocks.state.customKeyHandler = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('Shell terminal sends physical Enter directly without changing RX rendering semantics', () => {
  const handleTerminalData = vi.fn();
  const wrapper = shallowMount(SerialShellPanel, {
    props: {
      sessionId: 'session-shell',
      config,
      isConnected: true,
      shell: {
        replay: () => '',
        onOutput: () => () => undefined,
        onReset: () => () => undefined,
        handleTerminalData,
        clear: vi.fn(),
      },
    },
  });

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
