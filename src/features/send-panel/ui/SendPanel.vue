<template>
  <div class="send-panel">
    <div class="send-composer" :class="{ 'send-flash': showFlash, 'is-looping': looping }">
      <div class="composer-heading">
        <span class="composer-title">
          <SendHorizontal class="icon-sm" aria-hidden="true" />
          {{ t('send.title') }}
        </span>
        <div class="composer-meta">
          <span v-if="looping" class="loop-state">
            <span class="loop-dot" aria-hidden="true"></span>
            {{ t('send.loop') }}
          </span>
          <span class="byte-count">{{ byteCount }} {{ t('send.bytes') }}</span>
        </div>
      </div>
      <n-input
        :value="modelValue"
        type="textarea"
        class="send-input"
        :placeholder="isHex ? t('send.placeholder.hex') : t('send.placeholder.text')"
        :aria-label="isHex ? t('send.placeholder.hex') : t('send.placeholder.text')"
        :autosize="{ minRows: 2, maxRows: 4 }"
        :bordered="false"
        :disabled="disabled"
        :status="isHex && modelValue && !isValidHex ? 'error' : undefined"
        @update:value="updateInput"
        @blur="formatHexInput"
        @keydown="handleInputKeydown"
      />
      <div v-if="isHex && modelValue && !isValidHex" class="input-error" role="status">
        <CircleAlert class="icon-sm" aria-hidden="true" />
        {{ t('send.error.invalidHex') }}
      </div>
      <div class="send-footer">
        <SendOptions
          v-model:is-hex="isHex"
          v-model:line-ending="lineEnding"
          v-model:checksum="appendChecksum"
          v-model:loop-interval="loopInterval"
          :disabled="looping || pending !== null"
        />
        <div class="send-actions">
          <n-button
            size="small"
            :disabled="!canSend && !looping"
            :loading="pending === 'loop'"
            :type="looping ? 'warning' : 'default'"
            @click="toggleLoop"
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
            :disabled="!canSend"
            :loading="pending === 'send'"
            class="send-btn"
            :title="`${t('send.button')} (Ctrl / ⌘ + Enter)`"
            @click="handleSend"
          >
            <template #icon><SendHorizontal class="icon-sm" /></template>
            {{ t('send.button') }}
            <kbd class="send-shortcut" aria-hidden="true">↵</kbd>
          </n-button>
        </div>
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
import { NInput, NButton, useMessage } from 'naive-ui';
import { CircleAlert, Repeat2, SendHorizontal, SquareStop } from '@lucide/vue';
import { normalizeHex } from '@/lib/format';
import { useAppStore } from '@/features/settings/store/app-store';
import { useSessionCatalog } from '@/features/sessions';
import { calculateChecksum } from '@/features/platform/native';
import { t } from '@/lib/i18n';
import type { ChecksumType, LineEnding, QuickCommand, SendHistoryEntry } from '@/types';
import type { SessionRuntimeMacroController } from '@/features/sessions/runtime/session-runtime-controller';
import { useSendComposer } from '../application/use-send-composer';
import SendOptions from './SendOptions.vue';
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
  set: (value: number) => appStore.setLoopIntervalMs(value),
});
const appendChecksum = ref<'none' | ChecksumType>('none');
const showFlash = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const {
  pending,
  validHex: isValidHex,
  byteCount,
  canSend,
  send: handleSend,
  toggleLoop,
} = useSendComposer({
  getState: () => ({
    input: props.modelValue,
    isHex: isHex.value,
    lineEnding: lineEnding.value,
    checksum: appendChecksum.value,
    disabled: props.disabled,
    looping: props.looping,
    sessionId: props.sessionId,
  }),
  calculateChecksum,
  send: (data, hex) => props.onSend(data, hex),
  startLoop: (data, hex) => props.onStartLoop(data, hex),
  stopLoop: () => props.onStopLoop(),
  updateInput,
  onSent: triggerFlash,
  onError: (key) => message.error(t(key)),
  onWarning: (key) => message.warning(t(key)),
});

watch(
  () => appStore.aiCommandSeq,
  () => {
    if (!appStore.aiCommandDraft) return;
    if (props.sessionId && props.sessionId !== catalog.activeSessionId.value) return;
    if (!catalog.activeSession.value) {
      appStore.setPendingAiCommand(appStore.aiCommandDraft);
      return;
    }
    isHex.value = false;
    updateInput(appStore.aiCommandDraft);
  },
);

onUnmounted(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

function triggerFlash() {
  showFlash.value = true;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    showFlash.value = false;
  }, 300);
}

function updateInput(value: string) {
  emit('update:modelValue', value);
}

function formatHexInput() {
  if (isHex.value && props.modelValue.trim() && isValidHex.value) {
    updateInput(normalizeHex(props.modelValue));
  }
}

function handleInputKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.isComposing) return;
  event.preventDefault();
  void handleSend();
}
</script>

<style scoped>
.send-panel {
  container: send-panel / inline-size;
  min-width: 0;
  padding: var(--space-md) var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  background: var(--bg-secondary);
}

.send-composer {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-primary);
  position: relative;
  overflow: hidden;
  transition:
    border-color var(--transition-normal),
    box-shadow var(--transition-normal);
}

.send-composer:focus-within {
  border-color: var(--color-primary-muted);
  box-shadow: var(--shadow-focus);
}

.send-composer.is-looping {
  border-color: var(--accent-amber-border);
}

.composer-heading,
.composer-title,
.composer-meta,
.loop-state,
.send-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.composer-heading {
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md) var(--space-2xs);
  font-size: var(--font-size-data);
}

.composer-title {
  color: var(--text-secondary);
  font-weight: var(--font-weight-semibold);
}

.composer-title > svg {
  color: var(--color-primary);
}

.byte-count {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.loop-state {
  color: var(--color-warning);
  font-size: var(--font-size-sm);
}

.loop-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.send-input {
  --n-color: transparent !important;
  --n-color-focus: transparent !important;
  font-family: var(--font-mono);
}

.input-error {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 0 var(--space-md) var(--space-sm);
  font-size: var(--font-size-data);
  color: var(--color-error);
}

.send-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
  padding: var(--space-sm) var(--space-md);
  border-top: 1px solid var(--border-subtle);
  background: var(--surface-lift);
}

.send-actions {
  margin-left: auto;
  flex-shrink: 0;
}

.send-btn {
  min-width: 86px;
}

.send-shortcut {
  margin-left: var(--space-sm);
  font-family: var(--font-mono);
  opacity: 0.6;
}

.send-composer.send-flash::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--color-primary-subtle), transparent);
  animation: send-flash 300ms ease;
  pointer-events: none;
}

@container send-panel (max-width: 620px) {
  .send-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
