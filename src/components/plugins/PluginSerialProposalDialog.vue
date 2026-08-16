<template>
  <AppModal
    :show="true"
    :title="t('plugins.serial.title')"
    :busy="busy"
    danger
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
    <template #footer>
      <button type="button" :disabled="busy" @click="emit('resolve', 'reject')">
        {{ t('plugins.serial.reject') }}
      </button>
      <button type="button" class="danger" :disabled="busy" @click="emit('resolve', 'approve')">
        {{ t('plugins.serial.approve_once') }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { t } from '../../lib/i18n';
import type { PluginSerialProposal } from '../../features/plugins';
import AppModal from '../ui/AppModal.vue';

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
  background: var(--bg-inset);
}

.plugin-proposal__warning {
  border-left: 3px solid var(--color-warning);
  padding-left: 0.65rem;
}

button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: 0.35rem;
  padding: 0.35rem 0.85rem;
  background: transparent;
  color: inherit;
}

button.danger {
  border-color: var(--color-error);
  background: var(--color-error);
  color: white;
}

button:focus-visible {
  outline: 3px solid var(--color-primary);
  outline-offset: 2px;
}
</style>
