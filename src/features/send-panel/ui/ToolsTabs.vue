<template>
  <!--
    The send-panel "tower": five previously-stacked, each-duplicated-header
    collapsible sections (quick commands / macros / triggers / highlights /
    history) collapsed into one compact horizontal tab bar. Selecting a tab
    swaps only that panel's body in — unvisited editor panels never load, so a fully
    configured session no longer eats half the terminal height with collapsed
    section headers. The per-panel bodies keep their own (now header-less)
    layout, so each tool's editing surface gets the full tab width.

    Badges surface a live count per tab so active state (running macros,
    enabled triggers/highlights, queued quick commands, recent sends) is
    visible without switching tabs.
  -->
  <div class="tools-tabs">
    <div
      class="tools-tabbar"
      role="tablist"
      :aria-label="t('toolbar.functionSettings')"
      @keydown="onTablistKeydown"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :id="tabDomId(tab.id)"
        :aria-controls="panelDomId(tab.id)"
        :aria-selected="activeTab === tab.id"
        :tabindex="activeTab === tab.id ? 0 : -1"
        class="tools-tab"
        :class="{ active: activeTab === tab.id }"
        :title="tab.label"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" class="icon-sm" />
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="tab.count > 0" class="tab-badge">{{ tab.count }}</span>
      </button>
    </div>
    <div class="tools-body">
      <!-- Quick commands: the only panel that still owns send/draft state via props -->
      <div
        v-show="activeTab === 'quick'"
        :id="panelDomId('quick')"
        class="tool-pane"
        role="tabpanel"
        :aria-labelledby="tabDomId('quick')"
        tabindex="0"
      >
        <div class="quick-row">
          <div class="quick-form">
            <n-input
              v-model:value="quickName"
              size="tiny"
              :placeholder="t('send.quickName')"
              :aria-label="t('send.quickName')"
              style="width: 130px"
              @keydown.enter="addQuickCommand"
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
              @click.self="sendQuick(cmd)"
            >
              <button
                class="quick-send"
                type="button"
                :disabled="disabled"
                @click.stop="sendQuick(cmd)"
              >
                <span class="history-tag">{{ cmd.isHex ? 'HEX' : 'TXT' }}</span>
                <span>{{ cmd.name }}</span>
              </button>
              <button
                class="quick-remove"
                type="button"
                @click.stop="emit('removeQuickCommand', cmd.id)"
                :title="t('send.deleteQuick')"
                :aria-label="`${t('send.deleteQuick')}: ${cmd.name}`"
              >
                <X class="icon-sm" />
              </button>
            </div>
          </div>
          <div v-else class="tool-empty">{{ t('tools.empty') }}</div>
        </div>
      </div>

      <div
        v-show="activeTab === 'macros'"
        :id="panelDomId('macros')"
        role="tabpanel"
        :aria-labelledby="tabDomId('macros')"
        tabindex="0"
      >
        <KeepAlive>
          <MacroPanel
            v-if="activeTab === 'macros'"
            :session-id="sessionId"
            :runner="macroRunner"
            :disabled="disabled"
          />
        </KeepAlive>
      </div>
      <div
        v-show="activeTab === 'triggers'"
        :id="panelDomId('triggers')"
        role="tabpanel"
        :aria-labelledby="tabDomId('triggers')"
        tabindex="0"
      >
        <KeepAlive>
          <TriggerPanel v-if="activeTab === 'triggers'" :session-id="sessionId" />
        </KeepAlive>
      </div>
      <div
        v-show="activeTab === 'highlights'"
        :id="panelDomId('highlights')"
        role="tabpanel"
        :aria-labelledby="tabDomId('highlights')"
        tabindex="0"
      >
        <KeepAlive>
          <HighlightPanel v-if="activeTab === 'highlights'" :session-id="sessionId" />
        </KeepAlive>
      </div>

      <div
        v-show="activeTab === 'history'"
        :id="panelDomId('history')"
        class="tool-pane"
        role="tabpanel"
        :aria-labelledby="tabDomId('history')"
        tabindex="0"
      >
        <div v-if="history.length > 0" class="history-head">
          <button class="history-clear" type="button" @click.stop="emit('clearHistory')">
            <Trash2 class="icon-sm" />
            {{ t('send.clearHistory') }}
          </button>
        </div>
        <div v-if="history.length > 0" class="history-list">
          <button
            v-for="(item, i) in history"
            :key="i"
            class="history-item"
            type="button"
            :disabled="disabled"
            @click="resend(item)"
            :title="item.data"
          >
            <span class="history-tag">{{ item.isHex ? 'HEX' : 'TXT' }}</span>
            <span class="history-text">{{ truncate(item.data, 48) }}</span>
          </button>
        </div>
        <div v-else class="tool-empty">{{ t('tools.empty') }}</div>
      </div>
      <div
        v-show="activeTab === 'checksum'"
        :id="panelDomId('checksum')"
        class="tool-pane"
        role="tabpanel"
        :aria-labelledby="tabDomId('checksum')"
        tabindex="0"
      >
        <ChecksumPanel />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, inject, nextTick, ref, useId, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';
import {
  BookmarkPlus,
  History as HistoryIcon,
  ListVideo,
  Highlighter,
  Hash,
  Trash2,
  X,
  Zap,
} from '@lucide/vue';
import { useSessionDocument } from '@/features/sessions';
import { truncate } from '@/lib/format';
import { t } from '@/lib/i18n';
import {
  activeToolCounts,
  buildQuickCommandPayload,
  canRunToolAction,
  defaultToolsTab,
  type ToolsTabId,
} from '@/lib/tools-tabs';
import type { QuickCommand, SendHistoryEntry } from '@/types';
import type { SessionRuntimeMacroController } from '@/features/sessions/runtime/session-runtime-controller';
import {
  SESSION_UI_STATE_KEY,
  type SessionRuntimeUiState,
} from '@/features/sessions/runtime/session-ui-state';

const props = defineProps<{
  sessionId: string;
  modelValue: string;
  /** Current send-mode (HEX vs text). Saved quick commands capture this so the
   * command re-sends in the same mode the user was in when they saved it. */
  isHex: boolean;
  disabled?: boolean;
  history: SendHistoryEntry[];
  quickCommands: QuickCommand[];
  onSend: (data: string, isHex: boolean) => Promise<boolean>;
  macroRunner: SessionRuntimeMacroController;
}>();

const emit = defineEmits<{
  (e: 'addQuickCommand', command: { name: string; data: string; isHex: boolean }): void;
  (e: 'removeQuickCommand', id: string): void;
  (e: 'clearHistory'): void;
}>();

const MacroPanel = defineAsyncComponent(() => import('./MacroPanel.vue'));
const TriggerPanel = defineAsyncComponent(() => import('./TriggerPanel.vue'));
const HighlightPanel = defineAsyncComponent(() => import('./HighlightPanel.vue'));
const ChecksumPanel = defineAsyncComponent(() => import('./ChecksumPanel.vue'));

const sessionDocument = useSessionDocument(props.sessionId);

const quickName = ref('');
const toolsDomId = `tools-${useId().replace(/:/g, '')}`;
// Default to Quick; if the session has no quick commands but has history, land
// on history so a returning user immediately sees something useful.
// Retention: under a session runtime the tab ref lives on the runtime so
// switching session tabs and back keeps the active tools page.
const retainedUiState = inject(SESSION_UI_STATE_KEY, null) as SessionRuntimeUiState | null;
const activeTab = retainedUiState?.toolsTab ?? ref<ToolsTabId>('quick');

const session = computed(() => sessionDocument.session.value ?? undefined);
const counts = computed(() => activeToolCounts(session.value, props.quickCommands, props.history));

const tabs = computed(() => [
  {
    id: 'quick' as const,
    label: t('tools.tab.quick'),
    icon: BookmarkPlus,
    count: counts.value.quick,
  },
  {
    id: 'macros' as const,
    label: t('tools.tab.macros'),
    icon: ListVideo,
    count: counts.value.macros,
  },
  {
    id: 'triggers' as const,
    label: t('tools.tab.triggers'),
    icon: Zap,
    count: counts.value.triggers,
  },
  {
    id: 'highlights' as const,
    label: t('tools.tab.highlights'),
    icon: Highlighter,
    count: counts.value.highlights,
  },
  {
    id: 'history' as const,
    label: t('tools.tab.history'),
    icon: HistoryIcon,
    count: counts.value.history,
  },
  {
    id: 'checksum' as const,
    label: t('checksum.title'),
    icon: Hash,
    count: 0,
  },
]);

// Pick a sensible default tab once, after the session props resolve. Avoids
// showing an empty Quick pane on a session that has macros/triggers set up.
watch(
  () => props.sessionId,
  () => {
    activeTab.value = defaultToolsTab(activeTab.value, counts.value);
  },
  { immediate: true },
);

function addQuickCommand() {
  const command = buildQuickCommandPayload(props.modelValue, quickName.value, props.isHex);
  if (!command) return;
  // Capture the current send mode so a quick-command saved in HEX mode
  // re-sends as HEX (matches the pre-refactor behaviour).
  emit('addQuickCommand', command);
  quickName.value = '';
}

function tabDomId(id: ToolsTabId): string {
  return `${toolsDomId}-tab-${id}`;
}

function panelDomId(id: ToolsTabId): string {
  return `${toolsDomId}-panel-${id}`;
}

function selectTab(id: ToolsTabId, focus = false): void {
  activeTab.value = id;
  if (!focus) return;
  void nextTick(() => document.getElementById(tabDomId(id))?.focus());
}

function onTablistKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const currentIndex = tabs.value.findIndex((tab) => tab.id === activeTab.value);
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.value.length - 1
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + tabs.value.length) % tabs.value.length
          : (currentIndex + 1) % tabs.value.length;
  event.preventDefault();
  const next = tabs.value[nextIndex];
  if (next) selectTab(next.id, true);
}

function sendQuick(command: QuickCommand) {
  if (!canRunToolAction(props.disabled)) return;
  props.onSend(command.data, command.isHex);
}

function resend(item: SendHistoryEntry) {
  if (!canRunToolAction(props.disabled)) return;
  props.onSend(item.data, item.isHex);
}
</script>

<style scoped>
.tools-tabs {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
  min-height: 0;
}

.tools-tabbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  flex-shrink: 0;
  overflow-x: auto;
}

.tools-tabbar::-webkit-scrollbar {
  height: 0;
}

.tools-tab {
  flex: 1 1 0;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
  cursor: pointer;
  white-space: nowrap;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.tools-tab:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.tools-tab.active {
  color: var(--color-primary);
  background: var(--bg-active);
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-grid;
  place-items: center;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.tools-tab.active .tab-badge {
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}

.tools-body {
  margin-top: 8px;
  min-height: 0;
}

.tool-pane {
  display: block;
}

.tool-empty {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  padding: 10px 4px;
  text-align: center;
}

.quick-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
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
  cursor: default;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    transform var(--transition-fast);
}

.quick-send {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.quick-send:disabled,
.history-item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

.history-head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}

.history-clear {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
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
  max-height: 80px;
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
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  max-width: 240px;
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
  font-size: var(--font-size-sm);
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
</style>
