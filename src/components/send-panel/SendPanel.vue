<template>
  <div class="send-panel">
    <div class="send-input-row" :class="{ 'send-flash': showFlash }">
      <n-input
        :value="modelValue"
        type="textarea"
        :placeholder="isHex ? t('send.placeholder.hex') : t('send.placeholder.text')"
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
    <div class="collapsible-section">
      <button class="section-toggle" type="button" @click="quickExpanded = !quickExpanded">
        <span class="toggle-label">
          <BookmarkPlus class="icon-sm" />
          {{ t('send.quickCommands') }}
        </span>
        <ChevronRight class="toggle-icon" :class="{ expanded: quickExpanded }" />
      </button>
      <div class="section-body" :class="{ collapsed: !quickExpanded }">
        <div class="quick-row">
          <div class="quick-form">
            <n-input
              v-model:value="quickName"
              size="tiny"
              :placeholder="t('send.quickName')"
              style="width: 110px"
            />
            <n-button size="tiny" @click="addQuickCommand" :disabled="!modelValue.trim()">
              <template #icon>
                <BookmarkPlus class="icon-sm" />
              </template>
              {{ t('send.saveQuick') }}
            </n-button>
          </div>
          <div v-if="quickCommands.length > 0" class="quick-list">
            <div
              v-for="cmd in quickCommands"
              :key="cmd.id"
              class="quick-item"
              :title="cmd.data"
              @click="sendQuick(cmd)"
            >
              <span class="history-tag">{{ cmd.isHex ? 'HEX' : 'TXT' }}</span>
              <span>{{ cmd.name }}</span>
              <button
                class="quick-remove"
                type="button"
                @click.stop="emit('removeQuickCommand', cmd.id)"
                :title="t('send.deleteQuick')"
              >
                <X class="icon-sm" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <MacroPanel v-if="sessionId" :session-id="sessionId" :send="onSend" :disabled="disabled" />
    <TriggerPanel v-if="sessionId" :session-id="sessionId" />
    <HighlightPanel v-if="sessionId" :session-id="sessionId" />
    <div v-if="history.length > 0" class="collapsible-section">
      <button class="section-toggle" type="button" @click="historyExpanded = !historyExpanded">
        <span class="toggle-label">
          <HistoryIcon class="icon-sm" />
          {{ t('send.history') }}
        </span>
        <div class="toggle-right">
          <button class="history-clear" type="button" @click.stop="emit('clearHistory')">
            <Trash2 class="icon-sm" />
            {{ t('send.clearHistory') }}
          </button>
          <ChevronRight class="toggle-icon" :class="{ expanded: historyExpanded }" />
        </div>
      </button>
      <div class="section-body" :class="{ collapsed: !historyExpanded }">
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { NInput, NButton, NCheckbox, NSelect, NInputNumber, useMessage } from 'naive-ui';
import {
  BookmarkPlus,
  ChevronRight,
  History as HistoryIcon,
  Repeat2,
  SendHorizontal,
  SquareStop,
  Trash2,
  X,
} from 'lucide-vue-next';
import {
  encodeUtf8,
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
import { t } from '../../lib/i18n';
import type { ChecksumType, LineEnding, QuickCommand, SendHistoryEntry } from '../../types';
import MacroPanel from './MacroPanel.vue';
import TriggerPanel from './TriggerPanel.vue';
import HighlightPanel from './HighlightPanel.vue';

const props = defineProps<{
  onSend: (data: string, isHex: boolean) => Promise<boolean>;
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
const appendChecksum = ref<'none' | ChecksumType>('none');
const looping = ref(false);
const quickName = ref('');
const quickExpanded = ref(true);
const historyExpanded = ref(false);
const showFlash = ref(false);
let loopTimer: ReturnType<typeof setInterval> | null = null;
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
      message.error(t('send.error.resendFailed'));
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
    if (!ok) message.error(t('send.error.quickFailed'));
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

.collapsible-section {
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}

.section-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
  cursor: pointer;
  margin-bottom: 6px;
  transition: color var(--transition-fast);
}

.section-toggle:hover {
  color: var(--text-secondary);
}

.toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toggle-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-icon {
  width: 12px;
  height: 12px;
  color: var(--text-dim);
  transition: transform var(--transition-normal);
}

.toggle-icon.expanded {
  transform: rotate(90deg);
}

.section-body {
  overflow: hidden;
  max-height: 200px;
  opacity: 1;
  transition:
    max-height var(--transition-slow),
    opacity var(--transition-normal);
}

.section-body.collapsed {
  max-height: 0;
  opacity: 0;
}

.quick-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-height: 24px;
  flex-wrap: wrap;
}

.quick-form,
.quick-list,
.quick-item {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
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
    background var(--transition-fast),
    transform var(--transition-fast);
}

.quick-item:hover {
  border-color: var(--accent-green);
  background: var(--accent-green-subtle);
  transform: translateY(-1px);
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
  background: var(--bg-hover);
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
  overflow-x: auto;
  max-height: 64px;
  flex-wrap: wrap;
}

.history-list::-webkit-scrollbar {
  height: 3px;
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
    background var(--transition-normal),
    transform var(--transition-fast);
}

.history-item:hover {
  border-color: var(--accent-green);
  background: var(--accent-green-subtle);
  transform: translateY(-1px);
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
