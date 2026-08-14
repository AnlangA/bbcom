<template>
  <div class="plugin-dialog-backdrop" role="presentation">
    <section
      ref="dialogElement"
      class="plugin-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      @keydown="handleKeydown"
    >
      <header class="plugin-dialog__header">
        <h2 :id="titleId">{{ title }}</h2>
        <button
          type="button"
          class="plugin-dialog__close"
          :aria-label="closeLabel"
          :disabled="closeDisabled"
          @click="close"
        >
          ×
        </button>
      </header>
      <slot />
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue';

const props = defineProps<{
  title: string;
  closeLabel: string;
  closeDisabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const titleId = `plugin-dialog-${useId()}`;
const dialogElement = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;

onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  void nextTick(() => {
    const first = focusableElements()[0];
    (first ?? dialogElement.value)?.focus();
  });
});

onUnmounted(() => {
  if (returnFocus?.isConnected) returnFocus.focus();
});

function close(): void {
  if (props.closeDisabled) return;
  emit('close');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (props.closeDisabled) return;
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialogElement.value?.focus();
    return;
  }
  const current = document.activeElement;
  const currentIndex = focusable.findIndex((element) => element === current);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1;
  if (currentIndex === -1 || nextIndex !== currentIndex + (event.shiftKey ? -1 : 1)) {
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }
}

function focusableElements(): HTMLElement[] {
  if (!dialogElement.value) return [];
  return Array.from(
    dialogElement.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}
</script>

<style scoped>
.plugin-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgb(0 0 0 / 55%);
}

.plugin-dialog {
  width: min(36rem, 100%);
  max-height: min(44rem, calc(100vh - 2rem));
  overflow: auto;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.6rem;
  padding: 1rem;
  background: var(--panel-bg, #111827);
  color: var(--text-color, #f8fafc);
  box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 35%);
}

.plugin-dialog:focus-visible {
  outline: 3px solid var(--primary-color, #60a5fa);
  outline-offset: 2px;
}

.plugin-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.plugin-dialog__header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.plugin-dialog__close {
  min-width: 2.25rem;
  min-height: 2.25rem;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: inherit;
  font-size: 1.5rem;
  cursor: pointer;
}

.plugin-dialog__close:focus-visible,
.plugin-dialog__close:hover {
  outline: 2px solid var(--primary-color, #60a5fa);
}
</style>
