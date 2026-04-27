<template>
  <div class="port-selector">
    <div class="section">
      <div class="section-title" @click="toggleSection('port')" style="cursor: pointer">
        <span>串口选择</span>
        <span class="toggle-icon">{{ collapsed.port ? '▸' : '▾' }}</span>
      </div>
      <div v-show="!collapsed.port">
        <div class="port-row">
          <n-select
            v-model:value="selectedPort"
            :options="portOptions"
            placeholder="选择串口"
            clearable
            size="small"
          />
          <n-button size="small" @click="refreshPorts" :loading="isRefreshing" quaternary>
            ↻
          </n-button>
        </div>
        <div v-if="ports.length === 0" class="empty-hint">
          未检测到串口设备
        </div>
        <div v-if="missingActivePorts.length > 0" class="empty-hint warning">
          端口已断开：{{ missingActivePorts.join(', ') }}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title" @click="toggleSection('config')" style="cursor: pointer">
        <span>连接参数</span>
        <span class="toggle-icon">{{ collapsed.config ? '▸' : '▾' }}</span>
      </div>
      <div v-show="!collapsed.config">
        <div class="config-grid">
          <div class="config-item">
            <label>波特率</label>
            <n-select v-model:value="config.baudRate" :options="baudRateOptions" size="small" />
          </div>
          <div class="config-item">
            <label>数据位</label>
            <n-select v-model:value="config.dataBits" :options="dataBitsOptions" size="small" />
          </div>
          <div class="config-item">
            <label>停止位</label>
            <n-select v-model:value="config.stopBits" :options="stopBitsOptions" size="small" />
          </div>
          <div class="config-item">
            <label>校验位</label>
            <n-select v-model:value="config.parity" :options="parityOptions" size="small" />
          </div>
          <div class="config-item">
            <label>流控</label>
            <n-select v-model:value="config.flowControl" :options="flowControlOptions" size="small" />
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <n-button size="small" block @click="newSession" :disabled="!selectedPort" type="primary" ghost>
        新建会话
      </n-button>
    </div>

    <div class="section">
      <div class="section-title" @click="toggleSection('checksum')" style="cursor: pointer">
        <span>校验和计算</span>
        <span class="toggle-icon">{{ collapsed.checksum ? '▸' : '▾' }}</span>
      </div>
      <div v-show="!collapsed.checksum">
        <div class="checksum-grid">
          <n-input
            v-model:value="checksumInput"
            placeholder="输入 HEX (如: AA BB CC)"
            size="small"
            :status="checksumInput && !isValidHexInput ? 'error' : undefined"
            @blur="normalizeChecksumInput"
          />
          <div class="checksum-meta">
            <span>{{ checksumByteCount }} 字节</span>
            <span v-if="checksumInput && !isValidHexInput" class="checksum-error">HEX 长度需为偶数</span>
          </div>
          <div class="checksum-actions">
            <n-select
              v-model:value="checksumAlgo"
              :options="checksumAlgoOptions"
              size="small"
            />
          </div>
          <div v-if="checksumResult" class="checksum-result" @click="copyChecksum" title="点击复制">
            <div>
              <span class="checksum-label">结果</span>
              <span class="checksum-algo">{{ checksumAlgoLabel }}</span>
            </div>
            <span class="checksum-value">{{ checksumResult }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch } from 'vue';
import { NSelect, NButton, NInput } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { usePortWatcher } from '../../composables/usePortWatcher';
import { useSerialStore } from '../../stores/serial';
import { useSessionStore } from '../../stores/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import { formatHex, isValidHex, parseHex } from '../../lib/format';
import { checksumOptions } from '../../lib/checksum-constants';
import { BAUD_RATES, DATA_BITS_OPTIONS, STOP_BITS_OPTIONS, PARITY_OPTIONS, FLOW_CONTROL_OPTIONS } from '../../lib/constants';

const serialStore = useSerialStore();
const sessionStore = useSessionStore();
const { createSession } = useSessionActions();
const { ports, refresh } = usePortWatcher();
const isRefreshing = ref(false);
const missingActivePorts = computed(() =>
  sessionStore.sessions
    .filter((s) => s.isConnected && !ports.value.includes(s.portName))
    .map((s) => s.portName)
);

const collapsed = reactive({
  port: false,
  config: false,
  checksum: true,
});

function toggleSection(key: keyof typeof collapsed) {
  collapsed[key] = !collapsed[key];
}

const selectedPort = computed({
  get: () => serialStore.selectedPort,
  set: (v) => serialStore.setSelectedPort(v),
});

const usedPorts = computed(() =>
  new Set(sessionStore.sessions.filter((s) => s.isConnected).map((s) => s.portName))
);

const portOptions = computed(() =>
  ports.value.map((p) => ({
    label: usedPorts.value.has(p) ? `${p} (使用中)` : p,
    value: p,
    disabled: usedPorts.value.has(p),
  }))
);

// Auto-select first available port when none is selected
watch(() => ports.value, (newPorts) => {
  if (!selectedPort.value && newPorts.length > 0) {
    selectedPort.value = newPorts[0];
  }
}, { immediate: true });

const config = computed(() => serialStore.portConfig);

async function refreshPorts() {
  isRefreshing.value = true;
  await refresh();
  isRefreshing.value = false;
}

function newSession() {
  if (!selectedPort.value) return;
  createSession(selectedPort.value, { ...serialStore.portConfig });
}

const baudRateOptions = BAUD_RATES;

const dataBitsOptions = DATA_BITS_OPTIONS;

const stopBitsOptions = STOP_BITS_OPTIONS;

const parityOptions = PARITY_OPTIONS;

const flowControlOptions = FLOW_CONTROL_OPTIONS;

const checksumInput = ref('');
const checksumAlgo = ref<'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC32'>('CHECKSUM');
const checksumResult = ref('');
let checksumTimer: ReturnType<typeof setTimeout> | null = null;

const checksumAlgoOptions = checksumOptions;

const isValidHexInput = computed(() => {
  if (!checksumInput.value.trim()) return true;
  return isValidHex(checksumInput.value);
});

const checksumByteCount = computed(() => {
  const cleaned = checksumInput.value.replace(/[^0-9a-fA-F]/g, '');
  return Math.floor(cleaned.length / 2);
});

const checksumAlgoLabel = computed(() =>
  checksumAlgoOptions.find((option) => option.value === checksumAlgo.value)?.label ?? checksumAlgo.value
);

watch([checksumInput, checksumAlgo], () => {
  if (checksumTimer) clearTimeout(checksumTimer);
  checksumResult.value = '';
  if (!checksumInput.value.trim() || !isValidHexInput.value) return;
  checksumTimer = setTimeout(calcChecksum, 150);
});

async function calcChecksum() {
  if (!checksumInput.value || !isValidHexInput.value) return;
  const data = parseHex(checksumInput.value);
  try {
    const res = await invoke<{ result: string }>('calculate_checksum', {
      request: { data, algorithm: checksumAlgo.value },
    });
    checksumResult.value = res.result;
  } catch {
    checksumResult.value = '计算失败';
  }
}

function normalizeChecksumInput() {
  if (checksumInput.value.trim() && isValidHexInput.value) {
    checksumInput.value = formatHex(parseHex(checksumInput.value));
  }
}

async function copyChecksum() {
  if (!checksumResult.value || checksumResult.value === '计算失败') return;
  try {
    await navigator.clipboard.writeText(checksumResult.value);
  } catch {
    // ignore — clipboard may not be available in some environments
  }
}
</script>

<style scoped>
.port-selector {
  display: flex;
  flex-direction: column;
}

.section {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
}

.section-title {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  user-select: none;
  transition: color var(--transition-normal);
}

.section-title:hover {
  color: var(--text-secondary);
}

.toggle-icon {
  font-size: 10px;
  color: var(--text-dim);
  transition: transform var(--transition-normal);
}

.port-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.port-row .n-select {
  flex: 1;
}

.empty-hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  padding: 10px 8px;
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-color);
}

.empty-hint.warning {
  color: var(--accent-red);
  background: var(--accent-red-subtle);
  border-color: rgba(244, 67, 54, 0.35);
}

.config-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.config-item label {
  font-size: 11px;
  color: var(--text-secondary);
  width: 48px;
  flex-shrink: 0;
  text-align: right;
  font-weight: 500;
}

.config-item .n-select {
  flex: 1;
}

.checksum-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checksum-actions {
  display: flex;
}

.checksum-meta {
  display: flex;
  justify-content: space-between;
  min-height: 16px;
  color: var(--text-dim);
  font-size: 10px;
  font-family: var(--font-mono);
}

.checksum-error {
  color: var(--accent-red);
}

.checksum-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--accent-green-subtle);
  border: 1px solid rgba(76, 175, 80, 0.2);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 13px;
  cursor: copy;
}

.checksum-label {
  color: var(--text-muted);
  font-size: 11px;
}

.checksum-value {
  color: var(--accent-green);
  font-weight: 700;
  letter-spacing: 0.8px;
}

.checksum-algo {
  margin-left: 6px;
  color: var(--text-dim);
  font-size: 10px;
}
</style>
