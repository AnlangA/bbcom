<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="t('session.rebind')"
    :positive-text="t('session.rebind')"
    :negative-text="t('common.cancel')"
    :positive-button-props="{ disabled: !selectedPort }"
    :style="{ width: '420px' }"
    @update:show="emit('update:show', $event)"
    @positive-click="completeRebind"
    @negative-click="emit('update:show', false)"
  >
    <div class="rebind-form">
      <p class="rebind-description">{{ t('session.rebindRequired') }}</p>
      <AppSelect
        v-model:value="selectedPort"
        :aria-label="t('create.port')"
        :options="portOptions"
        :placeholder="t('create.portPlaceholder')"
      />
      <p v-if="failure" class="rebind-error" role="alert">{{ failure }}</p>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NModal } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { t } from '@/lib/i18n';
import { useSerialStore } from '@/features/serial/store/serial-store';
import { useSessionCatalog, useSessionRuntimeStatuses } from '@/features/sessions';
import type { PortConfig } from '@/types';

const props = defineProps<{
  show: boolean;
  sessionId: string;
  portConfig: PortConfig;
}>();

const emit = defineEmits<{
  'update:show': [show: boolean];
  rebound: [portName: string];
}>();

const serialStore = useSerialStore();
const catalog = useSessionCatalog();
const selectedPort = ref<string | null>(null);
const failure = ref<string | null>(null);
const { isConnected } = useSessionRuntimeStatuses();

const usedPorts = computed(
  () =>
    new Set(
      catalog.sessions.value
        .filter((session) => session.id !== props.sessionId && isConnected(session.id))
        .map((session) => session.portName),
    ),
);
const portOptions = computed(() =>
  serialStore.availablePorts.map((port) => ({
    label: usedPorts.value.has(port) ? `${port} (${t('serial.inUse')})` : port,
    value: port,
    disabled: usedPorts.value.has(port),
  })),
);

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    selectedPort.value = null;
    failure.value = null;
  },
);

function completeRebind(): boolean {
  if (!selectedPort.value) return false;
  const result = catalog.completeRebind(props.sessionId, selectedPort.value, props.portConfig);
  if (!result.ok) {
    failure.value =
      result.reason === 'invalid-port' ? t('error.invalid_input') : t('session.rebindRequired');
    return false;
  }
  const reboundPort = selectedPort.value;
  emit('rebound', reboundPort);
  emit('update:show', false);
  return true;
}
</script>

<style scoped>
.rebind-form {
  display: grid;
  gap: var(--space-md);
}

.rebind-description {
  margin: 0;
  color: var(--text-secondary);
}

.rebind-error {
  margin: 0;
  color: var(--color-error);
}
</style>
