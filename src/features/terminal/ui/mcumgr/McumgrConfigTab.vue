<template>
  <section class="mc-section">
    <McumgrActionCard
      :title="t('mcumgr.settings.editTitle')"
      :description="t('mcumgr.settings.editHint')"
      tone="accent"
    >
      <div class="mc-fields">
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.settings.name') }}</span>
          <n-input
            v-model:value="settingNameModel"
            size="small"
            :input-props="{ 'aria-label': t('mcumgr.settings.name') }"
            :placeholder="t('mcumgr.settings.name')"
            :disabled="busy"
          />
        </label>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.settings.value') }}</span>
          <n-input
            v-model:value="settingValueModel"
            size="small"
            :input-props="{ 'aria-label': t('mcumgr.settings.value') }"
            :placeholder="t('mcumgr.settings.value')"
            :disabled="busy"
          />
        </label>
      </div>
      <template #actions>
        <n-button
          size="small"
          secondary
          :disabled="busy || !settingNameModel.trim()"
          @click="
            mcumgr.execute('settings-read', {
              kind: 'settings-read',
              name: settingNameModel.trim(),
            })
          "
        >
          {{ t('mcumgr.settings.read') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="busy || !settingNameModel.trim()"
          @click="mcumgr.runSettingsWrite(settingNameModel, settingValueModel)"
        >
          {{ t('mcumgr.settings.write') }}
        </n-button>
        <n-button
          size="small"
          type="error"
          quaternary
          class="mc-delete-action"
          :disabled="busy || !settingNameModel.trim()"
          @click="
            confirmRun('settings-delete', t('mcumgr.confirm.delete'), {
              kind: 'settings-delete',
              name: settingNameModel.trim(),
            })
          "
        >
          {{ t('mcumgr.settings.delete') }}
        </n-button>
      </template>
    </McumgrActionCard>
    <McumgrActionCard
      :title="t('mcumgr.group.persist')"
      :description="t('mcumgr.settings.persistHint')"
    >
      <template #actions>
        <n-button
          size="small"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-commit', { kind: 'settings-commit' })"
        >
          {{ t('mcumgr.settings.commit') }}
        </n-button>
        <n-button
          size="small"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-load', { kind: 'settings-load' })"
        >
          {{ t('mcumgr.settings.load') }}
        </n-button>
        <n-button
          size="small"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-save', { kind: 'settings-save' })"
        >
          {{ t('mcumgr.settings.save') }}
        </n-button>
      </template>
    </McumgrActionCard>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { t } from '@/lib/i18n';
import McumgrActionCard from './McumgrActionCard.vue';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrOp } from '@/generated/ipc-contracts';

const props = defineProps<{
  busy: boolean;
  settingName: string;
  settingValue: string;
  mcumgr: SessionMcumgrController;
}>();

const emit = defineEmits<{
  'update:settingName': [value: string];
  'update:settingValue': [value: string];
}>();

const settingNameModel = computed({
  get: () => props.settingName,
  set: (value: string) => emit('update:settingName', value),
});

const settingValueModel = computed({
  get: () => props.settingValue,
  set: (value: string) => emit('update:settingValue', value),
});

async function confirmRun(action: string, confirmMessage: string, op: McumgrOp): Promise<void> {
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.execute(action, op);
}
</script>

<style scoped>
.mc-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  min-width: 0;
}

.mc-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--space-lg);
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

.mc-field :deep(.n-input__input-el) {
  font-size: var(--font-size-data);
}

.mc-delete-action {
  margin-inline-start: auto;
}
</style>
