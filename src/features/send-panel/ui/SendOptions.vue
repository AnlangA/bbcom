<template>
  <div class="send-options">
    <div class="mode-switch">
      <button
        type="button"
        class="mode-option"
        :class="{ active: !isHex }"
        :aria-pressed="!isHex"
        :disabled="disabled"
        @click="emit('update:isHex', false)"
      >
        {{ t('send.mode.text') }}
      </button>
      <button
        type="button"
        class="mode-option"
        :class="{ active: isHex }"
        :aria-pressed="isHex"
        :disabled="disabled"
        @click="emit('update:isHex', true)"
      >
        HEX
      </button>
    </div>
    <AppSelect
      v-if="!isHex"
      :value="lineEnding"
      :options="lineEndingOptions"
      :aria-label="t('send.lineEnding.label')"
      :title="t('send.lineEnding.label')"
      class="ending-select"
      size="small"
      :disabled="disabled"
      @update:value="emit('update:lineEnding', $event as LineEnding)"
    />
    <AppSelect
      v-else
      :value="checksum"
      :options="checksumOptions"
      :aria-label="t('checksum.title')"
      class="checksum-select"
      size="small"
      :disabled="disabled"
      @update:value="emit('update:checksum', $event as 'none' | ChecksumType)"
    />
    <n-input-number
      :value="loopInterval"
      size="small"
      :min="50"
      :max="3600000"
      :step="100"
      :show-button="false"
      class="interval-input"
      :disabled="disabled"
      :title="t('send.loopIntervalHint')"
      :aria-label="t('send.loopIntervalHint')"
      @update:value="emit('update:loopInterval', $event ?? 1000)"
    >
      <template #prefix><Timer class="icon-sm interval-icon" aria-hidden="true" /></template>
      <template #suffix>ms</template>
    </n-input-number>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NInputNumber } from 'naive-ui';
import { Timer } from '@lucide/vue';
import AppSelect from '@/design-system/AppSelect.vue';
import { checksumAlgoOptionsWithNone } from '@/lib/checksum-constants';
import { t } from '@/lib/i18n';
import type { ChecksumType, LineEnding } from '@/types';

defineProps<{
  isHex: boolean;
  lineEnding: LineEnding;
  checksum: 'none' | ChecksumType;
  loopInterval: number;
  disabled: boolean;
}>();

const emit = defineEmits<{
  'update:isHex': [value: boolean];
  'update:lineEnding': [value: LineEnding];
  'update:checksum': [value: 'none' | ChecksumType];
  'update:loopInterval': [value: number];
}>();

const lineEndingOptions = computed(() => [
  { label: t('send.lineEnding.none'), value: 'none' },
  { label: 'CR', value: 'CR' },
  { label: 'LF', value: 'LF' },
  { label: 'CRLF', value: 'CRLF' },
]);

const checksumOptions = computed(() =>
  checksumAlgoOptionsWithNone.map((option) => ({
    ...option,
    label:
      option.value === 'none'
        ? t('checksum.none')
        : option.value === 'CHECKSUM'
          ? t('checksum.checksum')
          : option.label,
  })),
);
</script>

<style scoped>
.send-options {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-sm);
  min-width: 0;
}

.mode-switch {
  display: flex;
  align-items: center;
  padding: var(--space-2xs);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}

.mode-option {
  padding: var(--space-xs) var(--space-sm);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.mode-option.active {
  color: var(--color-primary);
  background: var(--bg-active);
}

.mode-option:hover:not(:disabled) {
  color: var(--text-primary);
}

.mode-option:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.mode-option:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ending-select {
  width: 110px;
}

.checksum-select {
  width: 156px;
}

.interval-input {
  width: 128px;
}

.interval-icon {
  color: var(--text-muted);
}
</style>
