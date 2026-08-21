<!--
  Interactive serial console. Presentational plus session-document patches:
  the resident SessionRuntime owns RX/TX and the display engine.
-->
<template>
  <div class="shell-panel">
    <div class="shell-header">
      <span class="shell-title">
        <Keyboard class="icon-sm" />
        {{ t('shell.title') }}
      </span>
      <AppSelect
        :value="config.inputMode"
        :aria-label="t('shell.mode')"
        :options="modeOptions"
        size="tiny"
        style="width: var(--control-w-lg)"
        @update:value="(value) => patch({ inputMode: value })"
      />
      <n-checkbox
        :checked="config.localEcho"
        size="small"
        @update:checked="(value) => patch({ localEcho: value })"
      >
        {{ t('shell.echo') }}
      </n-checkbox>
      <AppSelect
        :value="config.txNewline"
        :aria-label="t('shell.txNewline')"
        :options="txNewlineOptions"
        size="tiny"
        style="width: var(--control-w-md)"
        @update:value="(value) => patch({ txNewline: value })"
      />
      <AppSelect
        :value="config.rxNewline"
        :aria-label="t('shell.rxNewline')"
        :options="rxNewlineOptions"
        size="tiny"
        style="width: var(--control-w-md)"
        @update:value="(value) => patch({ rxNewline: value })"
      />
      <AppSelect
        :value="config.encoding"
        :aria-label="t('shell.encoding')"
        :options="encodingOptions"
        size="tiny"
        style="width: var(--control-w-md)"
        @update:value="(value) => patch({ encoding: value })"
      />
      <n-checkbox
        :checked="config.showTimestamp"
        size="small"
        @update:checked="(value) => patch({ showTimestamp: value })"
      >
        {{ t('shell.timestamp') }}
      </n-checkbox>
      <button
        class="shell-close"
        type="button"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >
        <X class="icon-sm" />
      </button>
    </div>

    <div class="shell-toolbar">
      <input
        class="shell-search"
        type="search"
        :value="search"
        :placeholder="t('shell.search')"
        :aria-label="t('shell.search')"
        @input="search = ($event.target as HTMLInputElement).value"
      />
      <span v-if="snapshot.droppedLines > 0" class="shell-dropped">
        {{ t('shell.dropped', { lines: snapshot.droppedLines }) }}
      </span>
    </div>

    <div
      ref="scrollRef"
      class="shell-body scrollbar-thin"
      :class="{ 'is-char': config.inputMode === 'char' }"
      tabindex="0"
      role="log"
      :aria-label="t('shell.title')"
      @keydown="onSurfaceKeydown"
    >
      <div v-if="rows.length === 1 && !rows[0]?.text" class="shell-empty">
        {{ t('shell.empty') }}
      </div>
      <div v-else class="shell-window" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <div
          v-for="row in virtualizer.getVirtualItems()"
          :key="row.index"
          class="shell-line"
          :style="{
            height: `${row.size}px`,
            transform: `translateY(${row.start}px)`,
          }"
        >
          <span v-if="config.showTimestamp && rows[row.index]?.timestamp" class="shell-ts">
            {{ formatTimestamp(rows[row.index]!.timestamp) }}
          </span>
          <span
            v-if="useAnsi"
            class="shell-text"
            v-html="formatLine(rows[row.index]?.text ?? '')"
          ></span>
          <span v-else class="shell-text">{{ rows[row.index]?.text ?? '' }}</span>
        </div>
      </div>
    </div>

    <form v-if="config.inputMode === 'line'" class="shell-input-row" @submit.prevent="sendLine">
      <input
        v-model="draft"
        class="shell-input"
        type="text"
        :disabled="!isConnected"
        :placeholder="t('shell.input')"
        :aria-label="t('shell.input')"
        autocomplete="off"
        @keydown="onLineKeydown"
      />
      <n-button type="primary" size="small" :disabled="!isConnected" attr-type="submit">
        {{ t('shell.send') }}
      </n-button>
    </form>
    <div v-else class="shell-char-hint">{{ t('shell.charHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { NButton, NCheckbox } from 'naive-ui';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { AnsiUp } from 'ansi_up';
import { Keyboard, X } from '@lucide/vue';
import AppSelect from '../ui/AppSelect.vue';
import { useSessionDocument } from '../../features/sessions';
import { SESSION_UI_STATE_KEY } from '../../features/sessions/runtime/session-ui-state';
import { useAppStore } from '../../stores/app';
import { formatTimestamp } from '../../lib/format';
import { t } from '../../lib/i18n';
import { serialShellKeyFromKeyboard } from '../../lib/serial-shell';
import type { SerialShellConfig, SerialShellLine, SerialShellSnapshot } from '../../types';
import type { SerialSendResult } from '../../types/serial';
import type { SerialShellKey } from '../../lib/serial-shell';

const props = defineProps<{
  sessionId: string;
  config: SerialShellConfig;
  snapshot: SerialShellSnapshot;
  isConnected: boolean;
  onSubmitLine: (text: string) => Promise<SerialSendResult>;
  onSubmitKey: (key: SerialShellKey) => Promise<SerialSendResult | null>;
}>();

const emit = defineEmits<{
  close: [];
}>();

const document = useSessionDocument(props.sessionId);
const appStore = useAppStore();
const retainedUiState = inject(SESSION_UI_STATE_KEY, null);
const localSearch = ref('');
const search = computed({
  get: () => retainedUiState?.shellSearch.value ?? localSearch.value,
  set: (value) => {
    if (retainedUiState) retainedUiState.shellSearch.value = value;
    else localSearch.value = value;
  },
});
const draft = ref('');
const historyIndex = ref(-1);
const scrollRef = ref<HTMLElement | null>(null);
const ansiUp = new AnsiUp();
ansiUp.use_classes = true;

const modeOptions = [
  { label: t('shell.mode.line'), value: 'line' as const },
  { label: t('shell.mode.char'), value: 'char' as const },
];
const newlineChoices = [
  { label: t('shell.newline.none'), value: 'none' as const },
  { label: t('shell.newline.cr'), value: 'cr' as const },
  { label: t('shell.newline.lf'), value: 'lf' as const },
  { label: t('shell.newline.crlf'), value: 'crlf' as const },
];
const txNewlineOptions = newlineChoices;
const rxNewlineOptions = [
  ...newlineChoices,
  { label: t('shell.newline.auto'), value: 'auto' as const },
];
const encodingOptions = [
  { label: 'UTF-8', value: 'utf-8' as const },
  { label: 'GBK', value: 'gbk' as const },
  { label: 'Latin-1', value: 'latin1' as const },
];

const useAnsi = computed(() => appStore.ansiColorEnabled);
const rows = computed<readonly SerialShellLine[]>(() => {
  const all = [...props.snapshot.lines, props.snapshot.current];
  const query = search.value.trim().toLowerCase();
  if (!query) return all;
  return all.filter((line) => line.text.toLowerCase().includes(query));
});

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 18,
    overscan: 12,
  })),
);

function patch(next: Partial<SerialShellConfig>): void {
  document.setShellConfig(props.sessionId, next);
}

function formatLine(text: string): string {
  return ansiUp.ansi_to_html(text);
}

async function sendLine(): Promise<void> {
  if (!props.isConnected) return;
  const text = draft.value;
  draft.value = '';
  historyIndex.value = -1;
  await props.onSubmitLine(text);
}

function onLineKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const history = props.config.history;
  if (history.length === 0) return;
  event.preventDefault();
  if (event.key === 'ArrowUp') {
    historyIndex.value =
      historyIndex.value < 0 ? history.length - 1 : Math.max(0, historyIndex.value - 1);
  } else if (historyIndex.value >= 0) {
    historyIndex.value = historyIndex.value >= history.length - 1 ? -1 : historyIndex.value + 1;
  }
  draft.value = historyIndex.value < 0 ? '' : (history[historyIndex.value] ?? '');
}

function onSurfaceKeydown(event: KeyboardEvent): void {
  if (props.config.inputMode !== 'char' || !props.isConnected) return;
  const key = serialShellKeyFromKeyboard(event);
  if (!key) return;
  event.preventDefault();
  void props.onSubmitKey(key);
}

watch(
  () =>
    [
      props.snapshot.resetVersion,
      props.snapshot.lines.length,
      props.snapshot.current.text,
    ] as const,
  async () => {
    if (!appStore.autoScroll) return;
    await nextTick();
    virtualizer.value.scrollToIndex(Math.max(0, rows.value.length - 1), { align: 'end' });
  },
);
</script>

<style scoped>
.shell-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  min-height: 0;
}

.shell-header,
.shell-toolbar,
.shell-input-row,
.shell-char-hint {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.shell-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.shell-close {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  margin-left: auto;
}

.shell-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.shell-search {
  flex: 1;
  min-width: 160px;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--font-size-sm);
}

.shell-dropped {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}

.shell-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  padding: 6px 10px;
}

.shell-body.is-char:focus {
  outline: 1px solid var(--border-focus);
}

.shell-empty,
.shell-char-hint {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.shell-window {
  position: relative;
  width: 100%;
}

.shell-line {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  gap: var(--space-sm);
  white-space: pre-wrap;
  word-break: break-all;
}

.shell-ts {
  color: var(--text-dim);
  flex-shrink: 0;
}

.shell-text {
  flex: 1;
  min-width: 0;
}

.shell-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-family: var(--font-mono);
}

.shell-char-hint {
  border-bottom: 0;
  border-top: 1px solid var(--border-subtle);
}
</style>
