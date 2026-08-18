<template>
  <AppModal
    :show="show"
    :title="t('create.title')"
    :width="460"
    @close="emit('update:show', false)"
  >
    <div class="session-form">
      <div class="form-field form-full">
        <span class="form-label">{{ t('create.port') }}</span>
        <div class="port-picker-row">
          <AppSelect
            v-model:value="portName"
            :aria-label="t('create.port')"
            :options="portOptions"
            :placeholder="t('create.portPlaceholder')"
          />
          <n-button
            quaternary
            :loading="refreshingPorts"
            :title="t('serial.refreshPorts')"
            :aria-label="t('serial.refreshPorts')"
            @click="refreshPorts"
          >
            <template #icon><RefreshCw class="icon-sm" /></template>
          </n-button>
        </div>
        <p v-if="ports.length === 0" class="port-status" role="status" aria-live="polite">
          {{ t('serial.noPorts') }}
        </p>
      </div>
      <div class="form-field form-full">
        <span class="form-label">{{ t('create.preset') }}</span>
        <div class="preset-controls">
          <AppSelect
            v-model:value="selectedPresetId"
            :aria-label="t('create.preset')"
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
        </div>
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.baudRate') }}</span>
        <AppSelect
          v-model:value="baudRate"
          :aria-label="t('serial.baudRate')"
          :options="baudRateOptions"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.dataBits') }}</span>
        <AppSelect
          v-model:value="dataBits"
          :aria-label="t('serial.dataBits')"
          :options="dataBitsOptions"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.stopBits') }}</span>
        <AppSelect
          v-model:value="stopBits"
          :aria-label="t('serial.stopBits')"
          :options="stopBitsOptions"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.parity') }}</span>
        <AppSelect
          v-model:value="parity"
          :aria-label="t('serial.parity')"
          :options="parityOptions"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.flowControl') }}</span>
        <AppSelect
          v-model:value="flowControl"
          :aria-label="t('serial.flowControl')"
          :options="flowControlOptions"
        />
      </div>
      <div class="form-field">
        <span class="form-label" :title="t('serial.rxFrameGapHint')">{{
          t('serial.rxFrameGap')
        }}</span>
        <n-input-number
          :value="rxFrameGapMs"
          :aria-label="t('serial.rxFrameGap')"
          :min="MIN_RX_FRAME_GAP_MS"
          :max="MAX_RX_FRAME_GAP_MS"
          :precision="0"
          @update:value="rxFrameGapMs = normalizeRxFrameGapMs($event)"
        >
          <template #suffix>ms</template>
        </n-input-number>
      </div>
      <div class="form-field form-full">
        <span class="form-label">{{ t('serial.signalControl') }}</span>
        <div class="signal-row">
          <SignalToggle v-model="dtr" label="DTR" />
          <SignalToggle v-model="rts" label="RTS" />
          <span class="signal-hint">{{ t('serial.signalHint') }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <n-button size="small" @click="emit('update:show', false)">
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        class="modal-positive"
        size="small"
        type="primary"
        :disabled="!canCreate"
        @click="createSession"
      >
        {{ t('create.confirm') }}
      </n-button>
    </template>
  </AppModal>
  <!-- Lightweight inline prompt for naming a new preset (avoids pulling another
       naive-ui component; reuses a small dialog). -->
  <AppModal
    :show="namingPreset"
    :title="t('create.savePresetDialog')"
    :width="380"
    :closable="false"
    @close="namingPreset = false"
  >
    <n-input v-model:value="presetName" :placeholder="t('create.presetNamePlaceholder')" />
    <template #footer>
      <n-button size="small" @click="namingPreset = false">{{ t('common.cancel') }}</n-button>
      <n-button class="modal-positive" size="small" type="primary" @click="confirmSavePreset">
        {{ t('common.save') }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NInput, NInputNumber, NButton } from 'naive-ui';
import AppModal from '../ui/AppModal.vue';
import AppSelect from '../ui/AppSelect.vue';
import SignalToggle from '../ui/SignalToggle.vue';
import { BookmarkPlus, RefreshCw, Trash2 } from '@lucide/vue';
import { useSerialStore } from '../../stores/serial';
import {
  useSessionCatalog,
  useSessionMutationPolicy,
  useSessionRuntimeStatuses,
} from '../../features/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import { usePortWatcher } from '../../composables/usePortWatcher';
import {
  BAUD_RATES,
  DATA_BITS_OPTIONS,
  FLOW_CONTROL_OPTIONS,
  PARITY_OPTIONS,
  STOP_BITS_OPTIONS,
} from '../../lib/constants';
import {
  addDeviceProfile as addPreset,
  describeDeviceProfileConfig as describeConfig,
  loadDeviceProfiles as loadPresets,
  removeDeviceProfile as removePreset,
  type DeviceProfile as ConnectionPreset,
} from '../../features/device-profiles';
import { t } from '../../lib/i18n';
import type { PortConfig } from '../../types';
import {
  DEFAULT_RX_FRAME_GAP_MS,
  MAX_RX_FRAME_GAP_MS,
  MIN_RX_FRAME_GAP_MS,
  normalizeRxFrameGapMs,
} from '../../lib/serial-framing';

const props = defineProps<{
  show: boolean;
  preferredPort?: string;
}>();

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void;
}>();

const serialStore = useSerialStore();
const catalog = useSessionCatalog();
const mutationPolicy = useSessionMutationPolicy();
const { createSession: createSessionFromConfig } = useSessionActions();
const { isConnected } = useSessionRuntimeStatuses();
const { ports, refresh } = usePortWatcher();
const refreshingPorts = ref(false);

const portName = ref('');

const baudRate = ref(115200);
const dataBits = ref<PortConfig['dataBits']>(8);
const stopBits = ref<PortConfig['stopBits']>(1);
const parity = ref<PortConfig['parity']>('none');
const flowControl = ref<PortConfig['flowControl']>('none');
const rxFrameGapMs = ref(DEFAULT_RX_FRAME_GAP_MS);
const dtr = ref(false);
const rts = ref(false);

const usedPorts = computed(
  () =>
    new Set(
      catalog.sessions.value
        .filter((session) => isConnected(session.id))
        .map((session) => session.portName),
    ),
);

function syncFormFromStoreConfig(): void {
  const config = serialStore.portConfig;
  baudRate.value = config.baudRate;
  dataBits.value = config.dataBits;
  stopBits.value = config.stopBits;
  parity.value = config.parity;
  flowControl.value = config.flowControl;
  rxFrameGapMs.value = normalizeRxFrameGapMs(config.rxFrameGapMs);
  dtr.value = config.dtr;
  rts.value = config.rts;
}

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    // Seed once per open. A continuous deep watch on the shared store config
    // would clobber the user's in-progress edits whenever another path (e.g.
    // a created session) updates it while the dialog is open.
    syncFormFromStoreConfig();
    void refreshPorts();
    const preferred = props.preferredPort || serialStore.selectedPort;
    if (preferred && !usedPorts.value.has(preferred)) portName.value = preferred;
  },
  { immediate: true },
);

watch(ports, (available) => {
  if (!portName.value) {
    portName.value = available.find((port) => !usedPorts.value.has(port)) ?? '';
  }
});

const portOptions = computed(() =>
  ports.value.map((port) => ({
    label: usedPorts.value.has(port) ? `${port} (${t('serial.inUse')})` : port,
    value: port,
    disabled: usedPorts.value.has(port),
  })),
);
const canCreate = computed(
  () =>
    mutationPolicy.userMutationsAllowed.value &&
    portName.value.length > 0 &&
    !usedPorts.value.has(portName.value),
);

async function refreshPorts(): Promise<void> {
  refreshingPorts.value = true;
  try {
    await refresh();
  } finally {
    refreshingPorts.value = false;
  }
}

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

function createSession() {
  if (!canCreate.value) return false;
  const config: PortConfig = {
    baudRate: baudRate.value,
    dataBits: dataBits.value,
    stopBits: stopBits.value,
    parity: parity.value,
    flowControl: flowControl.value,
    rxFrameGapMs: rxFrameGapMs.value,
    dtr: dtr.value,
    rts: rts.value,
  };
  const createdSessionId = createSessionFromConfig(portName.value, config);
  if (!createdSessionId) return false;
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
  rxFrameGapMs.value = normalizeRxFrameGapMs(c.rxFrameGapMs);
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
    rxFrameGapMs: rxFrameGapMs.value,
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

.form-field {
  display: grid;
  gap: 4px;
}

.form-label {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.port-picker-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-xs);
}

.port-status {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.preset-controls {
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

.signal-hint {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
}

@media (max-width: 560px) {
  .session-form {
    grid-template-columns: 1fr;
  }
}
</style>
