<template>
  <div class="ai-assistant">
    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? t('ai.terminal.placeholder') : t('ai.needApiKey')"
        :disabled="loading"
        @keydown.enter.prevent="generateCommand"
      />
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
      <n-select
        size="small"
        :value="activeSession.terminalAiModel"
        :options="aiModelOptions"
        :menu-props="aiModelMenuProps"
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
import { computed, ref } from 'vue';
import { NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import { Copy, SendHorizontal, Terminal, WandSparkles } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import { getAiErrorMessage } from '../../lib/ai-error';
import { terminalAiAssist, type TerminalAiResponse } from '../../lib/ipc';
import { logger } from '../../lib/logger';
import { t } from '../../lib/i18n';
import type { AiModel, SerialSession } from '../../types';
import type { useAiWindowSession } from '../../composables/useAiWindowSession';
import { aiModelMenuProps, aiModelOptions, aiRiskLabel, aiRiskTagType } from '../ai/ai-options';

const props = defineProps<{
  session: SerialSession;
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const result = ref<TerminalAiResponse | null>(null);

const activeSession = computed(() => props.session);
const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canGenerate = computed(() => prompt.value.trim().length > 0 && !loading.value);
const riskLabel = computed(() => (result.value ? aiRiskLabel(result.value.risk) : ''));
const riskTagType = computed(() => (result.value ? aiRiskTagType(result.value.risk) : 'default'));

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
  result.value = null;
  try {
    const response = await terminalAiAssist({
      prompt: prompt.value.trim(),
      apiKey: appStore.aiApiKey,
      model: activeSession.value.terminalAiModel,
      enableCodingPlan: appStore.aiEnableCodingPlan,
      shell: 'linux/busybox',
    });
    result.value = response;
    if (response.command && response.risk !== 'dangerous') {
      applyCommandToApp(response.command);
    }
  } catch (e: unknown) {
    message.error(getAiErrorMessage(e, t('ai.terminal.failed')));
  } finally {
    loading.value = false;
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
  if (!result.value?.command) return;
  applyCommandToApp(result.value.command);
}

function applyCommandToApp(command: string) {
  void props.bridge.applyCommand(command);
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
  font-size: 11px;
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
  font-size: 12px;
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
  font-size: 11px;
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

:global(.ai-model-menu) {
  max-height: 200px !important;
  overflow-y: auto !important;
}
</style>
