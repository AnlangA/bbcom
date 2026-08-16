<!--
  Parser frame detail panel: hex/ascii dump of the selected parsed frame, plus
  the empty state. Extracted from ParserPanel. Receives the selected
  frame (or null) and the pre-computed dump rows; emits copy / copy-ascii.
-->
<template>
  <div v-if="frame" class="pp-detail scrollbar-thin">
    <div class="detail-head">
      <span class="detail-title">{{ t('parser.detail') }}</span>
      <span class="detail-meta">
        {{ t('parser.detail.offset') }} {{ frame.offset }} ·
        {{ t('parser.detail.bytes', { count: frame.data.length }) }}
      </span>
      <button class="detail-copy" type="button" :title="t('parser.copy')" @click="$emit('copy')">
        <Copy class="icon-sm" />
      </button>
      <button
        class="detail-copy"
        type="button"
        :title="t('parser.detail.copyAscii')"
        @click="$emit('copy-ascii')"
      >
        <FileText class="icon-sm" />
      </button>
    </div>
    <div v-for="row in dump" :key="row.offset" class="detail-row">
      <span class="dump-offset">{{ row.offset.toString(16).padStart(4, '0') }}</span>
      <span class="dump-hex">{{ row.hex }}</span>
      <span class="dump-ascii">{{ row.ascii }}</span>
    </div>
  </div>
  <div v-else class="pp-detail pp-detail-empty">
    <Binary class="icon-lg detail-icon" />
    <span>{{ t('parser.detail') }}</span>
  </div>
</template>

<script setup lang="ts">
import { Copy, FileText, Binary } from '@lucide/vue';
import { t } from '../../lib/i18n';

export interface ParserDetailRow {
  offset: number;
  hex: string;
  ascii: string;
}

defineProps<{
  frame: { data: Uint8Array; offset: number } | null;
  dump: ParserDetailRow[];
}>();

defineEmits<{
  copy: [];
  'copy-ascii': [];
}>();
</script>

<style scoped>
.pp-detail {
  width: 340px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 6px 8px;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pp-detail-empty {
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-align: center;
}

.detail-icon {
  width: 32px;
  height: 32px;
  color: var(--text-dim);
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.detail-title {
  font-weight: 700;
  color: var(--text-secondary);
}

.detail-meta {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  text-transform: none;
  letter-spacing: 0;
}

.detail-copy {
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

.detail-copy:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.detail-row {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 18px;
  align-items: baseline;
}

.dump-offset {
  color: var(--text-dim);
}

.dump-hex {
  color: var(--accent-blue);
  letter-spacing: 0.5px;
  white-space: pre;
  overflow-x: auto;
}

.dump-ascii {
  color: var(--text-secondary);
  white-space: pre;
}

@media (max-width: 720px) {
  .pp-detail {
    display: none;
  }
}
</style>
