<template>
  <AccessiblePluginDialog
    :title="t('plugins.serial.title')"
    :close-label="t('common.cancel')"
    :close-disabled="busy"
    @close="emit('resolve', 'reject')"
  >
    <p>{{ t('plugins.serial.requested_by', { name: proposal.pluginName }) }}</p>
    <dl class="plugin-proposal__details">
      <div>
        <dt>{{ t('plugins.serial.session') }}</dt>
        <dd>{{ proposal.sessionLabel }}</dd>
      </div>
      <div>
        <dt>{{ t('plugins.serial.reason') }}</dt>
        <dd>{{ proposal.displayLabel }}</dd>
      </div>
      <div>
        <dt>{{ t('plugins.serial.byte_count') }}</dt>
        <dd>{{ proposal.byteCount }}</dd>
      </div>
    </dl>
    <div class="plugin-proposal__preview">
      <span>{{ t('plugins.serial.hex_preview') }}</span>
      <code>{{ proposal.hexPreview }}</code>
    </div>
    <p class="plugin-proposal__warning" role="alert">{{ t('plugins.serial.one_time_warning') }}</p>
    <div class="plugin-proposal__actions">
      <button type="button" :disabled="busy" @click="emit('resolve', 'reject')">
        {{ t('plugins.serial.reject') }}
      </button>
      <button type="button" class="danger" :disabled="busy" @click="emit('resolve', 'approve')">
        {{ t('plugins.serial.approve_once') }}
      </button>
    </div>
  </AccessiblePluginDialog>
</template>

<script setup lang="ts">
import { t } from '../../lib/i18n';
import type { PluginSerialProposal } from '../../features/plugins';
import AccessiblePluginDialog from './AccessiblePluginDialog.vue';

defineProps<{
  proposal: PluginSerialProposal;
  busy: boolean;
}>();

const emit = defineEmits<{
  resolve: [decision: 'approve' | 'reject'];
}>();
</script>

<style scoped>
.plugin-proposal__details div {
  display: grid;
  grid-template-columns: 9rem 1fr;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.plugin-proposal__details dt {
  font-weight: 600;
}

.plugin-proposal__details dd {
  margin: 0;
}

.plugin-proposal__preview {
  display: grid;
  gap: 0.35rem;
}

.plugin-proposal__preview code {
  overflow-wrap: anywhere;
  border-radius: 0.35rem;
  padding: 0.65rem;
  background: var(--input-bg, #0f172a);
}

.plugin-proposal__warning {
  border-left: 3px solid var(--warning-color, #f59e0b);
  padding-left: 0.65rem;
}

.plugin-proposal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}

button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.35rem;
  padding: 0.35rem 0.85rem;
  background: transparent;
  color: inherit;
}

button.danger {
  border-color: var(--error-color, #ef4444);
  background: var(--error-color, #b91c1c);
  color: white;
}

button:focus-visible {
  outline: 3px solid var(--primary-color, #60a5fa);
  outline-offset: 2px;
}
</style>
