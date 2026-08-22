<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="app-modal-overlay"
      @pointerdown.self="requestClose('overlay')"
      @keydown.esc.stop.prevent="requestClose('escape')"
      @keydown.tab="trapTab"
    >
      <div
        ref="dialogElement"
        class="app-modal"
        :class="{ 'app-modal--danger': danger }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :style="{ width: typeof width === 'number' ? `${width}px` : width }"
        tabindex="-1"
      >
        <header class="app-modal__header">
          <h2 class="app-modal__title" :id="titleId">{{ title }}</h2>
          <button
            v-if="closable"
            type="button"
            class="app-modal__close"
            :aria-label="t('common.close')"
            :disabled="busy"
            @click="requestClose('close-button')"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div class="app-modal__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="app-modal__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { t } from '@/lib/i18n';

/**
 * The single application modal shell: focus trap, Escape/overlay close,
 * busy-safe confirmation, and focus restoration to the previously focused
 * element. Replaces the hand-rolled per-dialog focus logic.
 */
const props = withDefaults(
  defineProps<{
    show: boolean;
    title: string;
    width?: string | number;
    closable?: boolean;
    busy?: boolean;
    danger?: boolean;
  }>(),
  { width: 460, closable: true, busy: false, danger: false },
);

const emit = defineEmits<{ close: [via: 'overlay' | 'escape' | 'close-button'] }>();

const dialogElement = ref<HTMLElement | null>(null);
// useId (not Math.random) so ids are SSR-safe, collision-free, and stable
// across dev HMR reloads that re-run module setup.
const titleId = `app-modal-title-${useId().replace(/:/g, '')}`;
let restoreFocus: HTMLElement | null = null;
let focusInsideHandler: ((event: FocusEvent) => void) | null = null;

function requestClose(via: 'overlay' | 'escape' | 'close-button'): void {
  if (!props.closable || props.busy) return;
  emit('close', via);
}

function trapFocus(event: FocusEvent): void {
  const dialog = dialogElement.value;
  if (!dialog || dialog.contains(event.target as Node)) return;
  const focusables = dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  (focusables[0] ?? dialog).focus();
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
}

function trapTab(event: KeyboardEvent): void {
  const dialog = dialogElement.value;
  if (!dialog) return;
  const focusables = focusableElements(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables.at(-1);
  if (
    (!event.shiftKey && document.activeElement === last) ||
    (event.shiftKey && (document.activeElement === first || document.activeElement === dialog))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
}

watch(
  () => props.show,
  async (show) => {
    if (show) {
      restoreFocus = (document.activeElement as HTMLElement) ?? null;
      await nextTick();
      const dialog = dialogElement.value;
      if (dialog) {
        const first = dialog.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        (first ?? dialog).focus();
        focusInsideHandler = trapFocus;
        document.addEventListener('focusin', focusInsideHandler);
      }
    } else {
      if (focusInsideHandler) {
        document.removeEventListener('focusin', focusInsideHandler);
        focusInsideHandler = null;
      }
      restoreFocus?.focus();
      restoreFocus = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (focusInsideHandler) document.removeEventListener('focusin', focusInsideHandler);
  restoreFocus?.focus();
});
</script>

<style scoped>
.app-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-backdrop);
  padding: 24px;
}

.app-modal {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: min(640px, calc(100vh - 48px));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.app-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
}

.app-modal__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-primary);
}

.app-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  min-height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.app-modal__close:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.app-modal__close:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.app-modal__close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.app-modal__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
}

.app-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 14px;
}

.app-modal--danger .app-modal__title {
  color: var(--color-error);
}
</style>
