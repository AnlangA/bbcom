<template>
  <div class="checksum-panel">
    <n-input
      v-model:value="input"
      :placeholder="t('checksum.placeholder')"
      :aria-label="t('checksum.placeholder')"
      size="small"
      :status="state.status"
      @blur="normalize"
    />
    <div class="checksum-panel__meta">
      <span>{{ t('checksum.byteCount', { count: state.byteCount }) }}</span>
      <span v-if="input && !state.isValid" class="checksum-panel__error">
        {{ t('checksum.hexEvenError') }}
      </span>
    </div>
    <AppSelect
      v-model:value="algorithm"
      :aria-label="t('checksum.title')"
      :options="algorithmOptions"
      size="small"
    />
    <button
      v-if="result"
      class="checksum-panel__result"
      type="button"
      :title="t('checksum.copyTitle')"
      @click="copy"
    >
      <span>{{ t('checksum.result') }}</span>
      <code>{{ result }}</code>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { NInput } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { calculateChecksum } from '@/features/platform/native';
import { checksumOptions } from '@/lib/checksum-constants';
import { parseHex } from '@/lib/format';
import { t } from '@/lib/i18n';
import {
  canCalculateChecksum,
  checksumInputState,
  isCopyableChecksumResult,
  localizeChecksumOptions,
  normalizeChecksumInputValue,
} from '@/lib/port-selector';
import type { ChecksumType } from '@/types';

const input = ref('');
const algorithm = ref<ChecksumType>('CHECKSUM');
const result = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

const state = computed(() => checksumInputState(input.value));
const algorithmOptions = computed(() =>
  localizeChecksumOptions(checksumOptions, t('checksum.checksum')),
);

watch([input, algorithm], () => {
  if (timer) clearTimeout(timer);
  result.value = '';
  if (!canCalculateChecksum(input.value)) return;
  timer = setTimeout(() => void calculate(), 150);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

async function calculate(): Promise<void> {
  if (!canCalculateChecksum(input.value)) return;
  try {
    result.value = (await calculateChecksum(parseHex(input.value), algorithm.value)).result;
  } catch {
    result.value = t('checksum.failed');
  }
}

function normalize(): void {
  input.value = normalizeChecksumInputValue(input.value);
}

async function copy(): Promise<void> {
  if (!isCopyableChecksumResult(result.value, t('checksum.failed'))) return;
  try {
    await navigator.clipboard.writeText(result.value);
  } catch {
    // Clipboard availability is platform-owned; the calculated result remains visible.
  }
}
</script>

<style scoped>
.checksum-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: var(--space-sm);
  align-items: center;
}

.checksum-panel__meta {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.checksum-panel__error {
  color: var(--color-error);
}

.checksum-panel__result {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  min-height: 32px;
  padding: var(--space-sm);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-secondary);
  cursor: pointer;
}

.checksum-panel__result code {
  color: var(--text-primary);
}
</style>
