<template>
  <div class="ai-assistant">
    <div class="drag-handle" @pointerdown="startDrag">
      <div class="title-group">
        <button class="ai-orb" type="button" @pointerdown.stop @click.stop="expanded = !expanded">
          AI
        </button>
        <div>
          <div class="drag-title">AI 终端助手</div>
          <div class="drag-subtitle">自然语言生成串口终端命令</div>
        </div>
      </div>
      <div class="window-actions" @pointerdown.stop>
        <n-button size="tiny" quaternary @click.stop="toggleAlwaysOnTop">
          {{ alwaysOnTop ? '取消置顶' : '置顶' }}
        </n-button>
        <n-button size="tiny" quaternary @click.stop="expanded = !expanded">
          {{ expanded ? '收起设置' : '设置' }}
        </n-button>
      </div>
    </div>

    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? '自然语言生成命令，如：查看当前路径' : '请先展开设置并保存 API Key'"
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
        生成
      </n-button>
    </div>

    <div v-if="expanded" class="settings-panel">
      <div class="field-group api-key-field">
        <span class="field-label">API Key</span>
        <n-input
          v-model:value="apiKeyDraft"
          type="password"
          size="small"
          show-password-on="click"
          placeholder="输入 Z.ai / ZHIPU API Key"
        />
        <n-button size="small" type="primary" @click="saveApiKey" :disabled="!apiKeyDraft.trim()">
          保存
        </n-button>
      </div>
      <div class="field-group model-field">
        <span class="field-label">模型</span>
        <n-select
          size="small"
          :value="appStore.aiModel"
          :options="modelOptions"
          :menu-props="modelMenuProps"
          @update:value="appStore.setAiModel"
        />
      </div>
      <div class="coding-plan-field">
        <n-switch
          size="small"
          :value="appStore.aiEnableCodingPlan"
          @update:value="appStore.setAiEnableCodingPlan"
        />
        <span class="coding-plan-label">Coding Plan</span>
      </div>
    </div>

    <div v-if="result" class="result-row" :class="`risk-${result.risk}`">
      <div class="result-main">
        <div class="result-meta">
          <n-tag size="small" round :type="riskTagType">{{ riskLabel }}</n-tag>
          <span class="explanation">{{ result.explanation }}</span>
        </div>
        <code class="command">{{ result.command || '需要更多信息' }}</code>
      </div>
      <div class="result-actions">
        <n-button size="tiny" secondary @click="copyCommand" :disabled="!result.command">
          复制
        </n-button>
        <n-button size="tiny" type="primary" @click="applyCommand" :disabled="!result.command">
          填入输入框
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NInput, NSelect, NSwitch, NTag, useMessage } from 'naive-ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../stores/app';
import { AI_MODEL_OPTIONS } from '../../lib/constants';
import { getCommandErrorMessage, startAiWindowDrag, terminalAiAssist, type TerminalAiResponse } from '../../lib/ipc';

const emitVue = defineEmits<{
  (e: 'applyCommand', command: string): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const apiKeyDraft = ref(appStore.aiApiKey);
const loading = ref(false);
const expanded = ref(false);
const alwaysOnTop = ref(true);
const result = ref<TerminalAiResponse | null>(null);

const modelOptions = AI_MODEL_OPTIONS;
const modelMenuProps = {
  class: 'ai-model-menu',
  style: 'max-height: 72px;',
};

const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canGenerate = computed(() => prompt.value.trim().length > 0 && !loading.value);
const riskLabel = computed(() => {
  if (!result.value) return '';
  return { safe: '安全', caution: '谨慎', dangerous: '危险' }[result.value.risk];
});
const riskTagType = computed(() => {
  if (!result.value) return 'default';
  return result.value.risk === 'safe' ? 'success' : result.value.risk === 'caution' ? 'warning' : 'error';
});

onMounted(async () => {
  try {
    alwaysOnTop.value = await getCurrentWindow().isAlwaysOnTop();
  } catch {
    // ignore
  }
});

watch(
  () => appStore.aiApiKey,
  (value) => {
    if (value !== apiKeyDraft.value) {
      apiKeyDraft.value = value;
    }
  },
  { immediate: true }
);

async function saveApiKey() {
  const ok = await appStore.setAiApiKey(apiKeyDraft.value.trim());
  if (ok) {
    message.success('AI Key 已保存到本地设置');
  } else {
    message.error('AI Key 保存失败');
  }
}

async function generateCommand() {
  if (!canGenerate.value) return;
  if (!hasApiKey.value) {
    expanded.value = true;
    message.warning('请先保存 API Key');
    return;
  }
  loading.value = true;
  result.value = null;
  try {
    const response = await terminalAiAssist({
      prompt: prompt.value.trim(),
      apiKey: appStore.aiApiKey,
      model: appStore.aiModel,
      enableCodingPlan: appStore.aiEnableCodingPlan,
      shell: 'linux/busybox',
    });
    result.value = response;
    if (response.command && response.risk !== 'dangerous') {
      applyCommandToApp(response.command);
    }
  } catch (e: unknown) {
    const errMsg = getCommandErrorMessage(e, 'AI 命令生成失败');
    message.error(errMsg);
  } finally {
    loading.value = false;
  }
}

async function copyCommand() {
  if (!result.value?.command) return;
  await navigator.clipboard.writeText(result.value.command);
  message.success('命令已复制');
}

function applyCommand() {
  if (!result.value?.command) return;
  applyCommandToApp(result.value.command);
}

function applyCommandToApp(command: string) {
  appStore.applyAiCommand(command);
  emitVue('applyCommand', command);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('button, input, textarea, select, [role="button"], .n-button, .n-input, .n-select, .n-switch')
  );
}

async function startDrag(event: PointerEvent) {
  if (event.button !== 0 || isInteractiveTarget(event.target)) return;

  try {
    await startAiWindowDrag();
  } catch {
    // ignore
  }
}

async function toggleAlwaysOnTop() {
  try {
    const next = !alwaysOnTop.value;
    await getCurrentWindow().setAlwaysOnTop(next);
    alwaysOnTop.value = next;
  } catch {
    message.error('置顶切换失败');
  }
}

</script>

<style scoped>
.ai-assistant {
  padding: 10px;
  border: 1px solid rgba(99, 255, 177, 0.18);
  border-radius: 0;
  background:
    radial-gradient(circle at 0 0, rgba(99, 255, 177, 0.12), transparent 32%),
    linear-gradient(135deg, rgba(18, 26, 32, 0.94), rgba(12, 16, 21, 0.86));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  display: flex;
  flex-direction: column;
  gap: 10px;
  backdrop-filter: blur(16px);
}

.drag-handle {
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.ai-orb {
  width: 34px;
  height: 34px;
  border: 1px solid rgba(99, 255, 177, 0.45);
  border-radius: 12px;
  background:
    radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.22), transparent 28%),
    linear-gradient(135deg, rgba(99, 255, 177, 0.24), rgba(99, 255, 177, 0.08));
  color: #9fffc7;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  box-shadow: 0 0 18px rgba(99, 255, 177, 0.08);
  flex-shrink: 0;
}

.window-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-title {
  color: var(--text-primary);
  font-size: 13px;
  letter-spacing: 0.3px;
}

.drag-subtitle {
  margin-top: 1px;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
}

.prompt-row,
.settings-panel,
.field-group,
.coding-plan-field,
.result-row,
.result-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-row .n-input,
.api-key-field .n-input,
.model-field .n-select {
  flex: 1;
  min-width: 0;
}

.settings-panel {
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
}

.field-group {
  min-width: 0;
}

.api-key-field {
  flex: 1.55;
}

.model-field {
  flex: 0.9;
}

.coding-plan-field {
  flex-shrink: 0;
}

.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.coding-plan-label {
  color: #9fffc7;
  font-size: 11px;
  white-space: nowrap;
}

.result-row {
  align-items: stretch;
  min-height: 48px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.028);
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
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.26);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: fit-content;
  max-width: 100%;
}

.explanation {
  color: var(--text-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.result-actions {
  align-self: flex-end;
  flex-shrink: 0;
}

.risk-dangerous {
  border-color: rgba(255, 95, 95, 0.45);
}

.risk-caution {
  border-color: rgba(255, 194, 87, 0.45);
}

:global(.ai-model-menu) {
  max-height: 72px !important;
  overflow-y: auto !important;
}
</style>
