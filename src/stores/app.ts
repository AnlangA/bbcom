import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { DisplayMode, LineEnding, PacketViewMode, SearchMode } from '../types';
import { loadJson, saveJson } from '../lib/storage';
import {
  clearAiApiKey as clearAiApiKeyInKeyring,
  getAiKeyStatus,
  removeLegacyAiApiKey,
  setAiApiKey as setAiApiKeyInKeyring,
  type AiKeyStatus,
} from '../lib/ai-key';
import { maxBufferFrames, setMaxBufferFrames } from '../lib/buffer-config';
import { locale, setLocale } from '../lib/i18n';
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth } from '../lib/sidebar-layout';
import type { WorkspaceLayoutV1 } from '../features/workspace/types';

/** New workspace-era namespace. The 0.7.3 key remains read-only for G24. */
const STORAGE_KEY = 'bbcom-v1:app-settings';
const MISSING_AI_KEY_STATUS: AiKeyStatus = { configured: false, durability: 'missing' };
const DISPLAY_MODES: readonly DisplayMode[] = ['HEX', 'HEXASCII', 'ASCII', 'ANSI', 'UTF8'];
const SEARCH_MODES: readonly SearchMode[] = ['TEXT', 'HEX'];
const PACKET_VIEW_MODES: readonly PacketViewMode[] = ['FRAME', 'MERGED'];
const LINE_ENDINGS: readonly LineEnding[] = ['none', 'CR', 'LF', 'CRLF'];

function isEnumValue<T extends string>(raw: unknown, values: readonly T[]): raw is T {
  return typeof raw === 'string' && values.includes(raw as T);
}

export const useAppStore = defineStore('app', () => {
  const displayMode = ref<DisplayMode>('HEX');
  const autoScroll = ref(true);
  const showTimestamp = ref(true);
  const searchMode = ref<SearchMode>('TEXT');
  const packetViewMode = ref<PacketViewMode>('FRAME');
  const lineEnding = ref<LineEnding>('none');
  const sendAsHex = ref(false);
  const loopIntervalMs = ref(1000);
  const ansiColorEnabled = ref(true);
  const preserveLogLineBreaks = ref(true);
  const autoReconnect = ref(false);
  const theme = ref<'dark' | 'light'>('dark');
  const aiKeyStatus = ref<AiKeyStatus>(MISSING_AI_KEY_STATUS);
  const aiKeyConfigured = computed(() => aiKeyStatus.value.configured);
  const aiCommandDraft = ref('');
  const aiCommandSeq = ref(0);
  const pendingAiCommand = ref('');
  const aiApiKeyLoaded = ref(false);
  const sidebarWidth = ref(SIDEBAR_WIDTH_DEFAULT);
  const sidebarCollapsed = ref(false);
  const workspaceLayoutListeners = new Set<(layout: WorkspaceLayoutV1) => void>();
  let loaded = false;

  // Single source of truth for every persisted (non-secret) setting.
  //
  // Each descriptor owns its storage key, the reactive ref it binds to, a
  // `validate(raw) -> boolean` predicate (matches the per-field `typeof`/truthy
  // guards the hand-written load() used), and an `apply(raw)` that assigns the
  // (already-validated) value back into the ref — including any clamping or
  // special routing (sidebarWidth bounds, maxBufferFrames via its setter).
  // load(), save(), and the persistence watch all iterate this one table, so a
  // new setting is a one-line append instead of three synchronized edits.
  interface PersistedSetting {
    key: string;
    ref: ReturnType<typeof ref>;
    validate: (raw: unknown) => boolean;
    apply: (raw: unknown) => void;
  }

  const persistedSettings: PersistedSetting[] = [
    {
      key: 'displayMode',
      ref: displayMode,
      validate: (raw) => isEnumValue(raw, DISPLAY_MODES),
      apply: (raw) => {
        displayMode.value = raw as DisplayMode;
      },
    },
    {
      key: 'autoScroll',
      ref: autoScroll,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        autoScroll.value = raw as boolean;
      },
    },
    {
      key: 'showTimestamp',
      ref: showTimestamp,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        showTimestamp.value = raw as boolean;
      },
    },
    {
      key: 'searchMode',
      ref: searchMode,
      validate: (raw) => isEnumValue(raw, SEARCH_MODES),
      apply: (raw) => {
        searchMode.value = raw as SearchMode;
      },
    },
    {
      key: 'packetViewMode',
      ref: packetViewMode,
      validate: (raw) => isEnumValue(raw, PACKET_VIEW_MODES),
      apply: (raw) => {
        packetViewMode.value = raw as PacketViewMode;
      },
    },
    {
      key: 'lineEnding',
      ref: lineEnding,
      validate: (raw) => isEnumValue(raw, LINE_ENDINGS),
      apply: (raw) => {
        lineEnding.value = raw as LineEnding;
      },
    },
    {
      key: 'sendAsHex',
      ref: sendAsHex,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        sendAsHex.value = raw as boolean;
      },
    },
    {
      key: 'loopIntervalMs',
      ref: loopIntervalMs,
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => {
        loopIntervalMs.value = raw as number;
      },
    },
    {
      key: 'ansiColorEnabled',
      ref: ansiColorEnabled,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        ansiColorEnabled.value = raw as boolean;
      },
    },
    {
      key: 'preserveLogLineBreaks',
      ref: preserveLogLineBreaks,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        preserveLogLineBreaks.value = raw as boolean;
      },
    },
    {
      key: 'sidebarWidth',
      ref: sidebarWidth,
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => {
        sidebarWidth.value = clampSidebarWidth(raw as number);
      },
    },
    {
      key: 'sidebarCollapsed',
      ref: sidebarCollapsed,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        sidebarCollapsed.value = raw as boolean;
      },
    },
    {
      key: 'maxBufferFrames',
      ref: maxBufferFrames,
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => setMaxBufferFrames(raw as number),
    },
    {
      key: 'autoReconnect',
      ref: autoReconnect,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        autoReconnect.value = raw as boolean;
      },
    },
    {
      key: 'theme',
      ref: theme,
      validate: (raw) => raw === 'light' || raw === 'dark',
      apply: (raw) => {
        theme.value = raw as 'dark' | 'light';
      },
    },
    {
      key: 'locale',
      // The i18n locale ref (reactive). Persisted as 'en' or 'zh'; defaults to 'zh'.
      ref: locale,
      validate: (raw) => raw === 'en' || raw === 'zh',
      apply: (raw) => {
        locale.value = raw as 'en' | 'zh';
      },
    },
  ];

  async function load() {
    const defaults: Record<string, unknown> = {};
    for (const s of persistedSettings) defaults[s.key] = s.ref.value;

    const saved = loadJson(STORAGE_KEY, defaults);
    for (const s of persistedSettings) {
      const raw = (saved as Record<string, unknown>)[s.key];
      if (s.validate(raw)) s.apply(raw);
    }
    loaded = true;
    void refreshAiKeyStatus();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function writeSettings(): boolean {
    const payload: Record<string, unknown> = {};
    for (const s of persistedSettings) payload[s.key] = s.ref.value;
    return saveJson(STORAGE_KEY, payload);
  }

  function save() {
    if (!loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeSettings();
    }, 300);
  }

  /** Cancel the debounce and synchronously persist the current settings snapshot. */
  function flushSettings(): boolean {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    return loaded && writeSettings();
  }

  watch(
    persistedSettings.map((s) => s.ref),
    save,
  );

  function setDisplayMode(mode: DisplayMode) {
    displayMode.value = mode;
  }

  function toggleAutoScroll() {
    autoScroll.value = !autoScroll.value;
  }

  function toggleShowTimestamp() {
    showTimestamp.value = !showTimestamp.value;
  }

  function setSearchMode(mode: SearchMode) {
    searchMode.value = mode;
  }

  function setPacketViewMode(mode: PacketViewMode) {
    packetViewMode.value = mode;
  }

  function setLineEnding(value: LineEnding) {
    lineEnding.value = value;
  }

  function toggleAnsiColor() {
    ansiColorEnabled.value = !ansiColorEnabled.value;
  }

  function toggleLogLineBreaks() {
    preserveLogLineBreaks.value = !preserveLogLineBreaks.value;
  }

  function setSendAsHex(value: boolean) {
    sendAsHex.value = value;
  }

  function setLoopIntervalMs(value: number) {
    loopIntervalMs.value = Math.max(50, Math.min(3_600_000, Math.floor(value || 1000)));
  }

  async function setAiApiKey(value: string): Promise<boolean> {
    const normalized = value.trim();
    aiApiKeyLoaded.value = false;
    try {
      if (normalized) {
        aiKeyStatus.value = await setAiApiKeyInKeyring(normalized);
      } else {
        // Explicit user clear is a deletion request, not a migration: erase a
        // stale legacy plaintext copy even if the native backend is offline.
        removeLegacyAiApiKey();
        await clearAiApiKeyInKeyring();
        aiKeyStatus.value = MISSING_AI_KEY_STATUS;
      }
      return true;
    } catch {
      return false;
    } finally {
      aiApiKeyLoaded.value = true;
    }
  }

  function setTheme(value: 'dark' | 'light') {
    theme.value = value;
  }

  function applyAiCommand(command: string) {
    aiCommandDraft.value = command;
    aiCommandSeq.value += 1;
  }

  function setPendingAiCommand(command: string) {
    pendingAiCommand.value = command;
  }

  function consumePendingAiCommand(): string {
    const command = pendingAiCommand.value;
    pendingAiCommand.value = '';
    return command;
  }

  function setSidebarWidth(width: number) {
    const next = clampSidebarWidth(width);
    if (sidebarWidth.value === next) return;
    sidebarWidth.value = next;
    notifyWorkspaceLayoutChanged();
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
    notifyWorkspaceLayoutChanged();
  }

  function workspaceLayoutSnapshot(): WorkspaceLayoutV1 {
    return Object.freeze({
      version: 1,
      sidebar: Object.freeze({
        width: clampSidebarWidth(sidebarWidth.value),
        collapsed: sidebarCollapsed.value,
      }),
    });
  }

  function applyWorkspaceLayout(layout: WorkspaceLayoutV1): void {
    sidebarWidth.value = clampSidebarWidth(layout.sidebar.width);
    sidebarCollapsed.value = layout.sidebar.collapsed;
  }

  function subscribeWorkspaceLayout(listener: (layout: WorkspaceLayoutV1) => void): () => void {
    workspaceLayoutListeners.add(listener);
    return () => workspaceLayoutListeners.delete(listener);
  }

  function notifyWorkspaceLayoutChanged(): void {
    const layout = workspaceLayoutSnapshot();
    for (const listener of workspaceLayoutListeners) {
      try {
        listener(layout);
      } catch {
        // A layout observer cannot interfere with the app settings store.
      }
    }
  }

  async function refreshAiKeyStatus(): Promise<void> {
    aiApiKeyLoaded.value = false;
    try {
      // G24 keeps every 0.7.3 source byte read-only until the one-time reset
      // gate has completed. In particular, startup must not migrate and delete
      // the legacy plaintext key before the backup snapshot is taken.
      aiKeyStatus.value = await getAiKeyStatus();
    } catch {
      aiKeyStatus.value = MISSING_AI_KEY_STATUS;
    } finally {
      aiApiKeyLoaded.value = true;
    }
  }

  void load();

  return {
    displayMode,
    autoScroll,
    showTimestamp,
    searchMode,
    packetViewMode,
    lineEnding,
    sendAsHex,
    loopIntervalMs,
    ansiColorEnabled,
    preserveLogLineBreaks,
    aiKeyStatus,
    aiKeyConfigured,
    maxBufferFrames,
    autoReconnect,
    theme,
    locale,
    aiCommandDraft,
    aiCommandSeq,
    pendingAiCommand,
    aiApiKeyLoaded,
    sidebarWidth,
    sidebarCollapsed,
    setDisplayMode,
    toggleAutoScroll,
    toggleShowTimestamp,
    setSearchMode,
    setPacketViewMode,
    setLineEnding,
    toggleAnsiColor,
    toggleLogLineBreaks,
    setSendAsHex,
    setLoopIntervalMs,
    setAiApiKey,
    refreshAiKeyStatus,
    setTheme,
    setMaxBufferFrames,
    setLocale,
    applyAiCommand,
    setPendingAiCommand,
    consumePendingAiCommand,
    setSidebarWidth,
    toggleSidebarCollapsed,
    workspaceLayoutSnapshot,
    applyWorkspaceLayout,
    subscribeWorkspaceLayout,
    flushSettings,
  };
});
