import { watch, type Ref } from 'vue';
import { AnsiUp } from 'ansi_up';
import { formatAscii, formatHex, formatUtf8 } from '../lib/format';
import { LRUCache } from '../lib/lru-cache';
import { CACHE_SIZE, type DataFrame, type DisplayMode } from '../types';

interface PacketFormatterOptions {
  displayMode: Ref<DisplayMode>;
  ansiColorEnabled: Ref<boolean>;
}

const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

export function usePacketFormatter({ displayMode, ansiColorEnabled }: PacketFormatterOptions) {
  const formatCache = new LRUCache<string, string>(CACHE_SIZE);
  const hexSearchCache = new LRUCache<string, string>(CACHE_SIZE);
  const textSearchCache = new LRUCache<string, string>(CACHE_SIZE);
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = false;

  function formatFrame(frame: DataFrame): string {
    const key = `${frame.id}:${displayMode.value}:${ansiColorEnabled.value}`;
    const cached = formatCache.get(key);
    if (cached !== undefined) return cached;

    let result: string;
    switch (displayMode.value) {
      case 'HEX':
        result = formatHex(frame.data);
        break;
      case 'ANSI':
      case 'ASCII': {
        const text = formatAscii(frame.data);
        result = ansiColorEnabled.value ? ansiUp.ansi_to_html(text) : text;
        break;
      }
      case 'UTF8': {
        const text = formatUtf8(frame.data);
        result = ansiColorEnabled.value ? ansiUp.ansi_to_html(text) : text;
        break;
      }
      default:
        result = formatAscii(frame.data);
        break;
    }

    formatCache.set(key, result);
    return result;
  }

  function getHexSearchData(frame: DataFrame): string {
    const cached = hexSearchCache.get(frame.id);
    if (cached !== undefined) return cached;
    const result = formatHex(frame.data).replace(/\s/g, '').toLowerCase();
    hexSearchCache.set(frame.id, result);
    return result;
  }

  function getTextSearchData(frame: DataFrame): string {
    const cached = textSearchCache.get(frame.id);
    if (cached !== undefined) return cached;
    const result = stripAnsi(formatUtf8(frame.data)).toLowerCase();
    textSearchCache.set(frame.id, result);
    return result;
  }

  function stripAnsi(text: string): string {
    return text.replace(ANSI_RE, '');
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
