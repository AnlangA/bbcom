<template>
  <section class="mc-section">
    <article class="mc-card">
      <header class="mc-card-head">{{ t('mcumgr.group.key') }}</header>
      <div class="mc-row">
        <n-input
          v-model:value="settingNameModel"
          size="tiny"
          class="mc-grow"
          :placeholder="t('mcumgr.settings.name')"
          :disabled="busy"
        />
        <n-input
          v-model:value="settingValueModel"
          size="tiny"
          class="mc-grow"
          :placeholder="t('mcumgr.settings.value')"
          :disabled="busy"
        />
      </div>
      <div class="mc-actions">
        <n-button
          size="tiny"
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
          size="tiny"
          secondary
          :disabled="busy || !settingNameModel.trim()"
          @click="mcumgr.runSettingsWrite(settingNameModel, settingValueModel)"
        >
          {{ t('mcumgr.settings.write') }}
        </n-button>
        <n-button
          size="tiny"
          type="error"
          secondary
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
      </div>
    </article>
    <article class="mc-card">
      <header class="mc-card-head">{{ t('mcumgr.group.persist') }}</header>
      <div class="mc-actions">
        <n-button
          size="tiny"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-commit', { kind: 'settings-commit' })"
        >
          {{ t('mcumgr.settings.commit') }}
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-load', { kind: 'settings-load' })"
        >
          {{ t('mcumgr.settings.load') }}
        </n-button>
        <n-button
          size="tiny"
          secondary
          :disabled="busy"
          @click="mcumgr.execute('settings-save', { kind: 'settings-save' })"
        >
          {{ t('mcumgr.settings.save') }}
        </n-button>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import { t } from '@/lib/i18n';
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
