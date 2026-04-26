<template>
  <n-modal
    :show="show"
    preset="dialog"
    title="新建会话 (Ctrl+N)"
    positive-text="确定"
    negative-text="取消"
    @update:show="emit('update:show', $event)"
    @positive-click="createSession"
    @negative-click="emit('update:show', false)"
  >
    <n-form label-placement="left" label-width="60">
      <n-form-item label="串口">
        <n-select v-model:value="portName" :options="portOptions" placeholder="选择可用串口" />
      </n-form-item>
      <n-form-item label="波特率">
        <n-select v-model:value="baudRate" :options="baudRateOptions" />
      </n-form-item>
      <n-form-item label="数据位">
        <n-select v-model:value="dataBits" :options="dataBitsOptions" />
      </n-form-item>
      <n-form-item label="停止位">
        <n-select v-model:value="stopBits" :options="stopBitsOptions" />
      </n-form-item>
      <n-form-item label="校验位">
        <n-select v-model:value="parity" :options="parityOptions" />
      </n-form-item>
      <n-form-item label="流控">
        <n-select v-model:value="flowControl" :options="flowControlOptions" />
      </n-form-item>
    </n-form>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NForm, NFormItem, NModal, NSelect } from 'naive-ui';
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
import type { PortConfig } from '../../types';

defineProps<{
  show: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void;
}>();

const serialStore = useSerialStore();
const sessionStore = useSessionStore();
const { createSession: createSessionFromConfig } = useSessionActions();

const portName = ref('');
const baudRate = ref(115200);
const dataBits = ref<PortConfig['dataBits']>(8);
const stopBits = ref<PortConfig['stopBits']>(1);
const parity = ref<PortConfig['parity']>('none');
const flowControl = ref<PortConfig['flowControl']>('none');

const usedPorts = computed(() =>
  new Set(sessionStore.sessions.filter((session) => session.isConnected).map((session) => session.portName))
);

const portOptions = computed(() =>
  serialStore.availablePorts.map((port) => ({
    label: usedPorts.value.has(port) ? `${port} (使用中)` : port,
    value: port,
    disabled: usedPorts.value.has(port),
  }))
);

const baudRateOptions = BAUD_RATES;
const dataBitsOptions = DATA_BITS_OPTIONS;
const stopBitsOptions = STOP_BITS_OPTIONS;
const parityOptions = PARITY_OPTIONS;
const flowControlOptions = FLOW_CONTROL_OPTIONS;

watch(
  () => serialStore.portConfig,
  (config) => {
    baudRate.value = config.baudRate;
    dataBits.value = config.dataBits;
    stopBits.value = config.stopBits;
    parity.value = config.parity;
    flowControl.value = config.flowControl;
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
  };
  serialStore.setPortConfig(config);
  createSessionFromConfig(portName.value, config);
  portName.value = '';
  emit('update:show', false);
  return true;
}
</script>
