import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { DisplayMode, LineEnding, PacketViewMode, SearchMode } from '../types';
import { loadJson, loadString, saveJson, saveString } from '../lib/storage';

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
    const saved = loadJson(STORAGE_KEY, {
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
    });
    if (saved.displayMode) displayMode.value = saved.displayMode;
    if (typeof saved.autoScroll === 'boolean') autoScroll.value = saved.autoScroll;
    if (typeof saved.showTimestamp === 'boolean') showTimestamp.value = saved.showTimestamp;
    if (saved.searchMode) searchMode.value = saved.searchMode;
    if (saved.packetViewMode) packetViewMode.value = saved.packetViewMode;
    if (saved.lineEnding) lineEnding.value = saved.lineEnding;
    if (typeof saved.sendAsHex === 'boolean') sendAsHex.value = saved.sendAsHex;
    if (typeof saved.loopIntervalMs === 'number') loopIntervalMs.value = saved.loopIntervalMs;
    if (typeof saved.ansiColorEnabled === 'boolean') ansiColorEnabled.value = saved.ansiColorEnabled;
    if (typeof saved.aiModel === 'string') aiModel.value = saved.aiModel;
    if (typeof saved.aiEnableCodingPlan === 'boolean') aiEnableCodingPlan.value = saved.aiEnableCodingPlan;
    aiApiKey.value = loadString(AI_API_KEY_STORAGE_KEY);
    loaded = true;
  }

  function save() {
    if (!loaded) return;
    saveJson(STORAGE_KEY, {
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
    });
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
    saveString(AI_API_KEY_STORAGE_KEY, value);
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
