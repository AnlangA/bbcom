<template>
  <AppModal
    :show="show"
    :title="t('serial.settings.title')"
    :width="460"
    :closable="!saving"
    @close="close"
  >
    <div class="serial-settings-form">
      <div class="form-field">
        <span class="form-label">{{ t('serial.baudRate') }}</span>
        <AppSelect
          v-model:value="draft.baudRate"
          :aria-label="t('serial.baudRate')"
          :options="BAUD_RATES"
          :disabled="saving"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.dataBits') }}</span>
        <AppSelect
          v-model:value="draft.dataBits"
          :aria-label="t('serial.dataBits')"
          :options="DATA_BITS_OPTIONS"
          :disabled="saving"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.stopBits') }}</span>
        <AppSelect
          v-model:value="draft.stopBits"
          :aria-label="t('serial.stopBits')"
          :options="STOP_BITS_OPTIONS"
          :disabled="saving"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.parity') }}</span>
        <AppSelect
          v-model:value="draft.parity"
          :aria-label="t('serial.parity')"
          :options="parityOptions"
          :disabled="saving"
        />
      </div>
      <div class="form-field">
        <span class="form-label">{{ t('serial.flowControl') }}</span>
        <AppSelect
          v-model:value="draft.flowControl"
          :aria-label="t('serial.flowControl')"
          :options="flowControlOptions"
          :disabled="saving"
        />
      </div>
      <div class="form-field">
        <span class="form-label" :title="t('serial.rxFrameGapHint')">
          {{ t('serial.rxFrameGap') }}
        </span>
        <n-input-number
          :value="draft.rxFrameGapMs"
          :aria-label="t('serial.rxFrameGap')"
          :min="MIN_RX_FRAME_GAP_MS"
          :max="MAX_RX_FRAME_GAP_MS"
          :precision="0"
          :disabled="saving"
          @update:value="draft.rxFrameGapMs = normalizeRxFrameGapMs($event)"
        >
          <template #suffix>ms</template>
        </n-input-number>
      </div>
      <div class="form-field form-full">
        <span class="form-label">{{ t('serial.signalControl') }}</span>
        <div class="signal-row">
          <SignalToggle v-model="draft.dtr" label="DTR" :disabled="saving" />
          <SignalToggle v-model="draft.rts" label="RTS" :disabled="saving" />
          <span class="signal-hint">{{ t('serial.signalHint') }}</span>
        </div>
      </div>
      <p class="apply-hint">
        {{ connected ? t('serial.settings.liveHint') : t('serial.settings.nextOpenHint') }}
      </p>
    </div>
    <template #footer>
      <n-button size="small" :disabled="saving" @click="close">
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        class="modal-positive"
        size="small"
        type="primary"
        :loading="saving"
        @click="emit('save', { ...draft })"
      >
        {{ t('common.save') }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { NButton, NInputNumber } from 'naive-ui';
import AppModal from '@/design-system/AppModal.vue';
import AppSelect from '@/design-system/AppSelect.vue';
import SignalToggle from '@/design-system/SignalToggle.vue';
import {
  BAUD_RATES,
  DATA_BITS_OPTIONS,
  FLOW_CONTROL_OPTIONS,
  PARITY_OPTIONS,
  STOP_BITS_OPTIONS,
} from '@/lib/constants';
import { t } from '@/lib/i18n';
import {
  MAX_RX_FRAME_GAP_MS,
  MIN_RX_FRAME_GAP_MS,
  normalizeRxFrameGapMs,
} from '@/lib/serial-framing';
import type { PortConfig } from '@/types';

const props = defineProps<{
  show: boolean;
  config: PortConfig;
  connected: boolean;
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:show': [show: boolean];
  save: [config: PortConfig];
}>();

const draft = reactive<PortConfig>({ ...props.config });

watch(
  () => props.show,
  (show) => {
    if (show) Object.assign(draft, props.config);
  },
);

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

function close(): void {
  if (!props.saving) emit('update:show', false);
}
</script>

<style scoped>
.serial-settings-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
  padding-top: var(--space-xs);
}

.form-field {
  display: grid;
  gap: var(--space-xs);
}

.form-full,
.apply-hint {
  grid-column: 1 / -1;
}

.form-label {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.signal-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-lg);
}

.signal-hint,
.apply-hint {
  color: var(--text-dim);
  font-size: var(--font-size-xs);
}

.apply-hint {
  margin: 0;
}

@media (max-width: 560px) {
  .serial-settings-form {
    grid-template-columns: 1fr;
  }
}
</style>
