<template>
  <button
    :type="type"
    class="icon-action-button"
    :class="[`icon-action-button--${tone}`, { 'is-active': active }]"
    :disabled="disabled"
    :aria-label="label"
    :aria-pressed="toggleable ? active : undefined"
    :title="showTitle ? label : undefined"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
/**
 * The single icon-only button: 28×28 minimum hit area, mandatory accessible
 * name, consistent tone/danger/focus-visible semantics across the app.
 */
withDefaults(
  defineProps<{
    label: string;
    type?: 'button' | 'submit';
    disabled?: boolean;
    tone?: 'default' | 'danger' | 'primary';
    toggleable?: boolean;
    active?: boolean;
    showTitle?: boolean;
  }>(),
  {
    type: 'button',
    disabled: false,
    tone: 'default',
    toggleable: false,
    active: false,
    showTitle: true,
  },
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();
</script>

<style scoped>
.icon-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--control-h-md);
  min-height: var(--control-h-md);
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.icon-action-button:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.icon-action-button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.icon-action-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.icon-action-button--danger {
  color: var(--color-error);
}

.icon-action-button--danger:hover:not(:disabled) {
  color: var(--color-error);
  background: var(--accent-red-subtle);
}

.icon-action-button--primary {
  color: var(--color-primary);
}

.icon-action-button--primary:hover:not(:disabled) {
  color: var(--color-primary-hover);
  background: var(--color-primary-subtle);
}

.icon-action-button.is-active {
  color: var(--color-primary);
  background: var(--bg-active);
}
</style>
