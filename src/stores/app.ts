import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { DisplayMode, LineEnding, PacketViewMode, SearchMode } from '../types';

const STORAGE_KEY = 'bbcom-app-settings';
const AI_API_KEY_STORAGE_KEY = `${STORAGE_KEY}:ai-api-key`;

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
  const aiApiKey = ref('');
  const aiModel = ref('glm-4.5-air');
  const aiEnableCodingPlan = ref(false);
  const aiCommandDraft = ref('');
  const aiCommandSeq = ref(0);
  const pendingAiCommand = ref('');
  let loaded = false;

  async function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.displayMode) displayMode.value = s.displayMode;
        if (typeof s.autoScroll === 'boolean') autoScroll.value = s.autoScroll;
        if (typeof s.showTimestamp === 'boolean') showTimestamp.value = s.showTimestamp;
        if (s.searchMode) searchMode.value = s.searchMode;
        if (s.packetViewMode) packetViewMode.value = s.packetViewMode;
        if (s.lineEnding) lineEnding.value = s.lineEnding;
        if (typeof s.sendAsHex === 'boolean') sendAsHex.value = s.sendAsHex;
        if (typeof s.loopIntervalMs === 'number') loopIntervalMs.value = s.loopIntervalMs;
        if (typeof s.ansiColorEnabled === 'boolean') ansiColorEnabled.value = s.ansiColorEnabled;
        if (typeof s.aiModel === 'string') aiModel.value = s.aiModel;
        if (typeof s.aiEnableCodingPlan === 'boolean') aiEnableCodingPlan.value = s.aiEnableCodingPlan;
      }
      const savedApiKey = localStorage.getItem(AI_API_KEY_STORAGE_KEY);
      if (savedApiKey) {
        aiApiKey.value = savedApiKey;
      }
    } catch {
      // ignore
    }
    loaded = true;
  }

  function save() {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        displayMode: displayMode.value,
        autoScroll: autoScroll.value,
        showTimestamp: showTimestamp.value,
        searchMode: searchMode.value,
        packetViewMode: packetViewMode.value,
        lineEnding: lineEnding.value,
        sendAsHex: sendAsHex.value,
        loopIntervalMs: loopIntervalMs.value,
        ansiColorEnabled: ansiColorEnabled.value,
        aiModel: aiModel.value,
        aiEnableCodingPlan: aiEnableCodingPlan.value,
      }));
    } catch {
      // ignore
    }
  }

  watch([displayMode, autoScroll, showTimestamp, searchMode, packetViewMode, lineEnding, sendAsHex, loopIntervalMs, ansiColorEnabled, aiModel, aiEnableCodingPlan], save);

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

  function setAiApiKey(value: string) {
    aiApiKey.value = value;
    try {
      if (value) {
        localStorage.setItem(AI_API_KEY_STORAGE_KEY, value);
      } else {
        localStorage.removeItem(AI_API_KEY_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }

  function setAiModel(value: string) {
    aiModel.value = value;
  }

  function setAiEnableCodingPlan(value: boolean) {
    aiEnableCodingPlan.value = value;
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
    aiModel,
    aiEnableCodingPlan,
    aiCommandDraft,
    aiCommandSeq,
    pendingAiCommand,
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
    setAiModel,
    setAiEnableCodingPlan,
    applyAiCommand,
    setPendingAiCommand,
    consumePendingAiCommand,
  };
});
