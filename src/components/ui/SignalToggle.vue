<template>
  <label class="signal-toggle">
    <n-switch
      :value="modelValue"
      size="small"
      :aria-label="label"
      @update:value="emit('update:modelValue', $event)"
    />
    {{ label }}
  </label>
</template>

<script setup lang="ts">
import { NSwitch } from 'naive-ui';

/**
 * Compact labeled switch for serial signal lines (DTR/RTS). Shared by the
 * sidebar port config and the create-session dialog so both render the same
 * control with the same density.
 */
defineProps<{
  label: string;
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<style scoped>
.signal-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  cursor: pointer;
}
</style>
