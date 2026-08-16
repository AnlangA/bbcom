<template>
  <div class="send-panel">
    <div class="send-input-row" :class="{ 'send-flash': showFlash }">
      <n-input
        :value="modelValue"
        type="textarea"
        :placeholder="isHex ? t('send.placeholder.hex') : t('send.placeholder.text')"
        :aria-label="isHex ? t('send.placeholder.hex') : t('send.placeholder.text')"
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
        <span class="options-divider" aria-hidden="true"></span>
        <AppSelect
          v-model:value="lineEnding"
          :options="lineEndingOptions"
          :aria-label="t('send.lineEnding.none')"
          size="tiny"
          style="width: 96px"
          :disabled="isHex || looping"
        />
        <AppSelect
          v-model:value="appendChecksum"
          :options="checksumOptions"
          :aria-label="t('checksum.title')"
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
          :title="t('send.loopIntervalHint')"
          :aria-label="t('send.loopIntervalHint')"
        >
          <template #suffix>ms</template>
        </n-input-number>
      </div>
      <div class="send-right">
        <span v-if="modelValue" class="byte-count">{{ byteCount }} {{ t('send.bytes') }}</span>
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
          {{ looping ? t('send.loopStop') : t('send.loop') }}
        </n-button>
        <n-button
          type="primary"
          size="small"
          @click="handleSend"
          :disabled="!canSend"
          class="send-btn"
        >
          <template #icon>
            <SendHorizontal class="icon-sm" />
          </template>
          {{ t('send.button') }}
        </n-button>
      </div>
    </div>
    <ToolsTabs
      v-if="sessionId"
      :session-id="sessionId"
      :model-value="modelValue"
      :is-hex="isHex"
      :disabled="disabled"
      :history="history"
      :quick-commands="quickCommands"
      :on-send="onSend"
      :macro-runner="macroRunner"
      @add-quick-command="emit('addQuickCommand', $event)"
      @remove-quick-command="emit('removeQuickCommand', $event)"
      @clear-history="emit('clearHistory')"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { NInput, NButton, NCheckbox, NInputNumber, useMessage } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { Repeat2, SendHorizontal, SquareStop } from '@lucide/vue';
import { encodeUtf8, isValidHex as checkValidHex, normalizeHex, parseHex } from '../../lib/format';
import { checksumAlgoOptionsWithNone } from '../../lib/checksum-constants';
import { MAX_INPUT_SIZE } from '../../types';
import { useAppStore } from '../../stores/app';
import { useSessionCatalog } from '../../features/sessions';
import { calculateChecksum } from '../../features/native';
import { t } from '../../lib/i18n';
import type { ChecksumType, LineEnding, QuickCommand, SendHistoryEntry } from '../../types';
import type { SessionRuntimeMacroController } from '../../features/sessions/runtime/session-runtime-controller';
import ToolsTabs from './ToolsTabs.vue';

const props = defineProps<{
  onSend: (data: string, isHex: boolean) => Promise<boolean>;
  macroRunner: SessionRuntimeMacroController;
  onStartLoop: (data: string, isHex: boolean) => boolean;
  onStopLoop: () => void;
  looping: boolean;
  modelValue: string;
  disabled?: boolean;
  history: SendHistoryEntry[];
  quickCommands: QuickCommand[];
  sessionId?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'clearHistory'): void;
  (e: 'addQuickCommand', command: { name: string; data: string; isHex: boolean }): void;
  (e: 'removeQuickCommand', id: string): void;
}>();

const appStore = useAppStore();
const catalog = useSessionCatalog();
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
const appendChecksum = ref<'none' | ChecksumType>('none');
const looping = computed(() => props.looping);
const showFlash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const lineEndingOptions = computed(() => [
  { label: t('send.lineEnding.none'), value: 'none' },
  { label: 'CR', value: 'CR' },
  { label: 'LF', value: 'LF' },
  { label: 'CRLF', value: 'CRLF' },
]);

const checksumOptions = computed(() =>
  checksumAlgoOptionsWithNone.map((option) => ({
    ...option,
    label:
      option.value === 'none'
        ? t('checksum.none')
        : option.value === 'CHECKSUM'
          ? t('checksum.checksum')
          : option.label,
  })),
);

const isValidHex = computed(() => {
  if (!isHex.value || !props.modelValue.trim()) return true;
  return checkValidHex(props.modelValue);
});

const byteCount = computed(() => {
  if (!props.modelValue.trim()) return 0;
  if (isHex.value) {
    const cleaned = props.modelValue.replace(/[^0-9a-fA-F]/g, '');
    return Math.floor(cleaned.length / 2);
  }
  return encodeUtf8(withLineEnding(props.modelValue)).length;
});

const canSend = computed(() => {
  if (props.disabled || !props.modelValue.trim()) return false;
  if (isHex.value && !isValidHex.value) return false;
  return true;
});

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && looping.value) props.onStopLoop();
  },
);

watch(
  () => appStore.aiCommandSeq,
  () => {
    if (!appStore.aiCommandDraft) return;
    if (props.sessionId && props.sessionId !== catalog.activeSessionId.value) return;
    if (!catalog.activeSession.value) {
      appStore.setPendingAiCommand(appStore.aiCommandDraft);
      return;
    }
    applyAiCommand(appStore.aiCommandDraft);
  },
);

onUnmounted(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

function withLineEnding(data: string): string {
  if (isHex.value) return data;
  const endings: Record<LineEnding, string> = {
    none: '',
    CR: '\r',
    LF: '\n',
    CRLF: '\r\n',
  };
  return data + endings[lineEnding.value];
}

async function buildData(): Promise<string | null> {
  let data = props.modelValue;

  if (data.length > MAX_INPUT_SIZE) {
    message.error(t('send.error.tooLarge'));
    return null;
  }

  if (isHex.value && appendChecksum.value !== 'none') {
    const payload = parseHex(data);
    try {
      const res = await calculateChecksum(payload, appendChecksum.value);
      data = data + ' ' + res.result;
    } catch {
      message.warning(t('send.error.checksumFailed'));
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
    triggerFlash();
  } else {
    message.error(t('send.error.failed'));
  }
}

function triggerFlash() {
  showFlash.value = true;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    showFlash.value = false;
  }, 300);
}

function toggleLoop() {
  if (looping.value) {
    props.onStopLoop();
  } else {
    void startLoop();
  }
}

async function startLoop() {
  if (!canSend.value || looping.value) return;
  const data = await buildData();
  if (data !== null) props.onStartLoop(data, isHex.value);
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
  gap: var(--space-sm);
  background: var(--bg-secondary);
}

.send-input-row {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
  padding: 1px;
  position: relative;
  overflow: hidden;
  transition:
    border-color var(--transition-normal),
    box-shadow var(--transition-normal);
}

.send-input-row:focus-within {
  border-color: var(--color-primary-muted);
  box-shadow: var(--shadow-focus);
}

.send-input-row.send-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--color-primary-subtle), transparent);
  animation: send-flash 300ms ease;
  pointer-events: none;
}

.send-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-md);
  flex-wrap: wrap;
}

.send-left {
  display: flex;
  gap: var(--space-sm);
  align-items: center;
  flex-wrap: wrap;
}

.options-divider {
  width: 1px;
  height: 18px;
  background: var(--border-color);
  flex-shrink: 0;
}

.send-right {
  display: flex;
  gap: var(--space-sm);
  align-items: center;
  margin-left: auto;
}

.send-btn:active {
  transform: scale(0.95);
}

.byte-count {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  font-family: var(--font-mono);
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
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
