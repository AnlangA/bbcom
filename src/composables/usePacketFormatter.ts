import { watch, type Ref } from 'vue';
import { AnsiUp } from 'ansi_up';
import {
  formatAscii,
  formatHex,
  formatUtf8,
  stripAnsiEscapes,
  toContinuousHex,
} from '../lib/format';
import { LRUCache } from '../lib/lru-cache';
import { CACHE_SIZE, type DataFrame, type DisplayMode } from '../types';

interface PacketFormatterOptions {
  displayMode: Ref<DisplayMode>;
  ansiColorEnabled: Ref<boolean>;
}

export function usePacketFormatter({ displayMode, ansiColorEnabled }: PacketFormatterOptions) {
  const formatCache = new LRUCache<string, string>(CACHE_SIZE);
  const hexSearchCache = new LRUCache<string, string>(CACHE_SIZE);
  const textSearchCache = new LRUCache<string, string>(CACHE_SIZE);
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = false;
  ansiUp.escape_html = true;
  ansiUp.url_allowlist = {};

  function formatRaw(frame: DataFrame): string {
    switch (displayMode.value) {
      case 'HEX':
        return formatHex(frame.data);
      case 'ANSI':
      case 'ASCII': {
        const text = formatAscii(frame.data);
        return ansiColorEnabled.value ? ansiUp.ansi_to_html(text) : text;
      }
      case 'UTF8': {
        const text = formatUtf8(frame.data);
        return ansiColorEnabled.value ? ansiUp.ansi_to_html(text) : text;
      }
      default:
        return formatAscii(frame.data);
    }
  }

  function formatFrame(frame: DataFrame): string {
    // Merged frames keep a stable id (`merged-<firstFrameId>`) while their
    // concatenated data grows on every rebuild. They must bypass the id-keyed
    // cache, otherwise they'd render stale content during streaming. Only the
    // visible merged rows re-render, so the cost of skipping the cache is tiny.
    if (frame.id.startsWith('merged-')) {
      return formatRaw(frame);
    }

    const key = `${frame.id}:${displayMode.value}:${ansiColorEnabled.value}`;
    const cached = formatCache.get(key);
    if (cached !== undefined) return cached;

    const result = formatRaw(frame);
    formatCache.set(key, result);
    return result;
  }

  function getHexSearchData(frame: DataFrame): string {
    const cached = hexSearchCache.get(frame.id);
    if (cached !== undefined) return cached;
    const result = toContinuousHex(frame.data);
    hexSearchCache.set(frame.id, result);
    return result;
  }

  function getTextSearchData(frame: DataFrame): string {
    const cached = textSearchCache.get(frame.id);
    if (cached !== undefined) return cached;
    const result = stripAnsiEscapes(formatUtf8(frame.data)).toLowerCase();
    textSearchCache.set(frame.id, result);
    return result;
  }

  function stripAnsi(text: string): string {
    return stripAnsiEscapes(text);
  }

  function clearCaches() {
    formatCache.clear();
    hexSearchCache.clear();
    textSearchCache.clear();
  }

  watch([displayMode, ansiColorEnabled], () => {
    formatCache.clear();
  });

  return {
    formatFrame,
    getHexSearchData,
    getTextSearchData,
    stripAnsi,
    clearCaches,
  };
}
