<!--
  Interactive serial console rendered by xterm.js. The resident SessionRuntime
  owns RX/TX and the replay buffer; this panel owns the terminal instance and
  replays retained output on mount so scrollback survives remounts.
-->
<template>
  <div class="shell-panel">
    <div class="shell-chrome">
      <div class="shell-brand">
        <TerminalSquare class="icon-sm" />
        <span class="shell-title">{{ t('shell.title') }}</span>
        <span
          class="shell-link"
          :class="isConnected ? 'is-online' : 'is-offline'"
          role="status"
          aria-live="polite"
        >
          <span class="shell-link-dot" aria-hidden="true" />
          {{ isConnected ? t('shell.link.online') : t('shell.link.offline') }}
        </span>
      </div>

      <n-input
        :value="search"
        size="tiny"
        clearable
        class="shell-search"
        :placeholder="t('shell.search')"
        :aria-label="t('shell.search')"
        @update:value="onSearchInput"
        @keydown="onSearchKeydown"
      >
        <template #prefix>
          <Search class="icon-sm" />
        </template>
      </n-input>

      <div class="shell-chrome-actions">
        <IconActionButton :label="t('shell.searchPrevious')" @click="findPrevious">
          <ChevronUp class="icon-sm" />
        </IconActionButton>
        <IconActionButton :label="t('shell.searchNext')" @click="findNext">
          <ChevronDown class="icon-sm" />
        </IconActionButton>
        <IconActionButton
          :label="t('shell.settings')"
          toggleable
          :active="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        >
          <Settings2 class="icon-sm" />
        </IconActionButton>
        <IconActionButton :label="t('shell.clear')" @click="clearTerminal">
          <Eraser class="icon-sm" />
        </IconActionButton>
        <IconActionButton :label="t('common.close')" @click="emit('close')">
          <X class="icon-sm" />
        </IconActionButton>
      </div>
    </div>

    <Transition name="shell-settings">
      <div v-if="settingsOpen" class="shell-settings">
        <n-checkbox
          :checked="config.localEcho"
          size="small"
          @update:checked="(value) => patch({ localEcho: value })"
        >
          {{ t('shell.echo') }}
        </n-checkbox>

        <label class="shell-field">
          <span class="shell-field-label">{{ t('shell.txNewline') }}</span>
          <AppSelect
            :value="config.txNewline"
            :aria-label="t('shell.txNewline')"
            :options="txNewlineOptions"
            size="tiny"
            style="width: var(--control-w-md)"
            @update:value="(value) => patch({ txNewline: value })"
          />
        </label>

        <label class="shell-field">
          <span class="shell-field-label">{{ t('shell.rxNewline') }}</span>
          <AppSelect
            :value="config.rxNewline"
            :aria-label="t('shell.rxNewline')"
            :options="rxNewlineOptions"
            size="tiny"
            style="width: var(--control-w-md)"
            @update:value="(value) => patch({ rxNewline: value })"
          />
        </label>

        <label class="shell-field">
          <span class="shell-field-label">{{ t('shell.encoding') }}</span>
          <AppSelect
            :value="config.encoding"
            :aria-label="t('shell.encoding')"
            :options="encodingOptions"
            size="tiny"
            style="width: var(--control-w-sm)"
            @update:value="(value) => patch({ encoding: value })"
          />
        </label>

        <label class="shell-field">
          <span class="shell-field-label">{{ t('shell.backspace') }}</span>
          <AppSelect
            :value="config.backspace"
            :aria-label="t('shell.backspace')"
            :options="backspaceOptions"
            size="tiny"
            style="width: var(--control-w-sm)"
            @update:value="(value) => patch({ backspace: value })"
          />
        </label>

        <span class="shell-key-hint">{{ t('shell.copyHint') }}</span>
      </div>
    </Transition>

    <div class="shell-stage">
      <div
        ref="terminalHost"
        class="shell-body"
        :class="{ 'is-disconnected': !isConnected }"
        :aria-label="t('shell.title')"
        role="log"
      ></div>
      <div v-if="!isConnected" class="shell-overlay" role="status" aria-live="polite">
        <span class="shell-overlay-pill">{{ t('shell.disconnected') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { NCheckbox, NInput } from 'naive-ui';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, ChevronUp, Eraser, Search, Settings2, TerminalSquare, X } from '@lucide/vue';
import AppSelect from '@/design-system/AppSelect.vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import { useSessionDocument } from '@/features/sessions';
import { SESSION_UI_STATE_KEY, type SessionRuntimeUiState } from '@/features/sessions/runtime/session-ui-state';
import type { SessionRuntimeShellController } from '@/features/sessions/runtime/session-runtime-controller';
import { useAppStore } from '@/features/settings/store/app-store';
import { t } from '@/lib/i18n';
import type { SerialShellConfig } from '@/types';

const props = defineProps<{
  sessionId: string;
  config: SerialShellConfig;
  isConnected: boolean;
  shell: SessionRuntimeShellController;
}>();

const emit = defineEmits<{
  close: [];
}>();

const document_ = useSessionDocument(props.sessionId);
const appStore = useAppStore();
const retainedUiState = inject(SESSION_UI_STATE_KEY, null) as SessionRuntimeUiState | null;
const localSearch = ref('');
const settingsOpen = ref(false);
const search = computed({
  get: () => retainedUiState?.shellSearch.value ?? localSearch.value,
  set: (value) => {
    if (retainedUiState) retainedUiState.shellSearch.value = value;
    else localSearch.value = value;
  },
});
const terminalHost = ref<HTMLElement | null>(null);

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let stopOutput: (() => void) | null = null;
let stopReset: (() => void) | null = null;

const newlineChoices = [
  { label: t('shell.newline.none'), value: 'none' as const },
  { label: t('shell.newline.cr'), value: 'cr' as const },
  { label: t('shell.newline.lf'), value: 'lf' as const },
  { label: t('shell.newline.crlf'), value: 'crlf' as const },
];
const txNewlineOptions = newlineChoices;
const rxNewlineOptions = [
  { label: t('shell.newline.auto'), value: 'auto' as const },
  ...newlineChoices,
];
const encodingOptions = computed(() => [
  { label: t('shell.encoding.utf8'), value: 'utf-8' as const },
  { label: t('shell.encoding.gbk'), value: 'gbk' as const },
  { label: t('shell.encoding.latin1'), value: 'latin1' as const },
]);
const backspaceOptions = [
  { label: t('shell.backspace.bs'), value: 'bs' as const },
  { label: t('shell.backspace.del'), value: 'del' as const },
];

function cssVariable(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(window.document.documentElement).getPropertyValue(name).trim();
}

function xtermAnsiPalette(): Partial<ITheme> {
  return {
    black: cssVariable('--xterm-black'),
    red: cssVariable('--xterm-red'),
    green: cssVariable('--xterm-green'),
    yellow: cssVariable('--xterm-yellow'),
    blue: cssVariable('--xterm-blue'),
    magenta: cssVariable('--xterm-magenta'),
    cyan: cssVariable('--xterm-cyan'),
    white: cssVariable('--xterm-white'),
    brightBlack: cssVariable('--xterm-bright-black'),
    brightRed: cssVariable('--xterm-bright-red'),
    brightGreen: cssVariable('--xterm-bright-green'),
    brightYellow: cssVariable('--xterm-bright-yellow'),
    brightBlue: cssVariable('--xterm-bright-blue'),
    brightMagenta: cssVariable('--xterm-bright-magenta'),
    brightCyan: cssVariable('--xterm-bright-cyan'),
    brightWhite: cssVariable('--xterm-bright-white'),
  };
}

function terminalTheme(): ITheme {
  return {
    background: cssVariable('--bg-inset'),
    foreground: cssVariable('--text-primary'),
    cursor: cssVariable('--color-primary'),
    cursorAccent: cssVariable('--bg-inset'),
    selectionBackground: cssVariable('--terminal-selection'),
    ...xtermAnsiPalette(),
  };
}

function safeFit(): void {
  const host = terminalHost.value;
  if (!fitAddon || !host || host.clientWidth === 0 || host.clientHeight === 0) return;
  fitAddon.fit();
}

function handleCustomKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
    const selection = terminal?.getSelection();
    if (selection) void navigator.clipboard.writeText(selection);
    return false;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
    void navigator.clipboard.readText().then((text) => {
      if (text) terminal?.paste(text);
    });
    return false;
  }
  return true;
}

onMounted(() => {
  const host = terminalHost.value;
  if (!host) return;
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5_000,
    fontFamily: cssVariable('--font-mono') || 'monospace',
    fontSize: 13,
    lineHeight: 1.35,
    theme: terminalTheme(),
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.open(host);
  term.attachCustomKeyEventHandler(handleCustomKey);
  terminal = term;
  safeFit();
  const replay = props.shell.replay();
  if (replay.length > 0) term.write(replay, () => term.scrollToBottom());
  stopOutput = props.shell.onOutput((chunk) => term.write(chunk));
  stopReset = props.shell.onReset(() => term.reset());
  term.onData((data) => {
    if (props.isConnected) props.shell.handleTerminalData(data);
  });
  resizeObserver = new ResizeObserver(() => safeFit());
  resizeObserver.observe(host);
  term.focus();
});

onActivated(() => {
  safeFit();
  terminal?.scrollToBottom();
  terminal?.focus();
});

onBeforeUnmount(() => {
  stopOutput?.();
  stopOutput = null;
  stopReset?.();
  stopReset = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  searchAddon = null;
  fitAddon = null;
  terminal?.dispose();
  terminal = null;
});

watch(
  () => appStore.theme,
  async () => {
    await nextTick();
    if (terminal) terminal.options.theme = terminalTheme();
  },
);

watch(settingsOpen, async () => {
  await nextTick();
  safeFit();
});

function patch(next: Partial<SerialShellConfig>): void {
  document_.setShellConfig(props.sessionId, next);
}

function clearTerminal(): void {
  props.shell.clear();
  terminal?.focus();
}

function onSearchInput(value: string | null): void {
  const next = value ?? '';
  search.value = next;
  if (next) searchAddon?.findNext(next, { incremental: true });
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (event.shiftKey) findPrevious();
  else findNext();
}

function findNext(): void {
  if (search.value) searchAddon?.findNext(search.value);
}

function findPrevious(): void {
  if (search.value) searchAddon?.findPrevious(search.value);
}
</script>

<style scoped>
.shell-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  min-height: 0;
  height: 100%;
}

.shell-chrome {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--surface-lift), transparent), var(--bg-secondary);
  box-shadow: var(--shadow-inset);
  flex-shrink: 0;
}

.shell-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.shell-title {
  text-transform: uppercase;
  letter-spacing: 0.55px;
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.shell-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-2xs);
  font-family: var(--font-mono);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
}

.shell-link.is-online {
  color: var(--color-primary);
  border-color: var(--color-primary-muted);
  background: var(--color-primary-subtle);
}

.shell-link.is-offline {
  color: var(--accent-amber);
  border-color: var(--accent-amber-border);
  background: var(--accent-amber-subtle);
}

.shell-link-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 currentColor;
}

.shell-link.is-online .shell-link-dot {
  animation: shell-pulse 1.8s ease-out infinite;
}

.shell-search {
  flex: 1;
  min-width: 140px;
  max-width: 360px;
}

.shell-chrome-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.shell-settings {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.shell-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.shell-field-label {
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

.shell-key-hint {
  margin-left: auto;
  font-size: var(--font-size-2xs);
  color: var(--text-dim);
  white-space: nowrap;
}

.shell-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.shell-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px 8px 8px 10px;
  transition: opacity var(--transition-normal);
}

.shell-body.is-disconnected {
  opacity: 0.42;
  filter: saturate(0.7);
}

.shell-body :deep(.xterm) {
  height: 100%;
}

.shell-body :deep(.xterm-viewport) {
  overflow-y: auto;
}

.shell-overlay {
  position: absolute;
  inset: auto 0 12px 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.shell-overlay-pill {
  padding: 6px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--accent-amber-border);
  background: color-mix(in srgb, var(--bg-elevated) 88%, var(--accent-amber-subtle));
  color: var(--accent-amber);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(8px);
}

.shell-settings-enter-active,
.shell-settings-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.shell-settings-enter-from,
.shell-settings-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@keyframes shell-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
</style>
