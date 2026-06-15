import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { DisplayMode, LineEnding, PacketViewMode, SearchMode } from '../types';
import { loadJson, loadString, saveJson, saveString } from '../lib/storage';
import { clearSecretString, loadSecretString, saveSecretString } from '../lib/secure-settings';
import { maxBufferFrames, setMaxBufferFrames } from '../lib/buffer-config';
import { locale, setLocale } from '../lib/i18n';

const STORAGE_KEY = 'bbcom-app-settings';
const AI_API_KEY_STORAGE_KEY = `${STORAGE_KEY}:ai-api-key`;
const AI_API_KEY_SECRET_KEY = 'ai-api-key';

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
  const autoReconnect = ref(false);
  const theme = ref<'dark' | 'light'>('dark');
  const aiApiKey = ref('');
  const aiEnableCodingPlan = ref(false);
  const aiCommandDraft = ref('');
  const aiCommandSeq = ref(0);
  const pendingAiCommand = ref('');
  const aiApiKeyLoaded = ref(false);
  const sidebarWidth = ref(292);
  const sidebarCollapsed = ref(false);
  let loaded = false;
  let aiKeyLoadSeq = 0;

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

  const SIDEBAR_WIDTH_MIN = 252;
  const SIDEBAR_WIDTH_MAX = 340;

  const persistedSettings: PersistedSetting[] = [
    {
      key: 'displayMode',
      ref: displayMode,
      validate: (raw) => Boolean(raw),
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
      validate: (raw) => Boolean(raw),
      apply: (raw) => {
        searchMode.value = raw as SearchMode;
      },
    },
    {
      key: 'packetViewMode',
      ref: packetViewMode,
      validate: (raw) => Boolean(raw),
      apply: (raw) => {
        packetViewMode.value = raw as PacketViewMode;
      },
    },
    {
      key: 'lineEnding',
      ref: lineEnding,
      validate: (raw) => Boolean(raw),
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
      key: 'aiEnableCodingPlan',
      ref: aiEnableCodingPlan,
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        aiEnableCodingPlan.value = raw as boolean;
      },
    },
    {
      key: 'sidebarWidth',
      ref: sidebarWidth,
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => {
        sidebarWidth.value = Math.max(
          SIDEBAR_WIDTH_MIN,
          Math.min(SIDEBAR_WIDTH_MAX, raw as number),
        );
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
    aiApiKey.value = loadString(AI_API_KEY_STORAGE_KEY);
    loaded = true;
    void loadAiApiKey();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function save() {
    if (!loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload: Record<string, unknown> = {};
      for (const s of persistedSettings) payload[s.key] = s.ref.value;
      saveJson(STORAGE_KEY, payload);
    }, 300);
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

  function setSendAsHex(value: boolean) {
    sendAsHex.value = value;
  }

  function setLoopIntervalMs(value: number) {
    loopIntervalMs.value = Math.max(50, Math.min(3_600_000, Math.floor(value || 1000)));
  }

  async function setAiApiKey(value: string): Promise<boolean> {
    const normalized = value.trim();
    const previous = aiApiKey.value;
    aiApiKey.value = normalized;
    const ok = await persistAiApiKey(normalized);
    if (!ok) {
      aiApiKey.value = previous;
    }
    return ok;
  }

  function setAiEnableCodingPlan(value: boolean) {
    aiEnableCodingPlan.value = value;
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
    sidebarWidth.value = Math.max(252, Math.min(340, Math.round(width)));
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  async function loadAiApiKey() {
    const seq = (aiKeyLoadSeq += 1);
    aiApiKeyLoaded.value = false;
    try {
      const legacyValue = loadString(AI_API_KEY_STORAGE_KEY);
      const storedValue = await loadSecretString(AI_API_KEY_SECRET_KEY);
      if (seq !== aiKeyLoadSeq) return;

      if (storedValue) {
        aiApiKey.value = storedValue;
        if (legacyValue) saveString(AI_API_KEY_STORAGE_KEY, '');
        return;
      }

      if (legacyValue) {
        aiApiKey.value = legacyValue;
        const migrated = await saveSecretString(AI_API_KEY_SECRET_KEY, legacyValue);
        if (migrated) saveString(AI_API_KEY_STORAGE_KEY, '');
      }
    } finally {
      if (seq === aiKeyLoadSeq) {
        aiApiKeyLoaded.value = true;
      }
    }
  }

  async function persistAiApiKey(value: string): Promise<boolean> {
    const storeOk = value
      ? await saveSecretString(AI_API_KEY_SECRET_KEY, value)
      : await clearSecretString(AI_API_KEY_SECRET_KEY);

    const fallbackOk = saveString(AI_API_KEY_STORAGE_KEY, storeOk ? '' : value);
    return storeOk || fallbackOk;
  }

  load();

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
    aiApiKey,
    aiEnableCodingPlan,
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
    setSendAsHex,
    setLoopIntervalMs,
    setAiApiKey,
    setAiEnableCodingPlan,
    setTheme,
    setMaxBufferFrames,
    setLocale,
    applyAiCommand,
    setPendingAiCommand,
    consumePendingAiCommand,
    setSidebarWidth,
    toggleSidebarCollapsed,
  };
});
