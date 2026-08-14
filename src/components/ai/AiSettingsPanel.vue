<template>
  <div class="ai-settings" :class="{ compact }">
    <button
      class="settings-toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="settingsBodyId"
      @click="expanded = !expanded"
    >
      <span class="settings-title">
        <Settings2 class="icon-sm" />
        {{ t('ai.settings') }}
      </span>
      <span class="settings-state" role="status" aria-live="polite" aria-atomic="true">{{
        appStore.aiKeyConfigured ? t('ai.configured') : t('ai.notConfigured')
      }}</span>
    </button>
    <div v-if="expanded" :id="settingsBodyId" class="settings-body" :aria-busy="saving">
      <n-input
        v-model:value="apiKeyDraft"
        type="password"
        size="small"
        show-password-on="click"
        placeholder="Z.ai / ZHIPU API Key"
        aria-label="Z.ai / ZHIPU API Key"
      />
      <div class="settings-actions">
        <n-button size="tiny" type="primary" :loading="saving" @click="saveApiKey">
          <template #icon>
            <KeyRound class="icon-sm" />
          </template>
          {{ t('ai.saveKey') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue';
import { NButton, NInput, useMessage } from 'naive-ui';
import { KeyRound, Settings2 } from '@lucide/vue';
import { useAppStore } from '../../stores/app';
import { t } from '../../lib/i18n';

defineProps<{
  compact?: boolean;
}>();

const appStore = useAppStore();
const message = useMessage();
const expanded = ref(!appStore.aiKeyConfigured);
const settingsBodyId = `ai-settings-${useId().replace(/:/g, '')}`;
// The input is intentionally the only renderer location that can contain a
// newly typed secret. Saved credentials are never read back into JavaScript.
const apiKeyDraft = ref('');
const saving = ref(false);

async function saveApiKey() {
  saving.value = true;
  try {
    const ok = await appStore.setAiApiKey(apiKeyDraft.value.trim());
    if (ok) {
      message.success(apiKeyDraft.value.trim() ? t('ai.keySaved') : t('ai.keyCleared'));
      apiKeyDraft.value = '';
    } else {
      message.error(t('ai.keySaveFailed'));
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.ai-settings {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
}

.ai-settings.compact {
  /* Sit inside the sidebar the same way PortSelector's .section cards do:
     matching side padding + gap so the AI panel reads as a peer section rather
     than a detached slab bolted onto the header. */
  margin: 6px;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-lift);
  box-shadow: var(--shadow-inset);
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
}

.settings-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-state {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.settings-actions {
  gap: 8px;
}
</style>
