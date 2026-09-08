<template>
  <aside
    class="mc-result-panel"
    :class="{ 'is-expanded': expanded }"
    :aria-label="t('mcumgr.result.title')"
  >
    <header class="mc-result-header">
      <div class="mc-result-heading">
        <TerminalSquare :size="16" aria-hidden="true" />
        <h3>{{ t('mcumgr.result.title') }}</h3>
        <span v-if="result" class="result-format">{{ formatLabel }}</span>
      </div>
      <div class="mc-result-actions">
        <IconActionButton
          :label="t('mcumgr.result.wrap')"
          toggleable
          :active="wrap"
          :disabled="!result"
          @click="wrap = !wrap"
          ><WrapText class="icon-sm"
        /></IconActionButton>
        <IconActionButton :label="t('mcumgr.result.copy')" :disabled="!result" @click="copyResult"
          ><Copy class="icon-sm"
        /></IconActionButton>
        <IconActionButton
          :label="t('common.clear')"
          :disabled="!result || busy"
          @click="emit('clear')"
          ><Eraser class="icon-sm"
        /></IconActionButton>
        <IconActionButton
          :label="expanded ? t('mcumgr.result.restore') : t('mcumgr.result.expand')"
          toggleable
          :active="expanded"
          @click="emit('update:expanded', !expanded)"
          ><Minimize2 v-if="expanded" class="icon-sm" /><Maximize2 v-else class="icon-sm"
        /></IconActionButton>
      </div>
    </header>
    <div v-if="!result" class="mc-result-empty">
      <span class="result-empty-icon" aria-hidden="true"
        ><Braces :size="26" :stroke-width="1.4"
      /></span>
      <strong>{{ t('mcumgr.result.waiting') }}</strong>
      <p>{{ t('mcumgr.result.emptyHint') }}</p>
    </div>
    <pre
      v-else
      class="mc-result"
      :class="{ wrap }"
      tabindex="0"
      :aria-label="t('mcumgr.result.title')"
      >{{ result }}</pre>
    <footer class="mc-result-footer">
      <span class="result-indicator" :class="{ busy }"></span>
      <span>{{ busy ? t('mcumgr.result.running') : t('mcumgr.result.latest') }}</span>
      <span v-if="result" class="result-count">{{
        t('mcumgr.result.lines', { count: lineCount })
      }}</span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { Braces, Copy, Eraser, Maximize2, Minimize2, TerminalSquare, WrapText } from '@lucide/vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import { t } from '@/lib/i18n';

const props = defineProps<{ result: string; busy: boolean; expanded: boolean }>();
const emit = defineEmits<{ clear: []; 'update:expanded': [expanded: boolean] }>();
const message = useMessage();
const wrap = ref(true);
const lineCount = computed(() => props.result.split('\n').length);
const formatLabel = computed(() => {
  try {
    JSON.parse(props.result);
    return 'JSON';
  } catch {
    return 'TEXT';
  }
});

async function copyResult() {
  if (!props.result) return;
  try {
    await navigator.clipboard.writeText(props.result);
    message.success(t('mcumgr.result.copied'));
  } catch {
    message.error(t('mcumgr.result.copyFailed'));
  }
}
</script>

<style scoped>
.mc-result-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-primary);
  overflow: hidden;
}
.mc-result-header {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-xs);
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-lift);
  flex-shrink: 0;
}
.mc-result-heading,
.mc-result-actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}
.mc-result-heading {
  gap: var(--space-sm);
  color: var(--text-muted);
}
h3 {
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}
.result-format {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}
.mc-result {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-lg);
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-data);
  line-height: 1.85;
  color: var(--text-primary);
  white-space: pre;
  tab-size: 2;
}
.mc-result.wrap {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mc-result-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  min-height: 160px;
  text-align: center;
  padding: var(--space-xl);
  color: var(--text-secondary);
}
.result-empty-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: var(--radius-xl);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  margin-bottom: var(--space-sm);
}
.mc-result-empty strong {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
}
.mc-result-empty p {
  font-size: var(--font-size-data);
  color: var(--text-muted);
  max-width: 240px;
  line-height: var(--line-height-relaxed);
}
.mc-result-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.result-indicator {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--text-dim);
}
.result-indicator.busy {
  background: var(--color-primary);
}
.result-count {
  margin-left: auto;
  font-family: var(--font-mono);
}
</style>
