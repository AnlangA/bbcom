<template>
  <span class="inline-editor-actions" role="group" :aria-label="label">
    <button
      type="button"
      class="inline-editor-actions__save"
      :disabled="!canSave || busy"
      @click="emit('save')"
    >
      {{ resolvedSaveText }}
    </button>
    <button
      type="button"
      class="inline-editor-actions__cancel"
      :disabled="busy"
      @click="emit('cancel')"
    >
      {{ resolvedCancelText }}
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '@/lib/i18n';

/**
 * The fixed save/cancel pair shown while a list row is being edited. One
 * keyboard order, one disabled semantics, one place to localize.
 */
const props = withDefaults(
  defineProps<{
    canSave?: boolean;
    busy?: boolean;
    saveText?: string;
    cancelText?: string;
    label?: string;
  }>(),
  {
    canSave: true,
    busy: false,
    saveText: undefined,
    cancelText: undefined,
    label: undefined,
  },
);

const emit = defineEmits<{ save: []; cancel: [] }>();

const resolvedSaveText = computed(() => props.saveText ?? t('common.save'));
const resolvedCancelText = computed(() => props.cancelText ?? t('common.cancel'));
</script>

<style scoped>
.inline-editor-actions {
  display: inline-flex;
  gap: 6px;
}

.inline-editor-actions__save,
.inline-editor-actions__cancel {
  min-height: 28px;
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.inline-editor-actions__save {
  background: var(--color-primary);
  color: var(--text-inverse);
}

.inline-editor-actions__save:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.inline-editor-actions__save:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.inline-editor-actions__cancel {
  background: transparent;
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.inline-editor-actions__cancel:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.inline-editor-actions__save:focus-visible,
.inline-editor-actions__cancel:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
</style>
