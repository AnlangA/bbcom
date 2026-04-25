import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { DisplayMode } from '../types';

const STORAGE_KEY = 'bbcom-app-settings';

export const useAppStore = defineStore('app', () => {
  const displayMode = ref<DisplayMode>('HEX');
  const autoScroll = ref(true);
  const showTimestamp = ref(true);
  let loaded = false;

  async function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.displayMode) displayMode.value = s.displayMode;
        if (typeof s.autoScroll === 'boolean') autoScroll.value = s.autoScroll;
        if (typeof s.showTimestamp === 'boolean') showTimestamp.value = s.showTimestamp;
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
      }));
    } catch {
      // ignore
    }
  }

  watch([displayMode, autoScroll, showTimestamp], save);

  function setDisplayMode(mode: DisplayMode) {
    displayMode.value = mode;
  }

  function toggleAutoScroll() {
    autoScroll.value = !autoScroll.value;
  }

  function toggleShowTimestamp() {
    showTimestamp.value = !showTimestamp.value;
  }

  load();

  return {
    displayMode,
    autoScroll,
    showTimestamp,
    setDisplayMode,
    toggleAutoScroll,
    toggleShowTimestamp,
  };
});
