import { watch, type Ref } from 'vue';
import { AnsiUp } from 'ansi_up';
import {
  formatAscii,
  formatHex,
  formatHexAscii,
  formatUtf8,
  stripAnsiEscapes,
  toContinuousHex,
} from '../lib/format';
import {
  TERMINAL_CACHE_ENTRY_MAX_BYTES,
  TERMINAL_CACHE_MAX_BYTES,
  type DataFrame,
  type DisplayMode,
} from '../types';

interface PacketFormatterOptions {
  displayMode: Ref<DisplayMode>;
  ansiColorEnabled: Ref<boolean>;
}

interface CacheEntry {
  frameId: string;
  value: string;
  bytes: number;
}

export interface PacketFormatterCacheStats {
  bytes: number;
  entries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

/** One LRU budget shared by format, HEX-search, and text-search strings. */
class SharedStringCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly keysByFrame = new Map<string, Set<string>>();
  private usedBytes = 0;

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, frameId: string, value: string): void {
    // JavaScript strings are UTF-16; account for both the value and key so
    // the declared 16 MiB ceiling remains conservative in the live heap.
    const bytes = (key.length + value.length) * 2;
    this.delete(key);
    if (bytes > TERMINAL_CACHE_ENTRY_MAX_BYTES) return;

    while (this.usedBytes + bytes > TERMINAL_CACHE_MAX_BYTES && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
    if (this.usedBytes + bytes > TERMINAL_CACHE_MAX_BYTES) return;

    this.entries.set(key, { frameId, value, bytes });
    let keys = this.keysByFrame.get(frameId);
    if (!keys) {
      keys = new Set();
      this.keysByFrame.set(frameId, keys);
    }
    keys.add(key);
    this.usedBytes += bytes;
  }

  deleteFrame(frameId: string): void {
    const keys = this.keysByFrame.get(frameId);
    if (!keys) return;
    for (const key of [...keys]) this.delete(key);
  }

  clearKind(kind: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(kind)) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.keysByFrame.clear();
    this.usedBytes = 0;
  }

  stats(): PacketFormatterCacheStats {
    return {
      bytes: this.usedBytes,
      entries: this.entries.size,
      maxBytes: TERMINAL_CACHE_MAX_BYTES,
      maxEntryBytes: TERMINAL_CACHE_ENTRY_MAX_BYTES,
    };
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.usedBytes -= entry.bytes;
    const keys = this.keysByFrame.get(entry.frameId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.keysByFrame.delete(entry.frameId);
  }
}

export function usePacketFormatter({ displayMode, ansiColorEnabled }: PacketFormatterOptions) {
  const cache = new SharedStringCache();
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = false;
  ansiUp.escape_html = true;
  ansiUp.url_allowlist = {};

  function formatRaw(frame: DataFrame): string {
    switch (displayMode.value) {
      case 'HEX':
        return formatHex(frame.data);
      case 'HEXASCII':
        // Hex-editor dump: 16 bytes per line plus an ASCII gutter. Never passes
        // through ansi_up — the multi-line plain text is rendered as-is.
        return formatHexAscii(frame.data);
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

  function isMerged(frame: DataFrame): boolean {
    return frame.id.startsWith('merged-') || frame.contentVersion !== undefined;
  }

  function formatFrame(frame: DataFrame): string {
    // A rope row keeps its first-frame id while its tail/content version moves.
    // Its 64 KiB tail would also exceed the per-entry cache ceiling in HEX
    // mode, so format it directly and leave the shared cache for small source
    // frames that are reused by virtual rows and filtering.
    if (isMerged(frame)) return formatRaw(frame);

    const key = `format:${frame.id}:${displayMode.value}:${ansiColorEnabled.value}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const result = formatRaw(frame);
    cache.set(key, frame.id, result);
    return result;
  }

  function getHexSearchData(frame: DataFrame): string {
    const key = `hex:${frame.id}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = toContinuousHex(frame.data);
    cache.set(key, frame.id, result);
    return result;
  }

  function getTextSearchData(frame: DataFrame): string {
    const key = `text:${frame.id}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = stripAnsiEscapes(formatUtf8(frame.data)).toLowerCase();
    cache.set(key, frame.id, result);
    return result;
  }

  function stripAnsi(text: string): string {
    return stripAnsiEscapes(text);
  }

  function clearCaches() {
    cache.clear();
  }

  function evictFrames(frames: readonly DataFrame[]) {
    for (const frame of frames) cache.deleteFrame(frame.id);
  }

  watch([displayMode, ansiColorEnabled], () => {
    cache.clearKind('format:');
  });

  return {
    formatFrame,
    getHexSearchData,
    getTextSearchData,
    stripAnsi,
    clearCaches,
    evictFrames,
    getCacheStats: () => cache.stats(),
  };
}
