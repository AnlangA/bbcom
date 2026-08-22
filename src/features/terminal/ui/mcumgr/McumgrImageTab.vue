<template>
  <section class="mc-section">
    <article class="mc-card is-primary">
      <header class="mc-card-head">{{ t('mcumgr.group.update') }}</header>
      <p class="mc-card-copy">{{ t('mcumgr.image.updateHint') }}</p>
      <div class="mc-row">
        <n-button size="small" type="primary" :disabled="busy" @click="onFirmwareUpdate">
          <template #icon><Upload class="icon-sm" /></template>
          {{ t('mcumgr.image.update') }}
        </n-button>
        <n-button size="tiny" secondary :disabled="busy" @click="onImageUpload">
          {{ t('mcumgr.image.upload') }}
        </n-button>
        <n-checkbox v-model:checked="upgradeOnlyModel" size="small" :disabled="busy">
          {{ t('mcumgr.image.upgradeOnly') }}
        </n-checkbox>
      </div>
    </article>
    <article class="mc-card">
      <header class="mc-card-head">{{ t('mcumgr.group.inspect') }}</header>
      <div class="mc-actions">
        <n-button
          size="tiny"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('image-state', { kind: 'image-state' })"
        >
          {{ t('mcumgr.image.state') }}
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('slot-info', { kind: 'image-slot-info' })"
        >
          {{ t('mcumgr.image.slotInfo') }}
        </n-button>
        <n-button
          size="tiny"
          type="error"
          secondary
          :disabled="busy"
          @click="
            confirmRun('image-erase', t('mcumgr.confirm.erase'), {
              kind: 'image-erase',
              slot: null,
            })
          "
        >
          {{ t('mcumgr.image.erase') }}
        </n-button>
      </div>
    </article>
    <article class="mc-card">
      <header class="mc-card-head">{{ t('mcumgr.group.boot') }}</header>
      <div class="mc-row">
        <n-input
          v-model:value="imageHashModel"
          size="tiny"
          :placeholder="t('mcumgr.image.hash')"
          :disabled="busy"
          class="mc-grow"
        />
        <n-button size="tiny" secondary :disabled="busy" @click="onImageTest">
          {{ t('mcumgr.image.test') }}
        </n-button>
        <n-button size="tiny" secondary :disabled="busy" @click="onImageConfirm">
          {{ t('mcumgr.image.confirm') }}
        </n-button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import { Upload } from '@lucide/vue';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/format';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrOp } from '@/generated/ipc-contracts';

const props = defineProps<{
  busy: boolean;
  imageHash: string;
  upgradeOnly: boolean;
  mcumgr: SessionMcumgrController;
}>();

const emit = defineEmits<{
  'update:imageHash': [value: string];
  'update:upgradeOnly': [value: boolean];
}>();

const imageHashModel = computed({
  get: () => props.imageHash,
  set: (value: string) => emit('update:imageHash', value),
});

const upgradeOnlyModel = computed({
  get: () => props.upgradeOnly,
  set: (value: boolean) => emit('update:upgradeOnly', value),
});

async function confirmRun(action: string, confirmMessage: string, op: McumgrOp): Promise<void> {
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.execute(action, op);
}

async function onFirmwareUpdate(): Promise<void> {
  const pick = await props.mcumgr.pickFile('firmware');
  if (!pick) return;
  const confirmMessage = t('mcumgr.confirm.update', {
    name: pick.displayName,
    size: formatBytes(pick.sizeBytes),
  });
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.firmwareUpdate(pick.token, { upgradeOnly: upgradeOnlyModel.value });
}

async function onImageUpload(): Promise<void> {
  const pick = await props.mcumgr.pickFile('firmware');
  if (!pick) return;
  const confirmMessage = t('mcumgr.confirm.upload', {
    name: pick.displayName,
    size: formatBytes(pick.sizeBytes),
  });
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.imageUpload(pick.token, upgradeOnlyModel.value);
}

async function onImageTest(): Promise<void> {
  if (!window.confirm(t('mcumgr.confirm.test'))) return;
  await props.mcumgr.runImageTest(imageHashModel.value);
}

async function onImageConfirm(): Promise<void> {
  if (!window.confirm(t('mcumgr.confirm.confirm'))) return;
  await props.mcumgr.runImageConfirm(imageHashModel.value);
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

.mc-card.is-primary {
  border-color: var(--color-primary-muted);
  background:
    linear-gradient(180deg, var(--color-primary-subtle), transparent 42%), var(--bg-secondary);
}

.mc-card-head {
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

.mc-card-copy {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: var(--line-height-normal);
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
