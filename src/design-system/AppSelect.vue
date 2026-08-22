<template>
  <span
    class="app-select-wrap"
    :class="[size ? `app-select--${size}` : undefined, { 'is-disabled': disabled }]"
  >
    <select
      class="app-select"
      :value="selectedOptionIndex"
      :disabled="disabled"
      :aria-label="ariaLabel || undefined"
      :aria-labelledby="ariaLabelledby || undefined"
      @change="updateValue"
    >
      <option v-if="showEmptyOption" value="" :disabled="!clearable">
        {{ placeholder || '—' }}
      </option>
      <option
        v-for="(option, index) in options"
        :key="`${index}:${String(option.value)}`"
        :value="String(index)"
        :disabled="option.disabled"
      >
        {{ option.label ?? '' }}
      </option>
    </select>
    <svg
      class="app-select-chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * A deliberately small, typed wrapper around the browser select control.
 *
 * All application select choices are finite, local option lists. Native
 * controls preserve keyboard and screen-reader behavior while avoiding a
 * popup/date/virtual-list dependency graph for simple configuration fields.
 * The option index is used as the DOM value so numbers and strings round-trip
 * without lossy string coercion.
 */
interface AppSelectOption {
  label?: unknown;
  value?: unknown;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    value?: unknown;
    options: readonly AppSelectOption[];
    placeholder?: string;
    clearable?: boolean;
    disabled?: boolean;
    size?: 'tiny' | 'small' | 'medium' | 'large';
    /** Explicit accessible name. Callers must not rely on the current value. */
    ariaLabel?: string;
    /** Alternative explicit naming: id of the labelling element. */
    ariaLabelledby?: string;
  }>(),
  {
    value: undefined,
    placeholder: '',
    clearable: false,
    disabled: false,
    size: undefined,
    ariaLabel: undefined,
    ariaLabelledby: undefined,
  },
);

// `never` intentionally leaves listeners free to accept their own inferred
// value type. The implementation only emits values supplied in `options`.
const emit = defineEmits<{ 'update:value': [value: never] }>();

const selectedOptionIndex = computed(() => {
  const index = props.options.findIndex((option) => Object.is(option.value, props.value));
  return index < 0 ? '' : String(index);
});
const showEmptyOption = computed(() => props.clearable || Boolean(props.placeholder));

function updateValue(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === '') {
    if (props.clearable) emit('update:value', null as never);
    return;
  }
  const option = props.options[Number(value)];
  if (option) emit('update:value', option.value as never);
}
</script>

<style scoped>
/* Wrapper lets us overlay a chevron affordance (native <select> can't render
   pseudo-elements) and share one disabled/hover state between the control and
   the indicator. The wrapper is what callers size via inline `style="width:"`. */
.app-select-wrap {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  min-width: 0;
}

.app-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  appearance: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 5px 26px 5px 8px;
  color: var(--text-primary);
  background: var(--bg-inset);
  font: inherit;
  line-height: 1.4;
  cursor: pointer;
  text-overflow: ellipsis;
  transition:
    border-color var(--transition-normal),
    background var(--transition-normal),
    box-shadow var(--transition-normal);
}

.app-select:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-secondary);
}

.app-select-chevron {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-dim);
  pointer-events: none;
  transition:
    color var(--transition-fast),
    transform var(--transition-fast);
}

.app-select-wrap:hover:not(.is-disabled) .app-select-chevron {
  color: var(--text-muted);
}

.app-select:focus-visible {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--shadow-focus);
}

.app-select:focus-visible + .app-select-chevron {
  color: var(--color-primary);
}

.app-select-wrap.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.app-select:disabled {
  cursor: not-allowed;
}

.app-select--tiny .app-select {
  min-height: 24px;
  padding-top: 2px;
  padding-bottom: 2px;
  font-size: var(--font-size-data);
}

.app-select--small .app-select {
  min-height: var(--control-h-md);
  padding-top: 3px;
  padding-bottom: 3px;
  font-size: var(--font-size-base);
}

.app-select--large .app-select {
  min-height: 40px;
}
</style>
