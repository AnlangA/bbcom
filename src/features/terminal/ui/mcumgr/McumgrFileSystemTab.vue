<template>
  <section class="mc-section">
    <McumgrActionCard :title="t('mcumgr.fs.targetTitle')" :description="t('mcumgr.fs.targetHint')">
      <label class="mc-field">
        <span class="mc-field-label">{{ t('mcumgr.fs.path') }}</span>
        <n-input
          v-model:value="fsPathModel"
          size="small"
          class="mc-path-input"
          :input-props="{ 'aria-label': t('mcumgr.fs.path') }"
          :placeholder="t('mcumgr.fs.path')"
          :disabled="busy"
        />
      </label>
      <template #actions>
        <n-button
          size="small"
          secondary
          :disabled="busy || !fsPathModel.trim()"
          @click="mcumgr.execute('fs-status', { kind: 'fs-status', path: fsPathModel.trim() })"
        >
          {{ t('mcumgr.fs.status') }}
        </n-button>
        <n-button
          size="small"
          secondary
          :disabled="busy || !fsPathModel.trim()"
          @click="mcumgr.execute('fs-hash', { kind: 'fs-hash', path: fsPathModel.trim() })"
        >
          {{ t('mcumgr.fs.hash') }}
        </n-button>
        <n-button
          size="small"
          quaternary
          class="mc-close-action"
          :disabled="busy"
          @click="mcumgr.execute('fs-close', { kind: 'fs-close' })"
        >
          {{ t('mcumgr.fs.close') }}
        </n-button>
      </template>
    </McumgrActionCard>
    <McumgrActionCard
      :title="t('mcumgr.fs.transferTitle')"
      :description="t('mcumgr.fs.transferHint')"
      tone="accent"
    >
      <template #actions>
        <n-button
          size="small"
          secondary
          :disabled="busy || !fsPathModel.trim()"
          @click="onDownload"
        >
          <template #icon><Download class="icon-sm" /></template>
          {{ t('mcumgr.fs.download') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="busy || !fsPathModel.trim()"
          @click="onUpload"
        >
          <template #icon><Upload class="icon-sm" /></template>
          {{ t('mcumgr.fs.upload') }}
        </n-button>
      </template>
    </McumgrActionCard>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { Download, Upload } from '@lucide/vue';
import { t } from '@/lib/i18n';
import McumgrActionCard from './McumgrActionCard.vue';
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
  gap: var(--space-md);
  min-width: 0;
}

.mc-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-width: 0;
}

.mc-field-label {
  color: var(--text-secondary);
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-normal);
}

.mc-path-input :deep(.n-input__input-el) {
  font-family: var(--font-mono);
  font-size: var(--font-size-data);
}

.mc-close-action {
  margin-inline-start: auto;
}
</style>
