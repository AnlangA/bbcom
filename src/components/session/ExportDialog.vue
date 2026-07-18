<template>
  <n-modal
    :show="show"
    preset="card"
    class="export-dialog"
    :title="t('export.dialog.title')"
    :mask-closable="!isExporting"
    :closable="!isExporting"
    @close="emit('cancel')"
  >
    <div class="export-form">
      <label class="export-field">
        <span>{{ t('export.dialog.format') }}</span>
        <AppSelect v-model:value="format" :options="formatOptions" :disabled="isExporting" />
      </label>
      <label class="export-field">
        <span>{{ t('export.dialog.direction') }}</span>
        <AppSelect v-model:value="direction" :options="directionOptions" :disabled="isExporting" />
      </label>
      <label class="export-field">
        <span>{{ t('export.dialog.range') }}</span>
        <AppSelect
          v-model:value="timePreset"
          :options="timePresetOptions"
          :disabled="isExporting"
        />
      </label>
      <div v-if="timePreset === 'custom'" class="custom-range">
        <input
          v-model="customStartInput"
          class="datetime-input"
          type="datetime-local"
          step="0.001"
          :placeholder="t('export.dialog.start')"
          :aria-label="t('export.dialog.start')"
          :disabled="isExporting"
        />
        <span aria-hidden="true">→</span>
        <input
          v-model="customEndInput"
          class="datetime-input"
          type="datetime-local"
          step="0.001"
          :placeholder="t('export.dialog.end')"
          :aria-label="t('export.dialog.end')"
          :disabled="isExporting"
        />
      </div>

      <div class="export-preview" aria-live="polite">
        <span>{{ t('export.dialog.previewFrames', { count: preview.frameCount }) }}</span>
        <span>{{ t('export.dialog.previewBytes', { bytes: formatBytes(preview.rawBytes) }) }}</span>
      </div>
      <p v-if="validationMessage" class="validation-message">{{ validationMessage }}</p>

      <div v-if="isExporting || progress.phase === 'completed'" class="export-progress">
        <n-progress
          type="line"
          :percentage="progressPercentage"
          :status="progress.phase === 'completed' ? 'success' : 'default'"
          :processing="isExporting"
        />
        <span>
          {{
            t('export.dialog.progress', {
              completed: progress.completedFrames,
              total: progress.totalFrames,
            })
          }}
        </span>
        <span v-if="progress.phase === 'completed'">
          {{
            t('export.dialog.completed', {
              bytes: formatBytes(progress.outputBytes),
              duration: progress.durationMs,
            })
          }}
        </span>
      </div>
    </div>

    <template #footer>
      <div class="dialog-actions">
        <n-button :disabled="isExporting && progress.phase === 'finishing'" @click="emit('cancel')">
          {{ isExporting ? t('export.dialog.cancelExport') : t('common.cancel') }}
        </n-button>
        <n-button type="primary" :disabled="!canConfirm" :loading="isExporting" @click="confirm">
          {{ t('export.dialog.confirm') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NModal, NProgress } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import {
  createExportFrameSnapshot,
  createExportPreview,
  isValidCustomTimeRange,
  type ExportDirectionFilter,
  type ExportFrameSnapshot,
  type ExportTimePreset,
} from '../../lib/export-filters';
import {
  EXPORT_FRAME_MAX_BYTES,
  EXPORT_MAX_BYTES,
  EXPORT_MAX_FRAMES,
  type ExportProgress,
} from '../../composables/useExport';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { ExportChoice } from '../../lib/constants';
import type { DataFrame } from '../../types';

const props = defineProps<{
  show: boolean;
  frames: readonly DataFrame[];
  isExporting: boolean;
  progress: ExportProgress;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [{ snapshot: ExportFrameSnapshot; choice: ExportChoice }];
}>();

const format = ref<ExportChoice>('txt');
const direction = ref<ExportDirectionFilter>('all');
const timePreset = ref<ExportTimePreset>('all');
const customStartMs = ref<number | null>(null);
const customEndMs = ref<number | null>(null);

/**
 * Native datetime inputs keep the date picker out of the renderer bundle.
 * `datetime-local` deliberately represents local wall time, matching the
 * desktop picker it replaces.  Keep millisecond precision so the selected
 * half-open [startMs, endMs) export range remains exact.
 */
function formatDateTimeLocal(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function parseDateTimeLocal(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

const customStartInput = computed({
  get: () => formatDateTimeLocal(customStartMs.value),
  set: (value: string) => {
    customStartMs.value = parseDateTimeLocal(value);
  },
});
const customEndInput = computed({
  get: () => formatDateTimeLocal(customEndMs.value),
  set: (value: string) => {
    customEndMs.value = parseDateTimeLocal(value);
  },
});

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    direction.value = 'all';
    timePreset.value = 'all';
    customStartMs.value = null;
    customEndMs.value = null;
  },
);

const formatOptions = computed(() => [
  { label: t('export.txt'), value: 'txt' },
  { label: t('export.csv'), value: 'csv' },
  { label: t('export.jsonl'), value: 'jsonl' },
  { label: t('export.bin'), value: 'bin' },
]);
const directionOptions = computed(() => [
  { label: t('export.dialog.all'), value: 'all' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
]);
const timePresetOptions = computed(() => [
  { label: t('export.dialog.all'), value: 'all' },
  { label: t('export.dialog.last1m'), value: 'last-1m' },
  { label: t('export.dialog.last5m'), value: 'last-5m' },
  { label: t('export.dialog.custom'), value: 'custom' },
]);

const customRangeValid = computed(
  () =>
    timePreset.value !== 'custom' || isValidCustomTimeRange(customStartMs.value, customEndMs.value),
);

function currentSelection() {
  return {
    direction: direction.value,
    timePreset: timePreset.value,
    customStartMs: customStartMs.value,
    customEndMs: customEndMs.value,
  };
}

const preview = computed(() => {
  if (!customRangeValid.value) return { frameCount: 0, rawBytes: 0, maxFrameBytes: 0 };
  return createExportPreview(props.frames, currentSelection());
});

const validationMessage = computed(() => {
  if (!customRangeValid.value) return t('export.dialog.invalidRange');
  if (preview.value.frameCount === 0) return t('export.dialog.empty');
  if (preview.value.frameCount > EXPORT_MAX_FRAMES) {
    return t('export.dialog.tooManyFrames', { max: EXPORT_MAX_FRAMES });
  }
  if (preview.value.rawBytes > EXPORT_MAX_BYTES) {
    return t('export.dialog.tooManyBytes', { max: formatBytes(EXPORT_MAX_BYTES) });
  }
  if (preview.value.maxFrameBytes > EXPORT_FRAME_MAX_BYTES) {
    return t('export.dialog.frameTooLarge', { max: formatBytes(EXPORT_FRAME_MAX_BYTES) });
  }
  return '';
});
const canConfirm = computed(() => !props.isExporting && validationMessage.value === '');
const progressPercentage = computed(() =>
  props.progress.totalFrames > 0
    ? Math.min(100, Math.round((props.progress.completedFrames / props.progress.totalFrames) * 100))
    : 0,
);

function confirm(): void {
  if (!canConfirm.value) return;
  emit('confirm', {
    snapshot: createExportFrameSnapshot(props.frames, currentSelection()),
    choice: format.value,
  });
}
</script>

<style scoped>
.export-form {
  display: grid;
  gap: 14px;
}

.export-field {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.custom-range {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}

.datetime-input {
  box-sizing: border-box;
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  color: var(--text-primary);
  background: var(--bg-inset);
  font: inherit;
  transition:
    border-color var(--transition-normal),
    box-shadow var(--transition-normal);
}

.datetime-input:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.datetime-input:focus-visible {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--shadow-focus);
}

.datetime-input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.export-preview,
.export-progress {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  color: var(--text-muted);
  font-size: 12px;
}

.export-progress {
  display: grid;
}

.validation-message {
  margin: 0;
  color: var(--accent-red);
  font-size: 12px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 600px) {
  .export-field,
  .custom-range {
    grid-template-columns: 1fr;
  }
}
</style>
