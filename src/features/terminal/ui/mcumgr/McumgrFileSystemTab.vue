<template>
  <section class="mc-section">
    <article class="mc-card">
      <header class="mc-card-head">{{ t('mcumgr.fs.path') }}</header>
      <div class="mc-row">
        <n-input
          v-model:value="fsPathModel"
          size="tiny"
          class="mc-grow"
          :placeholder="t('mcumgr.fs.path')"
          :disabled="busy"
        />
      </div>
      <div class="mc-actions">
        <n-button
          size="tiny"
          secondary
          :disabled="busy || !fsPathModel.trim()"
          @click="mcumgr.execute('fs-status', { kind: 'fs-status', path: fsPathModel.trim() })"
        >
          {{ t('mcumgr.fs.status') }}
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="busy || !fsPathModel.trim()"
          @click="mcumgr.execute('fs-hash', { kind: 'fs-hash', path: fsPathModel.trim() })"
        >
          {{ t('mcumgr.fs.hash') }}
        </n-button>
        <n-button size="tiny" secondary :disabled="busy || !fsPathModel.trim()" @click="onDownload">
          <template #icon><Download class="icon-sm" /></template>
          {{ t('mcumgr.fs.download') }}
        </n-button>
        <n-button size="tiny" secondary :disabled="busy || !fsPathModel.trim()" @click="onUpload">
          <template #icon><Upload class="icon-sm" /></template>
          {{ t('mcumgr.fs.upload') }}
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :disabled="busy"
          @click="mcumgr.execute('fs-close', { kind: 'fs-close' })"
        >
          {{ t('mcumgr.fs.close') }}
        </n-button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { Download, Upload } from '@lucide/vue';
import { t } from '@/lib/i18n';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';

const props = defineProps<{
  busy: boolean;
  fsPath: string;
  mcumgr: SessionMcumgrController;
}>();

const emit = defineEmits<{
  'update:fsPath': [value: string];
}>();

const fsPathModel = computed({
  get: () => props.fsPath,
  set: (value: string) => emit('update:fsPath', value),
});

async function onUpload(): Promise<void> {
  await props.mcumgr.pickAndFsUpload(fsPathModel.value);
}

async function onDownload(): Promise<void> {
  await props.mcumgr.pickAndFsDownload(fsPathModel.value);
}
</script>

<style scoped>
.mc-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mc-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, var(--surface-lift), transparent), var(--bg-secondary);
  box-shadow: var(--shadow-sm);
}

.mc-card-head {
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

.mc-row,
.mc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mc-grow {
  flex: 1;
  min-width: 140px;
}
</style>
