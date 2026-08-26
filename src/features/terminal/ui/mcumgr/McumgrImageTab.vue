<template>
  <section class="mc-section">
    <article class="mc-card mc-action-tile">
      <header class="mc-card-head">
        <span class="mc-card-head-label">{{ t('mcumgr.image.update') }}</span>
        <McumgrHoverTip :text="t('mcumgr.image.updateHint')">
          <span class="mc-help" role="img" :aria-label="t('mcumgr.image.updateHint')">
            <CircleQuestionMark class="icon-sm" />
          </span>
        </McumgrHoverTip>
      </header>
      <p class="mc-action-caption">{{ t('mcumgr.image.updateCaption') }}</p>
      <McumgrHoverTip :text="t('mcumgr.image.updateHint')" block>
        <n-button size="small" type="primary" block :disabled="busy" @click="onFirmwareUpdate">
          <template #icon><Upload class="icon-sm" /></template>
          {{ t('mcumgr.image.update') }}
        </n-button>
      </McumgrHoverTip>
    </article>

    <article class="mc-card mc-action-tile">
      <header class="mc-card-head">
        <span class="mc-card-head-label">{{ t('mcumgr.image.upload') }}</span>
        <McumgrHoverTip :text="t('mcumgr.image.uploadHint')">
          <span class="mc-help" role="img" :aria-label="t('mcumgr.image.uploadHint')">
            <CircleQuestionMark class="icon-sm" />
          </span>
        </McumgrHoverTip>
      </header>
      <p class="mc-action-caption">{{ t('mcumgr.image.uploadCaption') }}</p>
      <McumgrHoverTip :text="t('mcumgr.image.uploadHint')" block>
        <n-button size="small" type="primary" block :disabled="busy" @click="onImageUpload">
          <template #icon><FileUp class="icon-sm" /></template>
          {{ t('mcumgr.image.upload') }}
        </n-button>
      </McumgrHoverTip>
    </article>

    <div class="mc-span mc-upgrade-row">
      <McumgrHoverTip :text="t('mcumgr.image.upgradeOnlyHint')">
        <n-checkbox v-model:checked="upgradeOnlyModel" size="small" :disabled="busy">
          {{ t('mcumgr.image.upgradeOnly') }}
        </n-checkbox>
      </McumgrHoverTip>
    </div>

    <article class="mc-card">
      <header class="mc-card-head">
        <span class="mc-card-head-label">{{ t('mcumgr.group.inspect') }}</span>
        <McumgrHoverTip :text="t('mcumgr.group.inspectHint')">
          <span class="mc-help" role="img" :aria-label="t('mcumgr.group.inspectHint')">
            <CircleQuestionMark class="icon-sm" />
          </span>
        </McumgrHoverTip>
      </header>
      <div class="mc-actions">
        <McumgrHoverTip :text="t('mcumgr.image.stateHint')">
          <n-button
            size="tiny"
            secondary
            :disabled="busy"
            @click="mcumgr.execute('image-state', { kind: 'image-state' })"
          >
            {{ t('mcumgr.image.state') }}
          </n-button>
        </McumgrHoverTip>
        <McumgrHoverTip :text="t('mcumgr.image.slotInfoHint')">
          <n-button
            size="tiny"
            secondary
            :disabled="busy"
            @click="mcumgr.execute('slot-info', { kind: 'image-slot-info' })"
          >
            {{ t('mcumgr.image.slotInfo') }}
          </n-button>
        </McumgrHoverTip>
      </div>
      <div class="mc-actions mc-actions-danger">
        <McumgrHoverTip :text="t('mcumgr.image.eraseHint')">
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
            <template #icon><Eraser class="icon-sm" /></template>
            {{ t('mcumgr.image.erase') }}
          </n-button>
        </McumgrHoverTip>
      </div>
    </article>

    <article class="mc-card">
      <header class="mc-card-head">
        <span class="mc-card-head-label">{{ t('mcumgr.group.boot') }}</span>
        <McumgrHoverTip :text="t('mcumgr.group.bootHint')">
          <span class="mc-help" role="img" :aria-label="t('mcumgr.group.bootHint')">
            <CircleQuestionMark class="icon-sm" />
          </span>
        </McumgrHoverTip>
      </header>
      <label class="mc-field">
        <span class="mc-field-label">{{ t('mcumgr.image.hash') }}</span>
        <McumgrHoverTip :text="t('mcumgr.image.hashHint')" block>
          <n-input
            v-model:value="imageHashModel"
            size="tiny"
            :placeholder="t('mcumgr.image.hashPlaceholder')"
            :disabled="busy"
            :input-props="{ spellcheck: false, autocomplete: 'off' }"
            class="mc-hash-input"
          />
        </McumgrHoverTip>
      </label>
      <div class="mc-actions">
        <McumgrHoverTip :text="t('mcumgr.image.testHint')">
          <n-button size="tiny" secondary :disabled="busy || !hasHash" @click="onImageTest">
            {{ t('mcumgr.image.test') }}
          </n-button>
        </McumgrHoverTip>
        <McumgrHoverTip :text="t('mcumgr.image.confirmHint')">
          <n-button size="tiny" secondary :disabled="busy" @click="onImageConfirm">
            {{ t('mcumgr.image.confirm') }}
          </n-button>
        </McumgrHoverTip>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import { CircleQuestionMark, Eraser, FileUp, Upload } from '@lucide/vue';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/format';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrOp } from '@/generated/ipc-contracts';
import McumgrHoverTip from './McumgrHoverTip.vue';

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

const hasHash = computed(() => imageHashModel.value.trim().length > 0);

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
  await props.mcumgr.firmwareUpdate(pick.token, {
    upgradeOnly: upgradeOnlyModel.value,
    forceConfirm: true,
  });
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
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: var(--space-md);
  align-items: stretch;
}

.mc-span {
  grid-column: 1 / -1;
}

.mc-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, var(--surface-lift), transparent), var(--bg-secondary);
  box-shadow: var(--shadow-sm);
}

.mc-action-tile {
  min-width: 0;
}

.mc-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.mc-card-head-label {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

.mc-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  color: var(--text-dim);
  cursor: help;
  border-radius: var(--radius-full);
}

.mc-help:hover {
  color: var(--text-secondary);
}

.mc-action-caption {
  margin: 0;
  min-height: calc(var(--line-height-normal) * 2em);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: var(--line-height-normal);
}

.mc-upgrade-row {
  display: flex;
  align-items: center;
}

.mc-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.mc-actions-danger {
  margin-top: auto;
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-subtle);
}

.mc-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  min-width: 0;
}

.mc-field-label {
  font-size: var(--font-size-2xs);
  color: var(--text-dim);
  font-weight: 600;
}

.mc-hash-input {
  width: 100%;
}

.mc-hash-input :deep(.n-input__input-el) {
  font-family: var(--font-mono);
}

.mc-action-tile :deep(.n-tooltip) {
  display: block;
  width: 100%;
}

.mc-action-tile :deep(.n-button) {
  width: 100%;
  justify-content: center;
}
</style>
