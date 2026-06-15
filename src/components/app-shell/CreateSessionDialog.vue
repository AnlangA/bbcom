<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="t('create.title')"
    :positive-text="t('create.confirm')"
    :negative-text="t('common.cancel')"
    :style="{ width: '460px' }"
    @update:show="emit('update:show', $event)"
    @positive-click="createSession"
    @negative-click="emit('update:show', false)"
  >
    <n-form class="session-form" label-placement="top">
      <n-form-item class="form-full" :label="t('create.port')">
        <n-select
          v-model:value="portName"
          :options="portOptions"
          :placeholder="t('create.portPlaceholder')"
        />
      </n-form-item>
      <n-form-item class="form-full preset-row" :label="t('create.preset')">
        <n-select
          v-model:value="selectedPresetId"
          :options="presetOptions"
          :placeholder="t('create.presetPlaceholder')"
          size="small"
          clearable
          @update:value="applyPreset"
        />
        <n-button
          size="small"
          quaternary
          :disabled="!canSavePreset"
          @click="openSavePreset"
          :title="t('create.savePresetTitle')"
        >
          <template #icon><BookmarkPlus class="icon-sm" /></template>
        </n-button>
        <n-button
          size="small"
          quaternary
          :disabled="!selectedPresetId"
          @click="deletePreset"
          :title="t('create.deletePresetTitle')"
        >
          <template #icon><Trash2 class="icon-sm" /></template>
        </n-button>
      </n-form-item>
      <n-form-item :label="t('serial.baudRate')">
        <n-select v-model:value="baudRate" :options="baudRateOptions" />
      </n-form-item>
      <n-form-item :label="t('serial.dataBits')">
        <n-select v-model:value="dataBits" :options="dataBitsOptions" />
      </n-form-item>
      <n-form-item :label="t('serial.stopBits')">
        <n-select v-model:value="stopBits" :options="stopBitsOptions" />
      </n-form-item>
      <n-form-item :label="t('serial.parity')">
        <n-select v-model:value="parity" :options="parityOptions" />
      </n-form-item>
      <n-form-item :label="t('serial.flowControl')">
        <n-select v-model:value="flowControl" :options="flowControlOptions" />
      </n-form-item>
      <n-form-item class="form-full" :label="t('serial.signalControl')">
        <div class="signal-row">
          <label class="signal-toggle"><n-switch v-model:value="dtr" size="small" /> DTR</label>
          <label class="signal-toggle"><n-switch v-model:value="rts" size="small" /> RTS</label>
          <span class="signal-hint">{{ t('serial.signalHint') }}</span>
        </div>
      </n-form-item>
    </n-form>
  </n-modal>
  <!-- Lightweight inline prompt for naming a new preset (avoids pulling another
       naive-ui component; reuses a small dialog). -->
  <n-modal
    :show="namingPreset"
    preset="dialog"
    :title="t('create.savePresetDialog')"
    :positive-text="t('common.save')"
    :negative-text="t('common.cancel')"
    :style="{ width: '380px' }"
    @positive-click="confirmSavePreset"
    @negative-click="namingPreset = false"
  >
    <n-input v-model:value="presetName" :placeholder="t('create.presetNamePlaceholder')" />
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NForm, NFormItem, NModal, NSelect, NSwitch, NInput, NButton } from 'naive-ui';
import { BookmarkPlus, Trash2 } from 'lucide-vue-next';
import { useSerialStore } from '../../stores/serial';
import { useSessionStore } from '../../stores/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import {
  BAUD_RATES,
  DATA_BITS_OPTIONS,
  FLOW_CONTROL_OPTIONS,
  PARITY_OPTIONS,
  STOP_BITS_OPTIONS,
} from '../../lib/constants';
import {
  addPreset,
  describeConfig,
  loadPresets,
  removePreset,
  type ConnectionPreset,
} from '../../lib/connection-presets';
import { t } from '../../lib/i18n';
import type { PortConfig } from '../../types';

const props = defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void;
}>();

const serialStore = useSerialStore();
const sessionStore = useSessionStore();
const { createSession: createSessionFromConfig } = useSessionActions();

const portName = ref('');

// Pre-fill the port from the sidebar selection when the dialog opens, mirroring
// how the config fields are synced from serialStore.portConfig below.
watch(
  () => props.show,
  (show) => {
    if (show && serialStore.selectedPort) {
      portName.value = serialStore.selectedPort;
    }
  },
);
const baudRate = ref(115200);
const dataBits = ref<PortConfig['dataBits']>(8);
const stopBits = ref<PortConfig['stopBits']>(1);
const parity = ref<PortConfig['parity']>('none');
const flowControl = ref<PortConfig['flowControl']>('none');
const dtr = ref(false);
const rts = ref(false);

const usedPorts = computed(
  () =>
    new Set(
      sessionStore.sessions
        .filter((session) => session.isConnected)
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

const baudRateOptions = BAUD_RATES;
const dataBitsOptions = DATA_BITS_OPTIONS;
const stopBitsOptions = STOP_BITS_OPTIONS;
const parityOptions = computed(() =>
  PARITY_OPTIONS.map((option) => ({
    ...option,
    label: t(`serial.parity.${option.value}`),
  })),
);
const flowControlOptions = computed(() =>
  FLOW_CONTROL_OPTIONS.map((option) => ({
    ...option,
    label: t(`serial.flow.${option.value}`),
  })),
);

watch(
  () => serialStore.portConfig,
  (config) => {
    baudRate.value = config.baudRate;
    dataBits.value = config.dataBits;
    stopBits.value = config.stopBits;
    parity.value = config.parity;
    flowControl.value = config.flowControl;
    dtr.value = config.dtr;
    rts.value = config.rts;
  },
  { immediate: true, deep: true },
);

function createSession() {
  if (!portName.value) return false;
  const config: PortConfig = {
    baudRate: baudRate.value,
    dataBits: dataBits.value,
    stopBits: stopBits.value,
    parity: parity.value,
    flowControl: flowControl.value,
    dtr: dtr.value,
    rts: rts.value,
  };
  serialStore.setPortConfig(config);
  createSessionFromConfig(portName.value, config);
  portName.value = '';
  emit('update:show', false);
  return true;
}

// --- Connection presets: save/apply/delete named port-config profiles ---
const presets = ref<ConnectionPreset[]>(loadPresets());
const selectedPresetId = ref<string | null>(null);
const namingPreset = ref(false);
const presetName = ref('');

const presetOptions = computed(() =>
  presets.value.map((p) => ({ label: `${p.name} (${describeConfig(p.config)})`, value: p.id })),
);

const canSavePreset = computed(() => baudRate.value > 0);

function applyPreset(id: string | null) {
  if (!id) return;
  const preset = presets.value.find((p) => p.id === id);
  if (!preset) return;
  const c = preset.config;
  baudRate.value = c.baudRate;
  dataBits.value = c.dataBits;
  stopBits.value = c.stopBits;
  parity.value = c.parity;
  flowControl.value = c.flowControl;
  dtr.value = c.dtr;
  rts.value = c.rts;
}

function openSavePreset() {
  presetName.value = describeConfig(currentConfig());
  namingPreset.value = true;
}

function confirmSavePreset() {
  presets.value = addPreset(presets.value, presetName.value, currentConfig());
  namingPreset.value = false;
  presetName.value = '';
}

function deletePreset() {
  if (!selectedPresetId.value) return;
  presets.value = removePreset(presets.value, selectedPresetId.value);
  selectedPresetId.value = null;
}

function currentConfig(): PortConfig {
  return {
    baudRate: baudRate.value,
    dataBits: dataBits.value,
    stopBits: stopBits.value,
    parity: parity.value,
    flowControl: flowControl.value,
    dtr: dtr.value,
    rts: rts.value,
  };
}
</script>

<style scoped>
.session-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding-top: 4px;
}

.form-full {
  grid-column: 1 / -1;
}

.preset-row :deep(.n-form-item-content) {
  display: flex;
  gap: 4px;
  align-items: center;
}

.signal-row {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
  flex-wrap: wrap;
}

.signal-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  cursor: pointer;
}

.signal-hint {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
}

.session-form :deep(.n-form-item) {
  margin: 0;
}

@media (max-width: 560px) {
  .session-form {
    grid-template-columns: 1fr;
  }
}
</style>
