<template>
  <div class="send-panel">
    <div class="send-input-row">
      <n-input
        :value="modelValue"
        type="textarea"
        :placeholder="isHex ? '输入 HEX (如: AA BB CC DD)' : '输入文本内容'"
        :autosize="{ minRows: 2, maxRows: 4 }"
        :disabled="disabled"
        :status="isHex && modelValue && !isValidHex ? 'error' : undefined"
        @update:value="updateInput"
        @blur="formatHexInput"
        @keydown.ctrl.enter="handleSend"
      />
    </div>
    <div class="send-actions">
      <div class="send-left">
        <n-checkbox v-model:checked="isHex" size="small" :disabled="looping">HEX</n-checkbox>
        <n-select
          v-model:value="lineEnding"
          :options="lineEndingOptions"
          size="tiny"
          style="width: 96px"
          :disabled="isHex || looping"
        />
        <n-select
          v-model:value="appendChecksum"
          :options="checksumOptions"
          size="tiny"
          style="width: 100px"
          :disabled="!isHex || looping"
        />
        <n-input-number
          v-model:value="loopInterval"
          size="tiny"
          :min="50"
          :max="3600000"
          :step="100"
          style="width: 112px"
          :disabled="looping"
        >
          <template #suffix>ms</template>
        </n-input-number>
      </div>
      <div class="send-right">
        <span v-if="modelValue" class="byte-count">{{ byteCount }} 字节</span>
        <n-button
          size="small"
          @click="toggleLoop"
          :disabled="!canSend && !looping"
          :type="looping ? 'warning' : 'default'"
        >
          <template #icon>
            <SquareStop v-if="looping" class="icon-sm" />
            <Repeat2 v-else class="icon-sm" />
          </template>
          {{ looping ? '停止循环' : '循环发送' }}
        </n-button>
        <n-button type="primary" size="small" @click="handleSend" :disabled="!canSend">
          <template #icon>
            <SendHorizontal class="icon-sm" />
          </template>
          发送
        </n-button>
      </div>
    </div>
    <div class="quick-row">
      <div class="quick-form">
        <n-input
          v-model:value="quickName"
          size="tiny"
          placeholder="快捷名称"
          style="width: 110px"
        />
        <n-button size="tiny" @click="addQuickCommand" :disabled="!modelValue.trim()">
          <template #icon>
            <BookmarkPlus class="icon-sm" />
          </template>
          保存快捷
        </n-button>
      </div>
      <div v-if="quickCommands.length > 0" class="quick-list">
        <div
          v-for="cmd in quickCommands"
          :key="cmd.id"
          class="quick-item"
          role="button"
          :tabindex="disabled ? -1 : 0"
          :aria-label="`发送快捷命令 ${cmd.name}`"
          :title="cmd.data"
          @click="sendQuick(cmd)"
          @keydown.enter="sendQuick(cmd)"
          @keydown.space.prevent="sendQuick(cmd)"
        >
          <span class="history-tag">{{ cmd.isHex ? 'HEX' : 'TXT' }}</span>
          <span>{{ cmd.name }}</span>
          <button
            class="quick-remove"
            type="button"
            @click.stop="emit('removeQuickCommand', cmd.id)"
            title="删除快捷命令"
          >
            <X class="icon-sm" />
          </button>
        </div>
      </div>
    </div>
    <div v-if="history.length > 0" class="send-history">
      <div class="history-header">
        <span class="history-title">
          <HistoryIcon class="icon-sm" />
          历史记录
        </span>
        <button class="history-clear" type="button" @click="emit('clearHistory')">
          <Trash2 class="icon-sm" />
          清除
        </button>
      </div>
      <div class="history-list">
        <div
          v-for="(item, i) in history"
          :key="i"
          class="history-item"
          role="button"
          :tabindex="disabled ? -1 : 0"
          :aria-label="`重发 ${item.data}`"
          @click="resend(item)"
          @keydown.enter="resend(item)"
          @keydown.space.prevent="resend(item)"
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
import { ref, computed, watch, onUnmounted } from 'vue';
import { NInput, NButton, NCheckbox, NSelect, NInputNumber, useMessage } from 'naive-ui';
import {
  BookmarkPlus,
  History as HistoryIcon,
  Repeat2,
  SendHorizontal,
  SquareStop,
  Trash2,
  X,
} from 'lucide-vue-next';
import {
  appendLineEnding,
  computeSendByteCount,
  isValidHex as checkValidHex,
  normalizeHex,
  parseHex,
  truncate,
} from '../../lib/format';
import { checksumAlgoOptionsWithNone } from '../../lib/checksum-constants';
import { MAX_INPUT_SIZE } from '../../types';
import { useAppStore } from '../../stores/app';
import { useSessionStore } from '../../stores/sessions';
import { calculateChecksum } from '../../lib/ipc';
import type { ChecksumType, LineEnding, QuickCommand, SendHistoryEntry } from '../../types';

const props = defineProps<{
  onSend: (data: string, isHex: boolean) => Promise<boolean>;
  modelValue: string;
  disabled?: boolean;
  history: SendHistoryEntry[];
  quickCommands: QuickCommand[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'clearHistory'): void;
  (e: 'addQuickCommand', command: { name: string; data: string; isHex: boolean }): void;
  (e: 'removeQuickCommand', id: string): void;
}>();

const appStore = useAppStore();
const sessionStore = useSessionStore();
const message = useMessage();
const isHex = computed({
  get: () => appStore.sendAsHex,
  set: (value) => appStore.setSendAsHex(value),
});
const lineEnding = computed({
  get: () => appStore.lineEnding,
  set: (value: LineEnding) => appStore.setLineEnding(value),
});
const loopInterval = computed({
  get: () => appStore.loopIntervalMs,
  set: (value) => appStore.setLoopIntervalMs(value ?? 1000),
});
const appendChecksum = computed({
  get: () => appStore.appendChecksum,
  set: (value: 'none' | ChecksumType) => {
    appStore.appendChecksum = value;
  },
});
const looping = ref(false);
const quickName = ref('');
let loopTimer: ReturnType<typeof setInterval> | null = null;

const lineEndingOptions = [
  { label: '无结尾', value: 'none' },
  { label: 'CR', value: 'CR' },
  { label: 'LF', value: 'LF' },
  { label: 'CRLF', value: 'CRLF' },
];

const checksumOptions = checksumAlgoOptionsWithNone;

const isValidHex = computed(() => {
  if (!isHex.value || !props.modelValue.trim()) return true;
  return checkValidHex(props.modelValue);
});

const byteCount = computed(() =>
  computeSendByteCount(props.modelValue, isHex.value, appendChecksum.value, lineEnding.value),
);

const canSend = computed(() => {
  if (props.disabled || !props.modelValue.trim()) return false;
  if (isHex.value && !isValidHex.value) return false;
  // Disable (and block the loop from starting) when the payload exceeds the
  // send limit — otherwise a loop would spam the "too large" error every tick.
  if (byteCount.value > MAX_INPUT_SIZE) return false;
  return true;
});

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && looping.value) stopLoop();
  },
);

watch(
  () => appStore.aiCommandSeq,
  () => {
    if (!appStore.aiCommandDraft) return;
    if (!sessionStore.activeSession) {
      appStore.setPendingAiCommand(appStore.aiCommandDraft);
      return;
    }
    applyAiCommand(appStore.aiCommandDraft);
  },
);

onUnmounted(() => {
  stopLoop();
});

function withLineEnding(data: string): string {
  if (isHex.value) return data;
  return appendLineEnding(data, lineEnding.value);
}

async function buildData(): Promise<string | null> {
  let data = props.modelValue;

  // byteCount is byte-accurate (hex bytes incl. checksum, or UTF-8 bytes incl.
  // line ending), matching what send() actually writes — checking the raw
  // string length would falsely cap HEX at ~1/3 of the real limit.
  if (byteCount.value > MAX_INPUT_SIZE) {
    message.error('输入数据过大，最大支持 1MB');
    return null;
  }

  if (isHex.value && appendChecksum.value !== 'none') {
    const payload = parseHex(data);
    try {
      const res = await calculateChecksum(payload, appendChecksum.value);
      data = data + ' ' + res.result;
    } catch {
      message.warning('校验和计算失败，将发送原始数据');
    }
  } else if (!isHex.value) {
    data = withLineEnding(data);
  }
  return data;
}

async function handleSend() {
  if (!canSend.value) return;

  const data = await buildData();
  if (data === null) return;
  const ok = await props.onSend(data, isHex.value);
  if (ok) {
    if (!looping.value) updateInput('');
  } else {
    message.error('发送失败，请检查连接状态');
  }
}

function toggleLoop() {
  if (looping.value) {
    stopLoop();
  } else {
    startLoop();
  }
}

function startLoop() {
  if (!canSend.value || loopTimer) return;
  looping.value = true;
  handleSend();
  loopTimer = setInterval(handleSend, loopInterval.value);
}

function stopLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  looping.value = false;
}

function resend(item: SendHistoryEntry) {
  if (props.disabled) return;
  props.onSend(item.data, item.isHex).then((ok) => {
    if (!ok) {
      message.error('重发失败，请检查连接状态');
    }
  });
}

function addQuickCommand() {
  const name = quickName.value.trim() || truncate(props.modelValue, 12);
  emit('addQuickCommand', { name, data: props.modelValue, isHex: isHex.value });
  quickName.value = '';
}

function sendQuick(command: QuickCommand) {
  if (props.disabled) return;
  props.onSend(command.data, command.isHex).then((ok) => {
    if (!ok) message.error('快捷发送失败，请检查连接状态');
  });
}

function applyAiCommand(command: string) {
  isHex.value = false;
  updateInput(command);
}

function updateInput(value: string) {
  emit('update:modelValue', value);
}

function formatHexInput() {
  if (isHex.value && props.modelValue.trim() && isValidHex.value) {
    updateInput(normalizeHex(props.modelValue));
  }
}
</script>

<style scoped>
.send-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  background: var(--bg-secondary);
}

.send-input-row {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
  padding: 1px;
}

.send-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.send-left {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}

.send-right {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-left: auto;
}

.quick-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 24px;
  flex-wrap: wrap;
}

.quick-form,
.quick-list,
.quick-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.quick-list {
  flex-wrap: wrap;
}

.quick-item {
  min-height: 26px;
  padding: 3px 7px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.quick-item:hover {
  border-color: var(--accent-green);
  background: var(--accent-green-subtle);
}

.quick-item:focus-visible,
.history-item:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.quick-remove {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-full);
}

.quick-remove:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.08);
}

.byte-count {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0;
  font-weight: 600;
}

.history-clear {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.history-clear:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.history-list {
  display: flex;
  gap: 4px;
  overflow-y: auto;
  max-height: 64px;
  flex-wrap: wrap;
  align-content: flex-start;
}

.history-list::-webkit-scrollbar {
  width: 3px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 3px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  max-width: 200px;
  transition:
    border-color var(--transition-normal),
    background var(--transition-normal);
}

.history-item:hover {
  border-color: var(--accent-green);
  background: var(--accent-green-subtle);
}

.history-tag {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-inset);
  padding: 1px 5px;
  border-radius: var(--radius-full);
  letter-spacing: 0;
}

.history-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 760px) {
  .send-left,
  .send-right {
    width: 100%;
  }

  .send-right {
    justify-content: flex-end;
    margin-left: 0;
  }
}
</style>
