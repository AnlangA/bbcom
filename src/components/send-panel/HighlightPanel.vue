<template>
  <div class="highlight-panel">
    <div v-if="highlights.length > 0" class="highlight-list">
      <div v-for="rule in highlights" :key="rule.id" class="highlight-item">
        <label class="highlight-enable">
          <n-checkbox
            :checked="rule.enabled"
            size="small"
            @update:checked="(value: boolean) => toggleEnabled(rule.id, value)"
          />
        </label>
        <div class="highlight-swatch" :class="`highlight-${rule.color}`"></div>
        <div class="highlight-info" :title="summary(rule)">
          <span class="highlight-name">{{ rule.name }}</span>
          <span class="highlight-detail">
            <span class="tag">{{ rule.direction }}</span>
            <span class="tag">{{ rule.matchMode === 'hex' ? 'HEX' : 'TXT' }}</span>
            <code class="pat">{{ rule.pattern }}</code>
          </span>
        </div>
        <button
          class="highlight-edit"
          type="button"
          :title="t('common.edit')"
          @click="startEdit(rule)"
        >
          <Pencil class="icon-sm" />
        </button>
        <button
          class="highlight-remove"
          type="button"
          :title="t('common.delete')"
          @click="remove(rule.id)"
        >
          <X class="icon-sm" />
        </button>
      </div>
    </div>
    <div v-else-if="!editing" class="highlight-empty">{{ t('highlight.empty') }}</div>

    <div v-if="editing" class="highlight-form">
      <n-input
        v-model:value="draft.name"
        size="tiny"
        :placeholder="t('highlight.namePlaceholder')"
        style="width: 100%"
      />
      <div class="form-row">
        <span class="field-label">{{ t('highlight.match') }}</span>
        <n-button-group size="tiny">
          <n-button
            :type="draft.matchMode === 'text' ? 'primary' : 'default'"
            @click="draft.matchMode = 'text'"
            >TXT</n-button
          >
          <n-button
            :type="draft.matchMode === 'hex' ? 'primary' : 'default'"
            @click="draft.matchMode = 'hex'"
            >HEX</n-button
          >
        </n-button-group>
        <n-input
          v-model:value="draft.pattern"
          size="tiny"
          :placeholder="
            draft.matchMode === 'hex'
              ? t('highlight.patternPlaceholder.hex')
              : t('highlight.patternPlaceholder.text')
          "
          style="flex: 1"
        />
      </div>
      <div class="form-row">
        <span class="field-label">{{ t('highlight.direction') }}</span>
        <n-select
          v-model:value="draft.direction"
          :options="directionOptions"
          size="tiny"
          style="width: 86px"
        />
        <span class="field-label">{{ t('highlight.color') }}</span>
        <n-select
          v-model:value="draft.color"
          :options="colorOptions"
          size="tiny"
          style="width: 112px"
        />
      </div>
      <div class="form-actions">
        <n-button size="tiny" @click="cancelEdit">{{ t('common.cancel') }}</n-button>
        <n-button size="tiny" type="primary" :disabled="!canSave" @click="save">
          {{ editingId ? t('common.update') : t('common.save') }}
        </n-button>
      </div>
    </div>

    <button v-else class="highlight-add" type="button" @click="startCreate">
      <Plus class="icon-sm" />
      {{ t('highlight.new') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowReactive } from 'vue';
import { NButton, NButtonGroup, NCheckbox, NInput, NSelect } from 'naive-ui';
import { Pencil, Plus, X } from 'lucide-vue-next';
import { useSessionStore } from '../../stores/sessions';
import { HIGHLIGHT_COLORS } from '../../lib/highlights';
import { t } from '../../lib/i18n';
import {
  canSaveHighlightDraft,
  createHighlightDraft,
  formatHighlightSummary,
  highlightSavePayload,
  type HighlightDraft,
} from '../../lib/send-rules-editor';
import type { DirectionFilter, HighlightColor, HighlightRule } from '../../types';

const props = defineProps<{
  sessionId: string;
}>();

const sessionStore = useSessionStore();
const highlights = computed(
  () => sessionStore.sessions.find((s) => s.id === props.sessionId)?.highlights ?? [],
);

const editing = ref(false);
const editingId = ref<string | null>(null);
const draft = shallowReactive<HighlightDraft>(createHighlightDraft());

const canSave = computed(() => canSaveHighlightDraft(draft));

const directionOptions = computed<{ label: string; value: DirectionFilter }[]>(() => [
  { label: t('packet.directionAll'), value: 'ALL' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
]);

const colorOptions = computed<{ label: string; value: HighlightColor }[]>(() =>
  HIGHLIGHT_COLORS.map((color) => ({
    label: t(`highlight.color.${color}`),
    value: color,
  })),
);

function startCreate() {
  editingId.value = null;
  Object.assign(draft, createHighlightDraft());
  editing.value = true;
}

function startEdit(rule: HighlightRule) {
  editingId.value = rule.id;
  Object.assign(draft, createHighlightDraft(rule));
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editingId.value = null;
}

function save() {
  const payload = highlightSavePayload(draft);
  if (!payload) return;
  if (editingId.value) {
    sessionStore.updateHighlight(props.sessionId, editingId.value, payload);
  } else {
    sessionStore.addHighlight(props.sessionId, payload);
  }
  editing.value = false;
  editingId.value = null;
}

function toggleEnabled(id: string, enabled: boolean) {
  sessionStore.updateHighlight(props.sessionId, id, { enabled });
}

function remove(id: string) {
  sessionStore.removeHighlight(props.sessionId, id);
}

function summary(rule: HighlightRule): string {
  return formatHighlightSummary(rule);
}
</script>

<style scoped>
.highlight-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.highlight-item,
.highlight-detail,
.form-row,
.form-actions,
.highlight-add {
  display: flex;
  align-items: center;
}

.highlight-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.highlight-item {
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
}

.highlight-enable {
  flex-shrink: 0;
}

.highlight-swatch {
  width: 10px;
  height: 22px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.highlight-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.highlight-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.highlight-detail {
  gap: 4px;
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
}

.tag {
  font-size: 8px;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--bg-inset);
  padding: 0 4px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}

.pat {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.highlight-edit,
.highlight-remove {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.highlight-edit:hover,
.highlight-remove:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.highlight-remove:hover {
  color: var(--accent-red);
}

.highlight-empty {
  margin-bottom: 8px;
  color: var(--text-dim);
  font-size: 11px;
}

.highlight-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  margin-bottom: 8px;
}

.form-row {
  gap: 6px;
}

.field-label {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.form-actions {
  justify-content: flex-end;
  gap: 6px;
}

.highlight-add {
  width: 100%;
  justify-content: center;
  gap: 6px;
  min-height: 26px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    color var(--transition-fast),
    background var(--transition-fast);
}

.highlight-add:hover {
  border-color: var(--accent-amber);
  color: var(--text-secondary);
  background: var(--accent-amber-subtle);
}

.highlight-amber {
  background: var(--accent-amber);
}

.highlight-red {
  background: var(--accent-red);
}

.highlight-blue {
  background: var(--accent-blue);
}

.highlight-green {
  background: var(--accent-green);
}

.highlight-violet {
  background: var(--accent-violet);
}
</style>
