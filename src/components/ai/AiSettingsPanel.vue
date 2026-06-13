<template>
  <div class="ai-settings">
    <button class="settings-toggle" type="button" @click="expanded = !expanded">
      <span>AI 设置</span>
      <span class="settings-state" :class="{ configured: appStore.aiApiKey }">
        <span class="state-dot"></span>
        {{ appStore.aiApiKey ? '已配置' : '未配置' }}
      </span>
    </button>
    <div v-if="expanded" class="settings-body">
      <n-input
        v-model:value="apiKeyDraft"
        type="password"
        size="small"
        show-password-on="click"
        placeholder="Z.ai / ZHIPU API Key"
      />
      <div class="settings-actions">
        <n-switch
          size="small"
          :value="appStore.aiEnableCodingPlan"
          @update:value="appStore.setAiEnableCodingPlan"
        />
        <span class="coding-plan-label">Coding Plan</span>
        <n-button size="tiny" type="primary" :disabled="!apiKeyDraft.trim()" @click="saveApiKey">
          保存 Key
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';

const appStore = useAppStore();
const message = useMessage();
const expanded = ref(false);
const apiKeyDraft = ref(appStore.aiApiKey);

watch(() => appStore.aiApiKey, (value) => {
  apiKeyDraft.value = value;
});

function saveApiKey() {
  appStore.setAiApiKey(apiKeyDraft.value.trim());
  message.success('AI Key 已保存到本地设置');
}
</script>

<style scoped>
.ai-settings {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--gradient-brand-subtle);
}

.settings-toggle,
.settings-actions {
  display: flex;
  align-items: center;
}

.settings-toggle {
  width: 100%;
  justify-content: space-between;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: color var(--transition-normal);
}

.settings-toggle:hover {
  color: var(--text-primary);
}

.settings-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.state-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}

.settings-state.configured {
  color: var(--accent-green);
  border-color: rgba(76, 175, 80, 0.25);
}

.settings-state.configured .state-dot {
  background: var(--accent-green);
  box-shadow: 0 0 4px var(--accent-green-glow);
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  animation: slide-in var(--transition-normal);
}

.settings-actions {
  gap: 8px;
}

.coding-plan-label {
  flex: 1;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
