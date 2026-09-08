<template>
  <section class="mc-image-workspace">
    <div class="transfer-section">
      <header class="section-heading">
        <h4>{{ t('mcumgr.group.transfer') }}</h4>
        <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.upgradeOnlyHint')">
          <n-checkbox v-model:checked="upgradeOnlyModel" size="small" :disabled="busy">{{
            t('mcumgr.image.upgradeOnly')
          }}</n-checkbox>
        </McumgrHoverTip>
      </header>
      <div class="transfer-grid">
        <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.updateHint')" block>
          <button
            type="button"
            class="transfer-action is-primary"
            :aria-label="t('mcumgr.image.update')"
            :disabled="busy"
            @click="onFirmwareUpdate"
          >
            <span class="transfer-icon"
              ><Upload :size="21" :stroke-width="1.6" aria-hidden="true"
            /></span>
            <span class="action-copy"
              ><strong>{{ t('mcumgr.image.update') }}</strong
              ><span>{{ t('mcumgr.image.updateCaption') }}</span></span
            >
            <ArrowUpRight :size="16" class="action-arrow" aria-hidden="true" />
          </button>
        </McumgrHoverTip>
        <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.uploadHint')" block>
          <button
            type="button"
            class="transfer-action"
            :aria-label="t('mcumgr.image.upload')"
            :disabled="busy"
            @click="onImageUpload"
          >
            <span class="transfer-icon"
              ><FileUp :size="21" :stroke-width="1.6" aria-hidden="true"
            /></span>
            <span class="action-copy"
              ><strong>{{ t('mcumgr.image.upload') }}</strong
              ><span>{{ t('mcumgr.image.uploadCaption') }}</span></span
            >
            <ArrowUpRight :size="16" class="action-arrow" aria-hidden="true" />
          </button>
        </McumgrHoverTip>
      </div>
    </div>

    <div class="inspect-section">
      <header class="section-heading">
        <h4>{{ t('mcumgr.image.inspectTitle') }}</h4>
      </header>
      <div class="inspect-grid">
        <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.stateHint')" block>
          <button
            type="button"
            class="inspect-action"
            :aria-label="t('mcumgr.image.state')"
            :disabled="busy"
            @click="mcumgr.execute('image-state', { kind: 'image-state' })"
          >
            <span class="inspect-icon"
              ><Layers :size="18" :stroke-width="1.6" aria-hidden="true"
            /></span>
            <span class="action-copy"
              ><strong>{{ t('mcumgr.image.state') }}</strong
              ><span>{{ t('mcumgr.image.stateCaption') }}</span></span
            >
            <ChevronRight :size="14" class="action-arrow" aria-hidden="true" />
          </button>
        </McumgrHoverTip>
        <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.slotInfoHint')" block>
          <button
            type="button"
            class="inspect-action"
            :aria-label="t('mcumgr.image.slotInfo')"
            :disabled="busy"
            @click="mcumgr.execute('slot-info', { kind: 'image-slot-info' })"
          >
            <span class="inspect-icon"
              ><HardDrive :size="18" :stroke-width="1.6" aria-hidden="true"
            /></span>
            <span class="action-copy"
              ><strong>{{ t('mcumgr.image.slotInfo') }}</strong
              ><span>{{ t('mcumgr.image.slotCaption') }}</span></span
            >
            <ChevronRight :size="14" class="action-arrow" aria-hidden="true" />
          </button>
        </McumgrHoverTip>
      </div>
    </div>

    <div class="boot-section">
      <header class="section-heading">
        <h4>{{ t('mcumgr.group.boot') }}</h4>
        <span class="section-hint">{{ t('mcumgr.image.hash') }}</span>
      </header>
      <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.hashHint')" block>
        <n-input
          v-model:value="imageHashModel"
          size="small"
          :placeholder="t('mcumgr.image.hashPlaceholder')"
          :disabled="busy"
          :input-props="{
            spellcheck: false,
            autocomplete: 'off',
            'aria-label': t('mcumgr.image.hash'),
          }"
          class="hash-input"
        >
          <template #prefix><Hash :size="14" aria-hidden="true" /></template>
        </n-input>
      </McumgrHoverTip>
      <div class="boot-footer">
        <div class="boot-actions">
          <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.testHint')">
            <n-button size="small" :disabled="busy || !hasHash" @click="onImageTest"
              ><template #icon><RotateCw class="icon-sm" /></template
              >{{ t('mcumgr.image.test') }}</n-button
            >
          </McumgrHoverTip>
          <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.confirmHint')">
            <n-button size="small" :disabled="busy" @click="onImageConfirm"
              ><template #icon><Check class="icon-sm" /></template
              >{{ t('mcumgr.image.confirm') }}</n-button
            >
          </McumgrHoverTip>
        </div>
        <p>{{ t('mcumgr.image.confirmEmptyHint') }}</p>
      </div>
    </div>

    <footer class="erase-row">
      <Eraser :size="15" aria-hidden="true" /><span class="erase-copy">{{
        t('mcumgr.image.eraseCaption')
      }}</span>
      <McumgrHoverTip :disabled="busy" :text="t('mcumgr.image.eraseHint')">
        <n-button
          size="small"
          quaternary
          type="error"
          :disabled="busy"
          @click="
            confirmRun('image-erase', t('mcumgr.confirm.erase'), {
              kind: 'image-erase',
              slot: null,
            })
          "
          >{{ t('mcumgr.image.erase') }}</n-button
        >
      </McumgrHoverTip>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Eraser,
  FileUp,
  HardDrive,
  Hash,
  Layers,
  RotateCw,
  Upload,
} from '@lucide/vue';
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
.mc-image-workspace {
  container: image-tools / inline-size;
  min-width: 0;
  padding: 4px 2px 0;
}
.section-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
h4 {
  color: var(--text-secondary);
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-medium);
}
.section-hint {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.transfer-grid,
.inspect-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.transfer-action,
.inspect-action {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.transfer-action {
  min-height: 72px;
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
}
.transfer-action.is-primary {
  border-color: var(--color-primary-muted);
  background: var(--color-primary-subtle);
}
.transfer-icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 28px;
  height: 30px;
  color: var(--text-secondary);
}
.is-primary .transfer-icon,
.is-primary .action-arrow {
  color: var(--color-primary);
}
.action-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.action-copy strong {
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
}
.action-copy > span {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}
.action-arrow {
  flex-shrink: 0;
  color: var(--text-dim);
  transition:
    color var(--transition-normal),
    transform var(--transition-normal);
}
.transfer-action:hover:not(:disabled) {
  border-color: var(--color-primary-muted);
  background: var(--bg-hover);
}
.transfer-action.is-primary:hover:not(:disabled) {
  background: var(--bg-active);
}
.transfer-action:hover:not(:disabled) .action-arrow {
  transform: translate(1px, -1px);
  color: var(--color-primary);
}
.inspect-section,
.boot-section {
  margin-top: 22px;
}
.inspect-grid {
  column-gap: 22px;
}
.inspect-section .section-heading {
  margin-bottom: 2px;
}
.inspect-action {
  min-height: 64px;
  padding: 10px 6px;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
}
.inspect-icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-muted);
}
.inspect-action:hover:not(:disabled) {
  background: var(--bg-hover);
  border-radius: var(--radius-md);
}
.inspect-action:hover:not(:disabled) .inspect-icon,
.inspect-action:hover:not(:disabled) .action-arrow {
  color: var(--color-primary);
}
.transfer-action:focus-visible,
.inspect-action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
  border-radius: var(--radius-md);
}
.transfer-action:disabled,
.inspect-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.hash-input {
  width: 100%;
  --n-height: 34px !important;
}
.hash-input :deep(input) {
  font-family: var(--font-mono);
}
.hash-input :deep(.n-input__prefix) {
  color: var(--text-muted);
}
.boot-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.boot-actions {
  display: flex;
  gap: var(--space-sm);
}
.boot-footer p {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  margin: 0;
}
.erase-row {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 20px;
  padding: 12px 4px 0;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.erase-row > svg {
  flex-shrink: 0;
  color: var(--text-dim);
}
.erase-copy {
  flex: 1;
}
@container image-tools (max-width: 440px) {
  .transfer-grid,
  .inspect-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .transfer-action {
    min-height: 62px;
    padding: 11px 12px;
  }
  .inspect-action {
    min-height: 60px;
  }
  .boot-footer {
    align-items: flex-start;
  }
}
</style>
