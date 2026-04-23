<template>
  <div class="send-panel">
    <div class="send-input-row">
      <n-input
        v-model:value="input"
        type="textarea"
        :placeholder="isHex ? '输入 HEX (如: AA BB CC DD)' : '输入文本内容'"
        :autosize="{ minRows: 2, maxRows: 4 }"
        :disabled="disabled"
        :status="isHex && input && !isValidHex ? 'error' : undefined"
        @keydown.ctrl.enter="handleSend"
      />
    </div>
    <div class="send-actions">
      <div class="send-left">
        <n-checkbox v-model:checked="isHex" size="small">HEX</n-checkbox>
        <n-checkbox v-model:checked="appendNewline" size="small" :disabled="isHex">
          追加换行
        </n-checkbox>
        <n-select
          v-model:value="appendChecksum"
          :options="checksumOptions"
          size="tiny"
          style="width: 100px"
          :disabled="!isHex"
        />
      </div>
      <div class="send-right">
        <span v-if="isHex && input" class="byte-count">{{ byteCount }} 字节</span>
        <n-button
          type="primary"
          size="small"
          @click="handleSend"
          :disabled="!canSend"
        >
          发送
        </n-button>
      </div>
    </div>
    <div v-if="history.length > 0" class="send-history">
      <div class="history-header">
        <span class="history-title">历史记录</span>
        <button class="history-clear" @click="emit('clearHistory')">清除</button>
      </div>
      <div class="history-list">
        <div
          v-for="(item, i) in history"
          :key="i"
          class="history-item"
          @click="resend(item)"
          :title="item.data"
        >
          <span class="history-tag">{{ item.isHex ? 'HEX' : 'TXT' }}</span>
          <span class="history-text">{{ truncate(item.data, 40) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { NInput, NButton, NCheckbox, NSelect, useMessage } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { isValidHex as checkValidHex } from '../../lib/hex';

export interface HistoryEntry {
  data: string;
  isHex: boolean;
}

const props = defineProps<{
  onSend: (data: string, isHex: boolean) => Promise<boolean>;
  disabled?: boolean;
  history: HistoryEntry[];
}>();

const emit = defineEmits<{
  (e: 'clearHistory'): void;
}>();

const message = useMessage();
const input = ref('');
const isHex = ref(false);
const appendNewline = ref(false);
const appendChecksum = ref<'none' | 'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC32'>('none');

const checksumOptions = [
  { label: '无校验', value: 'none' },
  { label: 'Checksum', value: 'CHECKSUM' },
  { label: 'CRC-8', value: 'CRC8' },
  { label: 'CRC-16', value: 'CRC16' },
  { label: 'CRC-32', value: 'CRC32' },
];

const isValidHex = computed(() => {
  if (!isHex.value || !input.value.trim()) return true;
  return checkValidHex(input.value);
});

const byteCount = computed(() => {
  if (!isHex.value || !input.value.trim()) return 0;
  const cleaned = input.value.replace(/[^0-9a-fA-F]/g, '');
  return Math.floor(cleaned.length / 2);
});

const canSend = computed(() => {
  if (props.disabled || !input.value.trim()) return false;
  if (isHex.value && !isValidHex.value) return false;
  return true;
});

async function handleSend() {
  if (!canSend.value) return;

  let data = input.value;

  if (isHex.value && appendChecksum.value !== 'none') {
    const cleaned = data.replace(/[^0-9a-fA-F]/g, '');
    const payload: number[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      payload.push(parseInt(cleaned.substring(i, i + 2), 16));
    }
    try {
      const res = await invoke<{ result: string }>('calculate_checksum', {
        request: { data: payload, algorithm: appendChecksum.value },
      });
      data = data + ' ' + res.result;
    } catch {
      // proceed without checksum
    }
  } else if (!isHex.value && appendNewline.value) {
    data += '\r\n';
  }

  const ok = await props.onSend(data, isHex.value);
  if (ok) {
    input.value = '';
  } else {
    message.error('发送失败');
  }
}

function resend(item: HistoryEntry) {
  if (props.disabled) return;
  props.onSend(item.data, item.isHex).then((ok) => {
    if (!ok) {
      message.error('重发失败');
    }
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}
</script>

<style scoped>
.send-panel {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-secondary);
}

.send-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.send-left {
  display: flex;
  gap: 12px;
  align-items: center;
}

.send-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

.byte-count {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  padding: 2px 6px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
}

.send-history {
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.history-title {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.history-clear {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 10px;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.history-clear:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.history-list {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  max-height: 60px;
  flex-wrap: wrap;
}

.history-list::-webkit-scrollbar {
  height: 3px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  max-width: 200px;
  transition: border-color var(--transition-normal), background var(--transition-normal);
}

.history-item:hover {
  border-color: var(--accent-green);
  background: var(--accent-green-subtle);
}

.history-tag {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 0 4px;
  border-radius: 2px;
  letter-spacing: 0.3px;
}

.history-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
