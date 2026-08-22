<template>
  <div class="ai-assistant" :aria-busy="loading">
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ loading ? t('ai.terminal.generate') : (result?.explanation ?? '') }}
    </span>
    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? t('ai.terminal.placeholder') : t('ai.needApiKey')"
        :aria-label="t('ai.terminal.placeholder')"
        :disabled="loading"
        @keydown.enter.prevent="generateCommand"
      />
      <n-button
        v-if="loading"
        size="small"
        :loading="cancelling"
        :aria-label="t('common.cancel')"
        @click="cancelRequest"
      >
        {{ t('common.cancel') }}
      </n-button>
      <n-button
        size="small"
        type="primary"
        :loading="loading"
        :disabled="!canGenerate"
        @click="generateCommand"
      >
        <template #icon>
          <WandSparkles class="icon-sm" />
        </template>
        {{ t('ai.terminal.generate') }}
      </n-button>
    </div>

    <div v-if="activeSession" class="settings-panel">
      <span class="field-label">
        <Terminal class="icon-sm" />
        {{ t('ai.terminal.model') }}
      </span>
      <AppSelect
        size="small"
        :value="activeSession.terminalAiModel"
        :aria-label="t('ai.terminal.model')"
        :options="aiModelOptions"
        @update:value="setTerminalModel"
      />
    </div>

    <div v-if="result" class="result-row" :class="`risk-${result.risk}`">
      <div class="result-main">
        <div class="result-meta">
          <n-tag size="small" round :type="riskTagType" :bordered="false">{{ riskLabel }}</n-tag>
          <span class="explanation">{{ result.explanation }}</span>
        </div>
        <code class="command">{{ result.command || t('ai.terminal.moreInfo') }}</code>
      </div>
      <div class="result-actions">
        <n-button size="tiny" secondary @click="copyCommand" :disabled="!result.command">
          <template #icon>
            <Copy class="icon-sm" />
          </template>
          {{ t('ai.terminal.copy') }}
        </n-button>
        <n-button size="tiny" type="primary" @click="applyCommand" :disabled="!result.command">
          <template #icon>
            <SendHorizontal class="icon-sm" />
          </template>
          {{ t('ai.terminal.apply') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NInput, NTag, useMessage } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { Copy, SendHorizontal, Terminal, WandSparkles } from '@lucide/vue';
import { useAppStore } from '@/features/settings/store/app-store';
import { getAiErrorMessage } from '@/lib/ai-error';
import type { TerminalAiResponse } from '@/features/platform/native';
import { logger } from '@/lib/logger';
import { t } from '@/lib/i18n';
import type { AiModel, AiWindowSession } from '@/types';
import type {
  AiWindowRequestBinding,
  useAiWindowSession,
} from '@/features/ai/application/use-ai-window-session';
import { aiModelOptions, aiRiskLabel, aiRiskTagType } from '@/features/ai/ui/ai-options';

const props = defineProps<{
  session: AiWindowSession;
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const cancelling = ref(false);
const cancelRequested = ref(false);
const activeRequestId = ref<string | null>(null);
const result = ref<TerminalAiResponse | null>(null);
const resultBinding = ref<AiWindowRequestBinding | null>(null);
const appliedRequestId = ref<string | null>(null);

const activeSession = computed(() => props.session);
const hasApiKey = computed(() => appStore.aiKeyConfigured);
const canGenerate = computed(() => prompt.value.trim().length > 0 && !loading.value);
const riskLabel = computed(() => (result.value ? aiRiskLabel(result.value.risk) : ''));
const riskTagType = computed(() => (result.value ? aiRiskTagType(result.value.risk) : 'default'));

watch(
  () => [props.bridge.workspaceId.value, props.session.id, props.bridge.revision.value] as const,
  () => {
    result.value = null;
    resultBinding.value = null;
  },
);

// The main window rejects stale command-apply envelopes with a receipt; tell
// the user instead of leaving the press silently ignored.
watch(
  () => props.bridge.lastCommandRejection?.value,
  (rejection) => {
    if (!rejection || rejection.requestId !== appliedRequestId.value) return;
    appliedRequestId.value = null;
    result.value = null;
    resultBinding.value = null;
    message.warning(t('ai.terminal.commandStale'));
  },
);

async function generateCommand() {
  if (!canGenerate.value) return;
  if (!hasApiKey.value) {
    message.warning(t('ai.needApiKey'));
    return;
  }
  if (!activeSession.value) {
    message.warning(t('ai.needSession'));
    return;
  }
  loading.value = true;
  cancelRequested.value = false;
  result.value = null;
  resultBinding.value = null;
  const binding = props.bridge.createRequestBinding();
  if (!binding) {
    loading.value = false;
    message.warning(t('ai.needSession'));
    return;
  }
  activeRequestId.value = binding.requestId;
  try {
    const activity = await props.bridge.runRequest(
      {
        requestId: binding.requestId,
        kind: 'terminal',
        prompt: prompt.value.trim(),
        model: activeSession.value.terminalAiModel,
        shell: 'linux/busybox',
      },
      binding,
    );
    const response = activity.result;
    if (response.kind !== 'terminal') throw new Error('unexpected AI response kind');
    if (
      props.bridge.isBindingCurrent(binding) &&
      props.bridge.revision.value === binding.revision
    ) {
      result.value = response;
      resultBinding.value = binding;
    }
  } catch (e: unknown) {
    if (!cancelRequested.value) message.error(getAiErrorMessage(e, t('ai.terminal.failed')));
  } finally {
    if (activeRequestId.value === binding.requestId) activeRequestId.value = null;
    cancelling.value = false;
    cancelRequested.value = false;
    loading.value = false;
  }
}

async function cancelRequest() {
  const requestId = activeRequestId.value;
  if (!requestId || cancelling.value) return;
  cancelRequested.value = true;
  cancelling.value = true;
  try {
    await props.bridge.cancelRequest(requestId);
  } finally {
    cancelling.value = false;
  }
}

async function copyCommand() {
  if (!result.value?.command) return;
  try {
    await navigator.clipboard.writeText(result.value.command);
    message.success(t('ai.terminal.copied'));
  } catch (e) {
    logger.warn('clipboard write failed:', e);
    message.error(t('packet.copyFailed'));
  }
}

function applyCommand() {
  const binding = resultBinding.value;
  if (
    !result.value?.command ||
    !binding ||
    !props.bridge.isBindingCurrent(binding) ||
    props.bridge.revision.value !== binding.revision
  ) {
    result.value = null;
    resultBinding.value = null;
    return;
  }
  applyCommandToApp(result.value.command, binding);
}

function applyCommandToApp(command: string, binding: AiWindowRequestBinding) {
  void props.bridge.applyCommand(command, binding).then((requestId) => {
    appliedRequestId.value = requestId;
  });
}

function setTerminalModel(model: AiModel) {
  void props.bridge.setTerminalAiModel(model);
}
</script>

<style scoped>
.ai-assistant {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-row,
.settings-panel,
.result-row,
.result-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-row .n-input,
.settings-panel .n-select {
  flex: 1;
  min-width: 0;
}

.settings-panel {
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-lift);
  box-shadow: var(--shadow-inset);
}

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-weight: 700;
  white-space: nowrap;
}

.result-row {
  align-items: stretch;
  min-height: 48px;
  padding: 9px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  box-shadow: var(--shadow-inset);
}

.result-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.command {
  color: var(--accent-green);
  font-family: var(--font-mono);
  font-size: var(--font-size-data);
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  word-break: break-all;
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
}

.explanation {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow-y: auto;
  min-width: 0;
  flex: 1;
}

.result-actions {
  align-self: flex-end;
  flex-shrink: 0;
}

.risk-dangerous {
  border-color: var(--accent-red-border);
  background: var(--accent-red-subtle);
}

.risk-caution {
  border-color: var(--accent-amber-border);
  background: var(--accent-amber-subtle);
}
</style>
