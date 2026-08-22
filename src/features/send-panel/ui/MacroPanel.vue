<template>
  <div class="macro-panel">
    <!-- Saved macros -->
    <div v-if="macros.length > 0" class="macro-list">
      <ActionListItem
        v-for="macro in macros"
        :key="macro.id"
        class="macro-item"
        :class="{ running: runningMacroId === macro.id }"
        :title="macro.name"
        :description="macroSummary(macro)"
        :meta="t('macro.steps', { count: macro.steps.length })"
      >
        <template #actions>
          <IconActionButton
            class="macro-run"
            :label="runningMacroId === macro.id ? t('macro.running') : t('macro.run')"
            :disabled="disabled || (runningMacroId === macro.id && runningMacroId !== null)"
            tone="primary"
            @click="runMacro(macro)"
          >
            <Play v-if="runningMacroId !== macro.id" class="icon-sm" />
            <Square v-else class="icon-sm" />
          </IconActionButton>
          <IconActionButton
            class="macro-edit"
            :disabled="runningMacroId !== null"
            :label="t('common.edit')"
            @click="startEdit(macro)"
          >
            <Pencil class="icon-sm" />
          </IconActionButton>
          <IconActionButton
            class="macro-remove"
            :disabled="runningMacroId !== null"
            :label="
              removeConfirm.armedId.value === macro.id
                ? t('common.confirmDelete')
                : t('common.delete')
            "
            tone="danger"
            @click="removeConfirm.request(macro.id)"
          >
            <X class="icon-sm" />
          </IconActionButton>
        </template>
      </ActionListItem>
    </div>
    <div class="macro-library-actions">
      <button
        class="lib-btn"
        type="button"
        :disabled="macros.length === 0"
        :title="t('macro.exportTitle')"
        @click="exportLibrary"
      >
        <Download class="icon-sm" />
        {{ t('macro.export') }}
      </button>
      <button class="lib-btn" type="button" :title="t('macro.importTitle')" @click="importLibrary">
        <Upload class="icon-sm" />
        {{ t('macro.import') }}
      </button>
      <input
        ref="fileInput"
        type="file"
        accept=".json,application/json"
        class="hidden-file-input"
        :aria-label="t('macro.importTitle')"
        @change="onFilePicked"
      />
    </div>

    <!-- New / edit form -->
    <div v-if="editing" class="macro-form">
      <div class="macro-form-head">
        <n-input
          v-model:value="draft.name"
          size="tiny"
          :placeholder="t('macro.namePlaceholder')"
          :aria-label="t('macro.namePlaceholder')"
          style="width: 140px"
        />
        <n-button size="tiny" quaternary @click="addStep" :title="t('macro.addStep')">
          <template #icon>
            <Plus class="icon-sm" />
          </template>
          {{ t('macro.step') }}
        </n-button>
      </div>
      <div class="step-list">
        <div v-for="(step, i) in draft.steps" :key="stepKeys[i] ?? i" class="step-row">
          <span class="step-idx">{{ i + 1 }}</span>
          <n-checkbox v-model:checked="step.isHex" size="small" :title="t('macro.hexMode')">
            HEX
          </n-checkbox>
          <n-input
            v-model:value="step.data"
            size="tiny"
            :placeholder="step.isHex ? 'AA BB CC' : t('macro.textPlaceholder')"
            :aria-label="`${t('macro.step')} ${i + 1}`"
            style="flex: 1"
          />
          <n-input-number
            v-model:value="step.delayMs"
            size="tiny"
            :min="0"
            :max="3600000"
            :step="100"
            style="width: 104px"
            :title="t('macro.delayTitle')"
            :aria-label="`${t('macro.delayTitle')} ${i + 1}`"
          >
            <template #suffix>ms</template>
          </n-input-number>
          <IconActionButton
            class="step-remove"
            :label="t('macro.deleteStep')"
            tone="danger"
            @click="removeStep(i)"
          >
            <X class="icon-sm" />
          </IconActionButton>
        </div>
        <div v-if="draft.steps.length === 0" class="step-empty">
          {{ t('macro.emptySteps') }}
        </div>
      </div>
      <div class="macro-form-actions">
        <InlineEditorActions
          :can-save="canSave"
          :save-text="editingId ? t('common.update') : t('common.save')"
          @save="save"
          @cancel="cancelEdit"
        />
      </div>
    </div>
    <button v-else class="macro-add" type="button" :disabled="disabled" @click="startCreate">
      <Plus class="icon-sm" />
      {{ t('macro.new') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, shallowReactive, watch } from 'vue';
import { NInput, NButton, NCheckbox, NInputNumber, useMessage } from 'naive-ui';
import { Download, Pencil, Play, Plus, Square, Upload, X } from '@lucide/vue';
import ActionListItem from '@/design-system/ActionListItem.vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import InlineEditorActions from '@/design-system/InlineEditorActions.vue';
import { useSessionDocument } from '@/features/sessions';
import { useConfirmRemove } from '@/features/app-shell/application/use-confirm-remove';
import type { MacroRunResult } from '@/features/sessions/application/use-macro-runner';
import {
  canSaveMacroDraft,
  createMacroDraft,
  createMacroStep,
  formatMacroSummary as macroSummary,
  macroSavePayload,
  type MacroDraft,
} from '@/lib/macro-editor';
import { defaultExportFilename, exportMacros, importMacros } from '@/lib/macro-library';
import { t } from '@/lib/i18n';
import type { Macro } from '@/types';
import type { SessionRuntimeMacroController } from '@/features/sessions/runtime/session-runtime-controller';

const props = defineProps<{
  sessionId: string;
  /** Application-owned runner; panel activation/unmount never owns its task. */
  runner: SessionRuntimeMacroController;
  disabled?: boolean;
}>();

const sessionDocument = useSessionDocument(props.sessionId);
const message = useMessage();

const macros = computed(() => sessionDocument.session.value?.macros ?? []);

// --- runner ---
const runner = props.runner;
const runningMacroId = ref<string | null>(runner.running.value ? 'background' : null);
// The runner is application-owned: a run started outside this panel (ToolsTabs
// is KeepAlive-cached, the runner lives on the session runtime) can finish or
// be aborted while the panel is mounted. Without this sync the stale
// 'background' marker would keep edit/remove disabled and block new runs
// until the SessionView itself is destroyed.
watch(
  () => runner.running.value,
  (running) => {
    if (!running) runningMacroId.value = null;
  },
);

async function runMacro(macro: Macro) {
  if (
    runner.running.value &&
    (runningMacroId.value === null || runningMacroId.value === 'background')
  ) {
    runner.abort();
    return;
  }
  if (runningMacroId.value !== null) {
    if (runningMacroId.value === macro.id) {
      runner.abort(); // same macro -> stop
    }
    return;
  }
  if (props.disabled || macro.steps.length === 0) return;
  runningMacroId.value = macro.id;
  const res: MacroRunResult = await runner.run(macro);
  runningMacroId.value = null;
  if (res.aborted) {
    message.info(
      t('macro.aborted', {
        name: macro.name,
        completed: res.completed,
        total: macro.steps.length,
      }),
    );
  } else if (res.failedAt < macro.steps.length) {
    message.warning(t('macro.failed', { name: macro.name, step: res.failedAt + 1 }));
  } else {
    message.success(t('macro.completed', { name: macro.name, count: macro.steps.length }));
  }
}

const editing = ref(false);
const editingId = ref<string | null>(null);
const draft = shallowReactive<MacroDraft>({ name: '', steps: [] });

// MacroStep is the persisted shape and has no id; these panel-local keys keep
// v-for rows stable across splices so a removed step cannot shuffle DOM state
// into its neighbors. Every draft.steps mutation goes through this panel.
let stepKeySeed = 0;
const stepKeys = ref<number[]>([]);

function resetStepKeys(count: number): void {
  stepKeys.value = Array.from({ length: count }, () => (stepKeySeed += 1));
}

const canSave = computed(() => canSaveMacroDraft(draft));

function startCreate() {
  const nextDraft = createMacroDraft();
  editingId.value = null;
  draft.name = nextDraft.name;
  draft.steps = nextDraft.steps;
  resetStepKeys(nextDraft.steps.length);
  editing.value = true;
}

function startEdit(macro: Macro) {
  const nextDraft = createMacroDraft(macro);
  editingId.value = macro.id;
  draft.name = nextDraft.name;
  draft.steps = nextDraft.steps;
  resetStepKeys(nextDraft.steps.length);
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editingId.value = null;
}

function addStep() {
  draft.steps.push(createMacroStep());
  stepKeys.value.push((stepKeySeed += 1));
}

function removeStep(index: number) {
  draft.steps.splice(index, 1);
  stepKeys.value.splice(index, 1);
}

function save() {
  const payload = macroSavePayload(draft);
  if (!payload) return;
  if (editingId.value) {
    sessionDocument.updateMacro(props.sessionId, editingId.value, payload);
    message.success(t('macro.updated'));
  } else {
    sessionDocument.addMacro(props.sessionId, payload);
    message.success(t('macro.saved'));
  }
  editing.value = false;
  editingId.value = null;
}

const removeConfirm = useConfirmRemove((id) => {
  sessionDocument.removeMacro(props.sessionId, id);
});

// --- cross-session library import/export ---
// Uses the File System Access API (available in Tauri's Chromium webview) with a
// <input type=file> fallback for import and a Blob download for export, so no
// extra Tauri fs plugin dependency is required.
const fileInput = ref<HTMLInputElement | null>(null);

async function exportLibrary() {
  const list = macros.value;
  if (list.length === 0) return;
  const json = exportMacros(list);
  const filename = defaultExportFilename();
  try {
    // Preferred: native save dialog via the File System Access API.
    const w = window as unknown as {
      showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: Array<{ accept: Record<string, string[]> }>;
      }) => Promise<{ createWritable: () => Promise<WritableStreamDefaultWriter> }>;
    };
    if (typeof w.showSaveFilePicker === 'function') {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      message.success(t('macro.exported', { count: list.length }));
      return;
    }
  } catch (e) {
    // User cancelled (AbortError) or the API threw — fall through to download.
    if (e instanceof DOMException && e.name === 'AbortError') return;
  }
  // Fallback: trigger a browser download of the JSON blob.
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  message.success(t('macro.exported', { count: list.length }));
}

function importLibrary() {
  fileInput.value?.click();
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // reset so picking the same file again re-fires change
  if (!file) return;
  try {
    const text = await file.text();
    const imported = importMacros(text);
    let added = 0;
    for (const m of imported) {
      sessionDocument.addMacro(props.sessionId, { name: m.name, steps: m.steps });
      added += 1;
    }
    message.success(t('macro.imported', { count: added }));
  } catch (e) {
    message.error(t('macro.importFailed', { error: e instanceof Error ? e.message : String(e) }));
  }
}
</script>

<style scoped>
.macro-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.macro-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.macro-item {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
  overflow: hidden;
  transition: border-color var(--transition-fast);
}

.macro-item.running {
  border-color: var(--accent-amber);
  box-shadow: 0 0 0 2px var(--accent-amber-subtle);
}

.macro-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: var(--font-size-sm);
}

.macro-name {
  flex: 1;
  color: var(--text-secondary);
  cursor: default;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.macro-name:hover {
  color: var(--text-primary);
}

.macro-meta {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.macro-run,
.macro-edit,
.macro-remove {
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

.macro-run:hover {
  color: var(--color-success);
  background: var(--bg-hover);
}

.macro-run:disabled,
.macro-edit:disabled,
.macro-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.macro-edit:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.macro-remove:hover {
  color: var(--accent-red);
  background: var(--bg-hover);
}

.macro-library-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.lib-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.lib-btn:hover:not(:disabled) {
  color: var(--text-secondary);
  border-color: var(--color-primary-muted);
}

.lib-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.hidden-file-input {
  display: none;
}

.macro-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}

.macro-form-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.step-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.step-idx {
  width: 16px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--text-dim);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.step-remove {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.step-remove:hover {
  color: var(--accent-red);
  background: var(--bg-hover);
}

.step-empty {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  padding: 6px 4px;
  text-align: center;
}

.macro-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.macro-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: 5px 10px;
  width: 100%;
  justify-content: center;
  transition:
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.macro-add:hover:not(:disabled) {
  border-color: var(--color-primary-muted);
  color: var(--text-secondary);
}

.macro-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
