// @vitest-environment happy-dom

import { computed, defineComponent, nextTick, ref, watch } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, test, vi } from 'vitest';
import ToolsTabs from '../../src/components/send-panel/ToolsTabs.vue';
import SettingsModal from '../../src/components/app-shell/SettingsModal.vue';
import StatusBar from '../../src/components/status-bar/StatusBar.vue';
import WaveformPanel from '../../src/components/terminal/WaveformPanel.vue';
import { createSessionRecord } from '../../src/lib/session-persistence.ts';
import type { SessionRuntimeMacroController } from '../../src/features/sessions/runtime/session-runtime-controller.ts';
import type { DataFrame, PortConfig } from '../../src/types/index.ts';

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    useMessage: () => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }),
  };
});

export interface AccessibilityAuditIssue {
  rule:
    | 'interactive-name'
    | 'form-field-name'
    | 'tab-relation'
    | 'dialog-name'
    | 'dialog-modal'
    | 'dialog-relation'
    | 'canvas-name';
  element: Element;
}

/**
 * Component fixtures shared with the accessibility workflow checks. The G33
 * release gate itself runs axe-core in a real Chrome renderer from
 * `tests/e2e/browser/workspace-journey.e2e.mjs`; the bounded checks below remain
 * focused regression diagnostics and are not presented as an axe substitute.
 */
export const G33_REAL_AXE_FIXTURE = Object.freeze({
  selector: '[data-g33-axe-scope]',
  impacts: ['serious', 'critical'] as const,
});

function isHidden(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true')
      return true;
    if (current.hasAttribute('inert')) return true;
    if (current instanceof HTMLElement && current.style.display === 'none') return true;
  }
  return false;
}

function referencedText(element: Element, attribute: string): string {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = referencedText(element, 'aria-labelledby');
  if (labelledBy) return labelledBy;

  if (element instanceof HTMLElement && element.id) {
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('label[for]')).filter(
      (label) => label.htmlFor === element.id,
    );
    const text = labels.map((label) => label.textContent?.trim() ?? '').join(' ');
    if (text) return text;
  }
  const wrappingLabel = element.closest('label')?.textContent?.trim();
  if (wrappingLabel) return wrappingLabel;
  const title = element.getAttribute('title')?.trim();
  if (title) return title;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.placeholder.trim()) return element.placeholder.trim();
  }
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLAnchorElement ||
    element.getAttribute('role') === 'button' ||
    element.getAttribute('role') === 'tab'
  ) {
    return element.textContent?.trim() ?? '';
  }
  return '';
}

function referencesExistingIds(element: Element, attribute: string): boolean {
  const ids = (element.getAttribute(attribute) ?? '').split(/\s+/u).filter(Boolean);
  return ids.length > 0 && ids.every((id) => document.getElementById(id) !== null);
}

/** Common serious/critical DOM checks. This is intentionally narrower than axe. */
export function auditCommonSeriousCriticalRules(root: ParentNode): AccessibilityAuditIssue[] {
  const issues: AccessibilityAuditIssue[] = [];
  const visible = (selector: string) =>
    Array.from(root.querySelectorAll(selector)).filter((element) => !isHidden(element));

  const interactiveSelector = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="tab"]',
  ].join(',');
  for (const element of visible(interactiveSelector)) {
    if (!accessibleName(element)) issues.push({ rule: 'interactive-name', element });
  }

  for (const element of visible('input:not([type="hidden"]), select, textarea')) {
    if (!accessibleName(element)) issues.push({ rule: 'form-field-name', element });
  }

  for (const tablist of visible('[role="tablist"]')) {
    const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'));
    const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
    if (!accessibleName(tablist) || tabs.length === 0 || selected.length !== 1) {
      issues.push({ rule: 'tab-relation', element: tablist });
    }
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls') ?? '';
      const panel = panelId ? document.getElementById(panelId) : null;
      const shouldBeFocusable = tab.getAttribute('aria-selected') === 'true';
      if (
        !tab.id ||
        !panel ||
        panel.getAttribute('role') !== 'tabpanel' ||
        !panel.getAttribute('aria-labelledby')?.split(/\s+/u).includes(tab.id) ||
        tab.tabIndex !== (shouldBeFocusable ? 0 : -1)
      ) {
        issues.push({ rule: 'tab-relation', element: tab });
      }
    }
  }

  for (const dialog of visible('[role="dialog"], [role="alertdialog"]')) {
    if (!accessibleName(dialog)) issues.push({ rule: 'dialog-name', element: dialog });
    if (dialog.getAttribute('aria-modal') !== 'true') {
      issues.push({ rule: 'dialog-modal', element: dialog });
    }
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      if (dialog.hasAttribute(attribute) && !referencesExistingIds(dialog, attribute)) {
        issues.push({ rule: 'dialog-relation', element: dialog });
      }
    }
  }

  for (const canvas of visible('canvas')) {
    if (canvas.getAttribute('role') !== 'img' || !accessibleName(canvas)) {
      issues.push({ rule: 'canvas-name', element: canvas });
    }
  }
  return issues;
}

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function fakeMacroRunner(): SessionRuntimeMacroController {
  return {
    running: ref(false),
    status: computed(() => 'idle' as const),
    run: vi.fn(async (macro) => ({
      completed: macro.steps.length,
      failedAt: macro.steps.length,
      aborted: false,
    })),
    abort: vi.fn(),
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  setActivePinia(createPinia());
});

test('bounded DOM audit identifies common serious/critical failures without claiming axe parity', () => {
  const fixture = document.createElement('div');
  fixture.innerHTML = `
    <button><svg aria-hidden="true"></svg></button>
    <input />
    <div role="tablist">
      <button role="tab" aria-selected="true" tabindex="-1">One</button>
    </div>
    <div role="dialog" aria-modal="false"></div>
    <canvas></canvas>
  `;
  document.body.append(fixture);
  const rules = new Set(auditCommonSeriousCriticalRules(fixture).map((issue) => issue.rule));
  expect(rules).toEqual(
    new Set([
      'interactive-name',
      'form-field-name',
      'tab-relation',
      'dialog-name',
      'dialog-modal',
      'canvas-name',
    ]),
  );
});

test('Tools tabs have complete relations and support roving keyboard focus', async () => {
  const wrapper = mount(ToolsTabs, {
    attachTo: document.body,
    props: {
      sessionId: 'accessibility-session',
      modelValue: 'AT',
      isHex: false,
      history: [{ data: 'AT+OLD', isHex: false, timestamp: 1 }],
      quickCommands: [{ id: 'quick-1', name: 'Ping', data: 'AT', isHex: false }],
      onSend: vi.fn(async () => true),
      macroRunner: fakeMacroRunner(),
    },
  });
  wrapper.element.setAttribute('data-g33-axe-scope', 'tools-workflow');

  expect(auditCommonSeriousCriticalRules(wrapper.element)).toEqual([]);
  const tabs = wrapper.findAll<HTMLElement>('[role="tab"]');
  const first = tabs[0];
  first.element.focus();
  await first.trigger('keydown', { key: 'End' });
  await nextTick();

  const last = wrapper.findAll<HTMLElement>('[role="tab"]').at(-1)!;
  expect(last.attributes('aria-selected')).toBe('true');
  expect(last.attributes('tabindex')).toBe('0');
  expect(document.activeElement).toBe(last.element);
  wrapper.unmount();
});

test('settings dialog focuses its contents, exposes saved status, and restores its trigger', async () => {
  const ModalStub = defineComponent({
    name: 'NModal',
    inheritAttrs: false,
    props: { show: Boolean, title: String },
    emits: ['update:show', 'after-enter', 'after-leave'],
    setup(props, { emit }) {
      watch(
        () => props.show,
        (show) => {
          void nextTick(() => emit(show ? 'after-enter' : 'after-leave'));
        },
        { flush: 'post' },
      );
      return {};
    },
    template: `
      <div v-if="show" role="dialog" aria-modal="true" :aria-label="title">
        <slot /><slot name="footer" />
      </div>
    `,
  });
  const SwitchStub = defineComponent({
    name: 'NSwitch',
    props: { value: Boolean, checked: Boolean },
    emits: ['update:value', 'update:checked'],
    template: '<button type="button" role="switch" :aria-checked="value ?? checked" />',
  });
  const InputNumberStub = defineComponent({
    name: 'NInputNumber',
    props: { value: Number },
    emits: ['update:value'],
    template: '<input type="number" :value="value" />',
  });
  const ButtonStub = defineComponent({
    name: 'NButton',
    template: '<button type="button"><slot name="icon" /><slot /></button>',
  });
  const Harness = defineComponent({
    components: { SettingsModal },
    setup() {
      const show = ref(false);
      return { show };
    },
    template: `
      <div data-g33-axe-scope="settings-workflow">
        <button id="settings-trigger" type="button" @click="show = true">Settings</button>
        <SettingsModal v-model:show="show" />
      </div>
    `,
  });
  const wrapper = mount(Harness, {
    attachTo: document.body,
    global: {
      stubs: {
        Teleport: true,
        NModal: ModalStub,
        Modal: ModalStub,
        NSwitch: SwitchStub,
        Switch: SwitchStub,
        NInputNumber: InputNumberStub,
        InputNumber: InputNumberStub,
        NButton: ButtonStub,
        Button: ButtonStub,
      },
    },
  });
  const trigger = wrapper.find<HTMLElement>('#settings-trigger');
  trigger.element.focus();
  await trigger.trigger('click');
  await nextTick();
  await nextTick();

  const dialog = wrapper.find<HTMLElement>('[role="dialog"]');
  expect(dialog.element.contains(document.activeElement)).toBe(true);
  expect(wrapper.find('[role="status"][aria-live="polite"]').exists()).toBe(true);
  expect(auditCommonSeriousCriticalRules(wrapper.element)).toEqual([]);

  await wrapper.find('.settings-footer button').trigger('click');
  await nextTick();
  await nextTick();
  await nextTick();
  expect(document.activeElement).toBe(trigger.element);
  wrapper.unmount();
});

test('connection state is live and waveform exposes an image plus its latest 100 samples', async () => {
  const status = mount(StatusBar, {
    attachTo: document.body,
    props: { session: createSessionRecord('status-session', 'COM-A', config), framesVersion: 0 },
  });
  const liveStatus = status.find('[role="status"][aria-live="polite"]');
  expect(liveStatus.exists()).toBe(true);
  expect(liveStatus.text()).toBeTruthy();
  status.unmount();

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', undefined);
  const frames: DataFrame[] = Array.from({ length: 105 }, (_, index) => ({
    id: `wave-${index}`,
    direction: 'RX',
    timestamp: index,
    data: new TextEncoder().encode(String(index)),
  }));
  try {
    const waveform = mount(WaveformPanel, {
      attachTo: document.body,
      props: {
        frames,
        framesVersion: 1,
        waveform: {
          channels: [{ channelIndex: 0, config: { visible: true } }],
          samples: Array.from({ length: 105 }, (_, index) => ({
            channelIndex: 0,
            seq: index,
            timestampMs: index,
            value: index,
          })),
          frameCursor: { consumed: 105, lastFrameId: 'wave-104' },
        },
      },
      global: { stubs: { WaveformLegend: true } },
    });
    waveform.element.setAttribute('data-g33-axe-scope', 'waveform-workflow');
    await nextTick();
    expect(waveform.find('canvas').attributes('role')).toBe('img');
    expect(waveform.find('canvas').attributes('aria-label')).toBeTruthy();
    expect(waveform.findAll('table tbody tr')).toHaveLength(100);
    expect(waveform.emitted('appendSamples')).toBeUndefined();
    expect(auditCommonSeriousCriticalRules(waveform.element)).toEqual([]);
    waveform.unmount();
  } finally {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
    vi.unstubAllGlobals();
  }
});
