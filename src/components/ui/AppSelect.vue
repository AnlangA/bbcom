<template>
  <select
    class="app-select"
    :class="size ? `app-select--${size}` : undefined"
    :value="selectedOptionIndex"
    :disabled="disabled"
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
    menuProps?: unknown;
  }>(),
  {
    value: undefined,
    placeholder: '',
    clearable: false,
    disabled: false,
    size: undefined,
    menuProps: undefined,
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
.app-select {
  box-sizing: border-box;
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 5px 26px 5px 8px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  font: inherit;
  line-height: 1.4;
}

.app-select--tiny {
  min-height: 24px;
  padding-top: 2px;
  padding-bottom: 2px;
  font-size: 12px;
}

.app-select--small {
  min-height: 28px;
  padding-top: 3px;
  padding-bottom: 3px;
  font-size: 13px;
}

.app-select--large {
  min-height: 40px;
}

.app-select:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.app-select:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
