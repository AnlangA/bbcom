<!--
  Parser config bar: title + preset/kind/delimiter/fixed/length config inputs +
  close button. Extracted from ParserPanel. Two-way binds the config
  fields via v-model so the parent owns the parser-config state.
-->
<template>
  <div class="parser-header">
    <span class="pp-title">
      <Binary class="icon-sm" />
      {{ t('parser.title') }}
    </span>
    <div class="pp-config" role="group" :aria-label="t('parser.title')">
      <AppSelect
        :value="presetId"
        :options="presetOptions"
        :placeholder="t('parser.presetPlaceholder')"
        :aria-label="t('parser.presetPlaceholder')"
        size="tiny"
        style="width: 150px"
        @update:value="(v) => $emit('apply-preset', v)"
      />
      <AppSelect
        :value="kind"
        :aria-label="t('parser.title')"
        @update:value="(v) => $emit('update:kind', v)"
        :options="kindOptions"
        size="tiny"
        style="width: 96px"
      />
      <n-input
        v-if="kind === 'delimiter'"
        :value="delimiterHex"
        @update:value="(v) => $emit('update:delimiterHex', v ?? '')"
        size="tiny"
        :placeholder="t('parser.delimiterPlaceholder')"
        :aria-label="t('parser.delimiterPlaceholder')"
        style="width: 130px"
      />
      <n-checkbox
        v-if="kind === 'delimiter'"
        :checked="includeDelimiter"
        @update:checked="(v) => $emit('update:includeDelimiter', v)"
        size="small"
      >
        {{ t('parser.includeDelimiter') }}
      </n-checkbox>
      <n-input-number
        v-if="kind === 'fixed'"
        :value="fixedSize"
        @update:value="(v) => $emit('update:fixedSize', v ?? 1)"
        size="tiny"
        :min="1"
        :max="65535"
        :aria-label="t('parser.kind.fixed')"
        style="width: 110px"
      >
        <template #suffix>B</template>
      </n-input-number>
      <template v-if="kind === 'length'">
        <n-input-number
          :value="lenOffset"
          @update:value="(v) => $emit('update:lenOffset', v ?? 0)"
          size="tiny"
          :min="0"
          :max="255"
          :aria-label="t('parser.detail.offset', { offset: lenOffset })"
          style="width: 90px"
        >
          <template #suffix>off</template>
        </n-input-number>
        <AppSelect
          :value="lenSize"
          :aria-label="t('parser.kind.length')"
          @update:value="(v) => $emit('update:lenSize', v)"
          :options="lenSizeOptions"
          size="tiny"
          style="width: 70px"
        />
        <n-checkbox
          :checked="lenBigEndian"
          @update:checked="(v) => $emit('update:lenBigEndian', v)"
          size="small"
          >BE</n-checkbox
        >
        <n-input-number
          :value="lenAdjust"
          @update:value="(v) => $emit('update:lenAdjust', v ?? 0)"
          size="tiny"
          :min="0"
          :max="65535"
          :aria-label="t('parser.kind.length')"
          style="width: 90px"
        >
          <template #suffix>adj</template>
        </n-input-number>
      </template>
    </div>
    <button
      class="pp-close"
      type="button"
      :title="t('parser.close')"
      :aria-label="t('parser.close')"
      @click="$emit('close')"
    >
      <X class="icon-sm" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { NCheckbox, NInput, NInputNumber } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { Binary, X } from '@lucide/vue';
import { t } from '../../lib/i18n';

defineProps<{
  presetId: string | null;
  presetOptions: { label: string; value: string }[];
  kindOptions: { label: string; value: string }[];
  lenSizeOptions: { label: string; value: number }[];
  kind: string;
  delimiterHex: string;
  includeDelimiter: boolean;
  fixedSize: number;
  lenOffset: number;
  lenSize: number;
  lenBigEndian: boolean;
  lenAdjust: number;
}>();

defineEmits<{
  close: [];
  'apply-preset': [string];
  'update:kind': [string];
  'update:delimiterHex': [string];
  'update:includeDelimiter': [boolean];
  'update:fixedSize': [number];
  'update:lenOffset': [number];
  'update:lenSize': [number];
  'update:lenBigEndian': [boolean];
  'update:lenAdjust': [number];
}>();
</script>

<style scoped>
.parser-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.pp-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.pp-config {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
}

.pp-close {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
}

.pp-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
</style>
