<template>
  <div class="trigger-panel">
    <!-- Saved triggers -->
    <div v-if="triggers.length > 0" class="trigger-list">
      <div v-for="trigger in triggers" :key="trigger.id" class="trigger-item">
        <label class="trigger-enable">
          <n-checkbox
            :checked="trigger.enabled"
            size="small"
            @update:checked="(v: boolean) => toggleEnabled(trigger.id, v)"
          />
        </label>
        <div class="trigger-info" :title="summary(trigger)">
          <span class="trigger-name">{{ trigger.name }}</span>
          <span class="trigger-detail">
            <span class="tag">{{ trigger.matchMode === 'hex' ? 'HEX' : 'TXT' }}</span>
            <code class="pat">{{ trigger.pattern || '—' }}</code>
            <ArrowRight class="arrow" />
            <span class="tag">{{ trigger.responseIsHex ? 'HEX' : 'TXT' }}</span>
            <code class="pat">{{ trigger.response || '—' }}</code>
          </span>
        </div>
        <button
          class="trigger-edit"
          type="button"
          :title="t('common.edit')"
          @click="startEdit(trigger)"
        >
          <Pencil class="icon-sm" />
        </button>
        <button
          class="trigger-remove"
          type="button"
          :title="t('common.delete')"
          @click="remove(trigger.id)"
        >
          <X class="icon-sm" />
        </button>
      </div>
    </div>

    <!-- New / edit form -->
    <div v-if="editing" class="trigger-form">
      <n-input
        v-model:value="draft.name"
        size="tiny"
        :placeholder="t('trigger.namePlaceholder')"
        style="width: 100%"
      />
      <div class="form-row">
        <span class="field-label">{{ t('trigger.match') }}</span>
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
          :placeholder="draft.matchMode === 'hex' ? 'AA BB' : 'login:'"
          style="flex: 1"
        />
      </div>
      <div class="form-row">
        <span class="field-label">{{ t('trigger.response') }}</span>
        <n-checkbox v-model:checked="draft.responseIsHex" size="small">HEX</n-checkbox>
        <n-input
          v-model:value="draft.response"
          size="tiny"
          :placeholder="draft.responseIsHex ? 'CC DD' : 'root\\r\\n'"
          style="flex: 1"
        />
      </div>
      <div class="form-row">
        <span class="field-label">{{ t('trigger.cooldown') }}</span>
        <n-input-number
          v-model:value="draft.cooldownMs"
          size="tiny"
          :min="0"
          :max="60000"
          :step="100"
          style="width: 130px"
        >
          <template #suffix>ms</template>
        </n-input-number>
        <span class="field-hint">{{ t('trigger.cooldownHint') }}</span>
      </div>
      <div class="form-actions">
        <n-button size="tiny" @click="cancelEdit">{{ t('common.cancel') }}</n-button>
        <n-button size="tiny" type="primary" :disabled="!canSave" @click="save">
          {{ editingId ? t('common.update') : t('common.save') }}
        </n-button>
      </div>
    </div>
    <button v-else class="trigger-add" type="button" @click="startCreate">
      <Plus class="icon-sm" />
      {{ t('trigger.new') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowReactive } from 'vue';
import { NInput, NButton, NButtonGroup, NCheckbox, NInputNumber } from 'naive-ui';
import { ArrowRight, Pencil, Plus, X } from 'lucide-vue-next';
import { useSessionStore } from '../../stores/sessions';
import { t } from '../../lib/i18n';
import type { Trigger, TriggerMatchMode } from '../../types';

const props = defineProps<{
  sessionId: string;
}>();

const sessionStore = useSessionStore();

const triggers = computed(
  () => sessionStore.sessions.find((s) => s.id === props.sessionId)?.triggers ?? [],
);

// --- draft / edit ---
interface Draft {
  name: string;
  matchMode: TriggerMatchMode;
  pattern: string;
  response: string;
  responseIsHex: boolean;
  cooldownMs: number;
}
const editing = ref(false);
const editingId = ref<string | null>(null);
const draft = shallowReactive<Draft>({
  name: '',
  matchMode: 'text',
  pattern: '',
  response: '',
  responseIsHex: false,
  cooldownMs: 500,
});

const canSave = computed(
  () =>
    draft.name.trim().length > 0 &&
    draft.pattern.trim().length > 0 &&
    draft.response.trim().length > 0,
);

function startCreate() {
  editingId.value = null;
  Object.assign(draft, {
    name: '',
    matchMode: 'text',
    pattern: '',
    response: '',
    responseIsHex: false,
    cooldownMs: 500,
  });
  editing.value = true;
}

function startEdit(t: Trigger) {
  editingId.value = t.id;
  Object.assign(draft, {
    name: t.name,
    matchMode: t.matchMode,
    pattern: t.pattern,
    response: t.response,
    responseIsHex: t.responseIsHex,
    cooldownMs: t.cooldownMs,
  });
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editingId.value = null;
}

function save() {
  if (!canSave.value) return;
  const payload = {
    name: draft.name.trim(),
    enabled: true,
    matchMode: draft.matchMode,
    pattern: draft.pattern.trim(),
    response: draft.response,
    responseIsHex: draft.responseIsHex,
    cooldownMs: Math.max(0, Math.floor(draft.cooldownMs || 0)),
  };
  if (editingId.value) {
    sessionStore.updateTrigger(props.sessionId, editingId.value, payload);
  } else {
    sessionStore.addTrigger(props.sessionId, payload);
  }
  editing.value = false;
  editingId.value = null;
}

function toggleEnabled(id: string, enabled: boolean) {
  sessionStore.updateTrigger(props.sessionId, id, { enabled });
}

function remove(id: string) {
  sessionStore.removeTrigger(props.sessionId, id);
}

function summary(t: Trigger): string {
  return `${t.matchMode === 'hex' ? 'HEX' : 'TXT'} "${t.pattern}" → ${
    t.responseIsHex ? 'HEX' : 'TXT'
  } "${t.response}"${t.cooldownMs ? ` (${triggerCooldownSummary(t.cooldownMs)})` : ''}`;
}

function triggerCooldownSummary(ms: number): string {
  return t('trigger.summaryCooldown', { ms });
}
</script>

<style scoped>
.trigger-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trigger-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.trigger-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
}

.trigger-enable {
  flex-shrink: 0;
}

.trigger-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.trigger-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-detail {
  display: flex;
  align-items: center;
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

.arrow {
  width: 10px;
  height: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.trigger-edit,
.trigger-remove {
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
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.trigger-edit:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.trigger-remove:hover {
  color: var(--accent-red);
  background: var(--bg-hover);
}

.trigger-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}

.form-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-label {
  font-size: 10px;
  color: var(--text-muted);
  width: 32px;
  flex-shrink: 0;
  text-transform: uppercase;
  font-weight: 600;
}

.field-hint {
  font-size: 9px;
  color: var(--text-dim);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.trigger-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 5px 10px;
  width: 100%;
  justify-content: center;
  transition:
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.trigger-add:hover {
  border-color: var(--color-primary-muted);
  color: var(--text-secondary);
}
</style>
