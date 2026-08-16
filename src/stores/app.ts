import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { DisplayMode, LineEnding, PacketViewMode, SearchMode } from '../types';
import { settingsService } from '../features/settings';
import {
  clearAiApiKey as clearAiApiKeyInKeyring,
  getAiKeyStatus,
  removeLegacyAiApiKey,
  setAiApiKey as setAiApiKeyInKeyring,
  type AiKeyStatus,
} from '../features/settings';
import { maxBufferFrames, setMaxBufferFrames } from '../lib/buffer-config';
import { locale, setLocale, ensureLocaleLoaded } from '../lib/i18n';

const MISSING_AI_KEY_STATUS: AiKeyStatus = { configured: false, durability: 'missing' };

function isEnumValue<T extends string>(raw: unknown, values: readonly T[]): raw is T {
  return typeof raw === 'string' && values.includes(raw as T);
}

// Runtime enum guards used when applying the hydrated global settings document.
const DISPLAY_MODES: readonly DisplayMode[] = ['HEX', 'HEXASCII', 'ASCII', 'ANSI', 'UTF8'];
const SEARCH_MODES: readonly SearchMode[] = ['TEXT', 'HEX'];
const PACKET_VIEW_MODES: readonly PacketViewMode[] = ['FRAME', 'MERGED'];
const LINE_ENDINGS: readonly LineEnding[] = ['none', 'CR', 'LF', 'CRLF'];

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

  // The store is a reactive projection of the single global settings document
  // owned by `settingsService`; it no longer touches localStorage itself.
  interface HydratedSetting {
    validate: (raw: unknown) => boolean;
    apply: (raw: unknown) => void;
  }

  const persistedSettings: (HydratedSetting & { key: string })[] = [
    {
      key: 'displayMode',
      validate: (raw) => isEnumValue(raw, DISPLAY_MODES),
      apply: (raw) => {
        displayMode.value = raw as DisplayMode;
      },
    },
    {
      key: 'autoScroll',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        autoScroll.value = raw as boolean;
      },
    },
    {
      key: 'showTimestamp',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        showTimestamp.value = raw as boolean;
      },
    },
    {
      key: 'searchMode',
      validate: (raw) => isEnumValue(raw, SEARCH_MODES),
      apply: (raw) => {
        searchMode.value = raw as SearchMode;
      },
    },
    {
      key: 'packetViewMode',
      validate: (raw) => isEnumValue(raw, PACKET_VIEW_MODES),
      apply: (raw) => {
        packetViewMode.value = raw as PacketViewMode;
      },
    },
    {
      key: 'lineEnding',
      validate: (raw) => isEnumValue(raw, LINE_ENDINGS),
      apply: (raw) => {
        lineEnding.value = raw as LineEnding;
      },
    },
    {
      key: 'sendAsHex',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        sendAsHex.value = raw as boolean;
      },
    },
    {
      key: 'loopIntervalMs',
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => {
        loopIntervalMs.value = raw as number;
      },
    },
    {
      key: 'ansiColorEnabled',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        ansiColorEnabled.value = raw as boolean;
      },
    },
    {
      key: 'preserveLogLineBreaks',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        preserveLogLineBreaks.value = raw as boolean;
      },
    },
    {
      key: 'maxBufferFrames',
      validate: (raw) => typeof raw === 'number',
      apply: (raw) => setMaxBufferFrames(raw as number),
    },
    {
      key: 'autoReconnect',
      validate: (raw) => typeof raw === 'boolean',
      apply: (raw) => {
        autoReconnect.value = raw as boolean;
      },
    },
    {
      key: 'theme',
      validate: (raw) => raw === 'light' || raw === 'dark',
      apply: (raw) => {
        theme.value = raw as 'dark' | 'light';
      },
    },
    {
      key: 'locale',
      // The i18n locale ref (reactive). Persisted as 'en' or 'zh'; defaults to 'zh'.
      validate: (raw) => raw === 'en' || raw === 'zh',
      apply: (raw) => {
        locale.value = raw as 'en' | 'zh';
        // Only the default locale (zh) is bundled synchronously; start the
        // lazy loader for a persisted non-default locale so English fallback
        // text resumes as soon as its chunk arrives.
        void ensureLocaleLoaded(raw as 'en' | 'zh');
      },
    },
  ];

  const settingRefs: Record<string, ReturnType<typeof ref>> = {
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
    maxBufferFrames,
    autoReconnect,
    theme,
    locale,
  };

  function load() {
    const boot = settingsService.hydrate();
    for (const s of persistedSettings) {
      const raw = (boot.settings as unknown as Record<string, unknown>)[s.key];
      if (s.validate(raw)) s.apply(raw);
    }
    void refreshAiKeyStatus();
  }

  function save() {
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(settingRefs)) patch[key] = settingRefs[key].value;
    settingsService.update(patch);
  }

  /** Cancel the debounce and synchronously persist the current settings snapshot. */
  function flushSettings(): boolean {
    return settingsService.flush();
  }

  watch(Object.values(settingRefs), save);

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
    flushSettings,
  };
});
