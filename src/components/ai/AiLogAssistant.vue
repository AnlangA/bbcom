<template>
  <div class="log-assistant">
    <div class="settings-row">
      <div class="field-group">
        <span class="field-label">
          <Bot class="icon-sm" />
          {{ t('ai.log.model') }}
        </span>
        <AppSelect
          size="small"
          :value="session.logAiModel"
          :options="aiModelOptions"
          :menu-props="aiModelMenuProps"
          @update:value="setLogModel"
        />
      </div>
      <div class="field-group">
        <span class="field-label">
          <MessageSquareText class="icon-sm" />
          {{ t('ai.log.context') }}
        </span>
        <AppSelect
          size="small"
          :value="session.logAiContextMode"
          :options="localizedLogContextModeOptions"
          @update:value="setContextMode"
        />
      </div>
      <n-input-number
        v-if="session.logAiContextMode === 'latest-n-frames'"
        size="small"
        :value="session.logAiFrameLimit"
        :min="20"
        :max="2000"
        :step="20"
        style="width: 112px"
        @update:value="setFrameLimit"
      />
    </div>

    <div class="message-list">
      <div v-if="session.logAiMessages.length === 0" class="empty-hint">
        {{ t('ai.log.emptyHint') }}
      </div>
      <div
        v-for="item in session.logAiMessages"
        :key="item.id"
        class="message-item"
        :class="item.role"
      >
        <span class="role">{{ item.role === 'user' ? t('ai.log.me') : 'AI' }}</span>
        <span class="content">{{ item.content }}</span>
      </div>
    </div>

    <div v-if="result" class="result-card">
      <div class="answer">{{ result.answer }}</div>
      <div v-if="result.evidence.length > 0" class="result-section">
        <span class="section-title">{{ t('ai.log.evidence') }}</span>
        <ul>
          <li v-for="item in result.evidence" :key="item">{{ item }}</li>
        </ul>
      </div>
      <div v-if="result.suggestions.length > 0" class="result-section">
        <span class="section-title">{{ t('ai.log.suggestions') }}</span>
        <ul>
          <li v-for="item in result.suggestions" :key="item">{{ item }}</li>
        </ul>
      </div>
      <n-tag v-if="result.truncated" size="small" type="warning" :bordered="false">
        {{ t('ai.log.truncated') }}
      </n-tag>
    </div>

    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? t('ai.log.placeholder') : t('ai.needApiKey')"
        :disabled="loading"
        @keydown.enter.prevent="ask"
      />
      <n-button size="small" :disabled="session.logAiMessages.length === 0" @click="clearMessages">
        <template #icon>
          <Trash2 class="icon-sm" />
        </template>
        {{ t('ai.log.clear') }}
      </n-button>
      <n-button size="small" type="primary" :loading="loading" :disabled="!canAsk" @click="ask">
        <template #icon>
          <WandSparkles class="icon-sm" />
        </template>
        {{ t('ai.log.analyze') }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput, NInputNumber, NTag, useMessage } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { Bot, MessageSquareText, Trash2, WandSparkles } from '@lucide/vue';
import { useAppStore } from '../../stores/app';
import type { AiModel, AiWindowSession, LogAiContextMode } from '../../types';
import type { useAiWindowSession } from '../../composables/useAiWindowSession';
import { getAiErrorMessage } from '../../lib/ai-error';
import { runAiRequest } from '../../lib/ipc';
import { t } from '../../lib/i18n';
import { aiModelMenuProps, aiModelOptions, getLogContextModeOptions } from './ai-options';

interface LogAiResponse {
  answer: string;
  evidence: string[];
  suggestions: string[];
  truncated: boolean;
}

const props = defineProps<{
  session: AiWindowSession;
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const result = ref<LogAiResponse | null>(null);

const hasApiKey = computed(() => appStore.aiKeyConfigured);
const canAsk = computed(() => prompt.value.trim().length > 0 && !loading.value);
const localizedLogContextModeOptions = computed(() => getLogContextModeOptions());

async function ask() {
  if (!canAsk.value) return;
  if (!hasApiKey.value) {
    message.warning(t('ai.needApiKey'));
    return;
  }
  loading.value = true;
  // Drop the previous analysis so a stale result card isn't shown while the
  // new answer is loading (matches AiTerminalAssistant.generateCommand).
  result.value = null;
  try {
    const latestSession = (await props.bridge.refreshSession()) ?? props.session;
    const context = await props.bridge.getLogContext();
    if (!context || context.frameCount === 0) {
      message.warning(t('ai.log.noData'));
      return;
    }
    const question = prompt.value.trim();
    await props.bridge.addLogAiMessage({ role: 'user', content: question });
    const response = await runAiRequest({
      requestId: crypto.randomUUID(),
      kind: 'log',
      prompt: question,
      model: latestSession.logAiModel,
      context: context.text,
      contextMode: latestSession.logAiContextMode,
      sessionMeta: `${latestSession.portName}, ${latestSession.baudRate ?? 0} bps, ${context.frameCount} frames, max ${context.charLimit} chars`,
    });
    if (response.kind !== 'log') throw new Error('unexpected AI response kind');
    result.value = response;
    await props.bridge.addLogAiMessage({ role: 'assistant', content: response.answer });
    prompt.value = '';
  } catch (e: unknown) {
    message.error(getAiErrorMessage(e, t('ai.log.failed')));
  } finally {
    loading.value = false;
  }
}

function setLogModel(model: AiModel) {
  void props.bridge.setLogAiModel(model);
}

function setContextMode(mode: LogAiContextMode) {
  void props.bridge.setLogAiContextMode(mode);
}

function setFrameLimit(value: number | null) {
  void props.bridge.setLogAiFrameLimit(value ?? 200);
}

function clearMessages() {
  void props.bridge.clearLogAiMessages();
  result.value = null;
}
</script>

<style scoped>
.log-assistant {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-row,
.field-group,
.prompt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-group {
  flex: 1;
  min-width: 0;
}

.field-group .n-select,
.prompt-row .n-input {
  flex: 1;
  min-width: 0;
}

.field-label,
.section-title,
.role {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.message-list {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
}

.empty-hint {
  color: var(--text-dim);
  font-size: 12px;
}

.message-item {
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--radius-md);
  background: var(--bg-tertiary);
}

.message-item .content {
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
  line-height: 1.5;
}

.message-item.user {
  background: var(--color-primary-subtle);
}

.message-item .content,
.answer,
.result-section li {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.result-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-tertiary);
  box-shadow: var(--shadow-inset);
  max-height: 320px;
  overflow-y: auto;
}

.result-section ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
