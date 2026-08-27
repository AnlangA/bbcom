<template>
  <div class="cbor-node" :class="{ 'is-leaf': !container }">
    <button
      v-if="container"
      class="cbor-toggle"
      type="button"
      :aria-expanded="expanded"
      :style="{ paddingInlineStart: `${depth * 14}px` }"
      @click="expanded = !expanded"
    >
      <ChevronRight class="cbor-chevron" :class="{ expanded }" />
      <span v-if="label !== undefined" class="cbor-key">{{ label }}</span>
      <span class="cbor-summary">{{ summary }}</span>
    </button>
    <div v-else class="cbor-leaf" :style="{ paddingInlineStart: `${depth * 14 + 20}px` }">
      <span v-if="label !== undefined" class="cbor-key">{{ label }}</span>
      <span class="cbor-value" :class="`type-${valueType}`">{{ scalarText }}</span>
    </div>

    <div v-if="container && expanded" class="cbor-children">
      <ParserCborTree
        v-for="entry in visibleEntries"
        :key="entry.key"
        :label="entry.label"
        :value="entry.value"
        :depth="depth + 1"
      />
      <div v-if="pageCount > 1" class="cbor-page">
        <button
          type="button"
          :aria-label="t('parser.cbor.previousPage')"
          :disabled="page === 0"
          @click="page -= 1"
        >
          {{ t('parser.cbor.previous') }}
        </button>
        <span>{{
          t('parser.cbor.page', { start: pageStart + 1, end: pageEnd, total: entries.length })
        }}</span>
        <button
          type="button"
          :aria-label="t('parser.cbor.nextPage')"
          :disabled="page >= pageCount - 1"
          @click="page += 1"
        >
          {{ t('parser.cbor.next') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { t } from '@/lib/i18n';

const props = withDefaults(
  defineProps<{
    value: unknown;
    label?: string;
    depth?: number;
  }>(),
  { label: undefined, depth: 0 },
);

defineOptions({ name: 'ParserCborTree' });

const MAX_CHILDREN_PER_NODE = 100;
const expanded = ref(props.depth === 0);
const page = ref(0);

interface TreeEntry {
  key: string;
  label: string;
  value: unknown;
}

const entries = computed<TreeEntry[]>(() => {
  if (props.depth >= 32) return [];
  if (props.value instanceof Map) {
    return Array.from(props.value.entries()).map(([key, value], index) => ({
      key: `${index}:${scalarPreview(key)}`,
      label: scalarPreview(key),
      value,
    }));
  }
  if (Array.isArray(props.value)) {
    return props.value.map((value, index) => ({
      key: String(index),
      label: `[${index}]`,
      value,
    }));
  }
  if (isPlainObject(props.value)) {
    return Object.entries(props.value).map(([key, value]) => ({ key, label: key, value }));
  }
  return [];
});

const container = computed(
  () =>
    !(props.value instanceof Uint8Array) &&
    (props.value instanceof Map || Array.isArray(props.value) || isPlainObject(props.value)),
);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(entries.value.length / MAX_CHILDREN_PER_NODE)),
);
const pageStart = computed(() => page.value * MAX_CHILDREN_PER_NODE);
const pageEnd = computed(() =>
  Math.min(entries.value.length, pageStart.value + MAX_CHILDREN_PER_NODE),
);
const visibleEntries = computed(() => entries.value.slice(pageStart.value, pageEnd.value));

watch(
  () => entries.value.length,
  () => {
    page.value = Math.min(page.value, pageCount.value - 1);
  },
);

const valueType = computed(() => {
  if (props.value === null) return 'null';
  if (props.value instanceof Uint8Array) return 'bytes';
  if (typeof props.value === 'bigint') return 'number';
  return typeof props.value;
});

const scalarText = computed(() => scalarPreview(props.value, 96));
const summary = computed(() => {
  if (props.value instanceof Map) return t('parser.cbor.map', { count: props.value.size });
  if (Array.isArray(props.value)) return t('parser.cbor.array', { count: props.value.length });
  return t('parser.cbor.map', { count: entries.value.length });
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array);
}

function scalarPreview(value: unknown, maxUnits = 24): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Uint8Array) {
    const preview = Array.from(value.subarray(0, maxUnits), (byte) =>
      byte.toString(16).toUpperCase().padStart(2, '0'),
    ).join(' ');
    const suffix = value.length > maxUnits ? ' …' : '';
    return `${t('parser.cbor.bytes', { count: value.length })} ${preview}${suffix}`;
  }
  if (typeof value === 'string') {
    const preview = JSON.stringify(value.slice(0, maxUnits));
    return value.length > maxUnits ? `${preview} … (${value.length} chars)` : preview;
  }
  if (typeof value === 'bigint') return boundedBigIntPreview(value, maxUnits);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}

function boundedBigIntPreview(value: bigint, maxDigits: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const decimalLimit = 10n ** BigInt(maxDigits);
  if (magnitude < decimalLimit) return value.toString(10);
  return `${negative ? '-' : ''}≥1${'0'.repeat(maxDigits)} (> ${maxDigits} digits)`;
}
</script>

<style scoped>
.cbor-node {
  min-width: max-content;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 24px;
}

.cbor-toggle,
.cbor-leaf {
  min-height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cbor-toggle {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.cbor-toggle:hover,
.cbor-toggle:focus-visible {
  background: var(--bg-hover);
  outline: none;
}

.cbor-chevron {
  width: 14px;
  height: 14px;
  color: var(--text-dim);
  transition: transform var(--transition-fast);
}

.cbor-chevron.expanded {
  transform: rotate(90deg);
}

.cbor-key {
  color: var(--accent-blue);
}

.cbor-key::after {
  content: ':';
  color: var(--text-dim);
}

.cbor-summary,
.cbor-page {
  color: var(--text-dim);
}

.cbor-page {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 4px 20px;
}

.cbor-page button {
  min-height: 24px;
  padding: 1px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-muted);
  cursor: pointer;
}

.cbor-page button:disabled {
  opacity: 0.45;
  cursor: default;
}

.cbor-value {
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.type-string {
  color: var(--color-success);
}

.type-number {
  color: var(--accent-orange);
}

.type-boolean {
  color: var(--color-primary);
}

.type-null,
.type-undefined {
  color: var(--text-dim);
}
</style>
