import { computed, markRaw, onScopeDispose, ref, watch, type Ref } from 'vue';
import { MergedFrameRopeIndex } from '@/lib/merged-frame-rope';
import { TERMINAL_CACHE_ENTRY_MAX_BYTES } from '@/types/constants';
import type { DataFrame, DirectionFilter, PacketViewMode, SearchMode } from '@/types';

interface PacketFilterOptions {
  frames: Ref<DataFrame[]>;
  framesVersion?: Readonly<Ref<unknown>>;
  searchMode: Ref<SearchMode>;
  packetViewMode: Ref<PacketViewMode>;
  getHexSearchData: (frame: DataFrame) => string;
  getTextSearchData: (frame: DataFrame) => string;
  /** Called synchronously when rolling-frame retention replaces source rows. */
  onFramesReplaced?: () => void;
  /** Externally owned filter state (session-runtime retention across view
   * remounts). When omitted the composable allocates its own local refs. */
  directionFilter?: Ref<DirectionFilter>;
  searchInput?: Ref<string>;
}

const SEARCH_DEBOUNCE_MS = 150;
const STREAM_SEARCH_SLICE_BYTES = 8 * 1024;
const HEX_DIGITS = '0123456789abcdef';
const ESCAPE = String.fromCharCode(27);

/**
 * Frame filtering plus an incremental rope-backed MERGED projection.
 *
 * Source frame arrays are mutated in place by the session store. A frame
 * version pulse drives reconciliation, while append-only changes update only
 * the newly added rows. Rolling-buffer replacement triggers one rebuild and
 * cache eviction rather than silently retaining stale descriptors.
 */
export function usePacketFilter({
  frames,
  framesVersion,
  searchMode,
  packetViewMode,
  getHexSearchData,
  getTextSearchData,
  onFramesReplaced,
  directionFilter: retainedDirectionFilter,
  searchInput: retainedSearchInput,
}: PacketFilterOptions) {
  const directionFilter = retainedDirectionFilter ?? ref<DirectionFilter>('ALL');
  const searchInput = retainedSearchInput ?? ref('');
  const searchQuery = ref('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  let cachedFiltered: DataFrame[] = [];
  let cachedSource: DataFrame[] | null = null;
  let cachedSourceCount = 0;
  let cachedSourceLast: DataFrame | undefined;
  let needsFullRebuild = true;
  let sourceReplacementPending = false;

  const mergedIndex = new MergedFrameRopeIndex(markRaw);
  let mergedSourceCount = 0;
  let mergedSourceLast: DataFrame | undefined;
  let mergedNeedsFullRebuild = true;

  function matchesFilter(
    frame: DataFrame,
    query: string,
    hasDirection: boolean,
    hasSearch: boolean,
    hexNeedle: string,
  ): boolean {
    if (hasDirection && frame.direction !== directionFilter.value) return false;
    if (!hasSearch) return true;

    // Search source chunks directly when a frame would otherwise create a
    // cache entry above 64 KiB. This keeps large serial payload search bounded
    // and also preserves matches that cross our 8 KiB streaming slices.
    if (frame.data.byteLength > TERMINAL_CACHE_ENTRY_MAX_BYTES) {
      return searchMode.value === 'HEX'
        ? hexChunksInclude([frame.data], hexNeedle)
        : textChunksInclude([frame.data], query);
    }

    if (searchMode.value === 'HEX') {
      return hexNeedle.length > 0 && getHexSearchData(frame).includes(hexNeedle);
    }
    return getTextSearchData(frame).includes(query);
  }

  function sourceWasReplaced(source: DataFrame[]): boolean {
    if (!cachedSource || cachedSourceCount === 0) return false;
    // For a pure append, the frame that used to end the source is still at the
    // previous final index. A rolling trim, clear, or replacement violates it.
    return source.length < cachedSourceCount || source[cachedSourceCount - 1] !== cachedSourceLast;
  }

  function snapshotSource(source: DataFrame[]): void {
    cachedSource = source;
    cachedSourceCount = source.length;
    cachedSourceLast = source[source.length - 1];
  }

  function markSourceReplacement(source: DataFrame[]): void {
    if (sourceReplacementPending || !sourceWasReplaced(source)) return;
    sourceReplacementPending = true;
    needsFullRebuild = true;
    mergedNeedsFullRebuild = true;
    onFramesReplaced?.();
  }

  function rebuildMerged(source: readonly DataFrame[]): void {
    mergedIndex.rebuild(source);
    mergedSourceCount = source.length;
    mergedSourceLast = source[source.length - 1];
    mergedNeedsFullRebuild = false;
  }

  function reconcileMerged(source: DataFrame[]): readonly DataFrame[] {
    const replaced =
      source.length < mergedSourceCount ||
      (mergedSourceCount > 0 && source[mergedSourceCount - 1] !== mergedSourceLast);
    if (mergedNeedsFullRebuild || replaced) {
      rebuildMerged(source);
      return mergedIndex.frames;
    }

    if (source.length > mergedSourceCount) {
      mergedIndex.appendRange(source, mergedSourceCount);
      mergedSourceCount = source.length;
      mergedSourceLast = source[source.length - 1];
    }
    return mergedIndex.frames;
  }

  watch([directionFilter, searchQuery, searchMode], () => {
    needsFullRebuild = true;
  });

  watch(directionFilter, () => {
    mergedNeedsFullRebuild = true;
  });

  // Session stores publish their mutation version after an append/trim. Use a
  // synchronous watcher to release formatter/search caches at the same pulse,
  // even if the virtual list has not yet read its lazy computed projection.
  if (framesVersion) {
    watch(
      framesVersion,
      () => {
        markSourceReplacement(frames.value);
      },
      { flush: 'sync' },
    );
  }

  watch(searchInput, (value) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery.value = value;
    }, SEARCH_DEBOUNCE_MS);
  });

  const filteredFrames = computed(() => {
    // Store-backed frame arrays are intentionally mutated in place for high
    // baud-rate performance. The optional version ref is the explicit pulse
    // that tells this computed to re-check the same array reference.
    void framesVersion?.value;

    const source = frames.value;
    const query = searchQuery.value.trim().toLowerCase();
    const hasDirection = directionFilter.value !== 'ALL';
    const hasSearch = query.length > 0;
    markSourceReplacement(source);
    const previousSourceCount = cachedSourceCount;

    if (!hasDirection && !hasSearch) {
      cachedFiltered = source;
      snapshotSource(source);
      needsFullRebuild = false;
      sourceReplacementPending = false;
      return source;
    }

    const hexNeedle = searchMode.value === 'HEX' ? query.replace(/[^0-9a-f]/g, '') : '';
    if (needsFullRebuild) {
      cachedFiltered = source.filter((frame) =>
        matchesFilter(frame, query, hasDirection, hasSearch, hexNeedle),
      );
      needsFullRebuild = false;
    } else if (source.length > previousSourceCount) {
      for (let index = previousSourceCount; index < source.length; index += 1) {
        const frame = source[index];
        if (frame && matchesFilter(frame, query, hasDirection, hasSearch, hexNeedle)) {
          cachedFiltered.push(frame);
        }
      }
    }

    snapshotSource(source);
    sourceReplacementPending = false;
    return cachedFiltered;
  });

  const visibleFrames = computed<readonly DataFrame[]>(() => {
    // A same-reference array append does not necessarily change the computed
    // value identity, so consume the explicit frame pulse here as well.
    void framesVersion?.value;
    const filtered = filteredFrames.value;
    if (packetViewMode.value === 'FRAME') return filtered;

    const query = searchQuery.value.trim().toLowerCase();
    const hasSearch = query.length > 0;
    // In MERGED mode search applies to one direction run, not separately to
    // its source packets. This permits a query split across serial chunks and
    // delegates matching to the rope's streaming byte/text search below.
    const mergeSource = hasSearch
      ? directionFilter.value === 'ALL'
        ? frames.value
        : frames.value.filter((frame) => frame.direction === directionFilter.value)
      : filtered;
    const merged = reconcileMerged(mergeSource);
    if (!hasSearch) return merged;

    const hexNeedle = searchMode.value === 'HEX' ? query.replace(/[^0-9a-f]/g, '') : '';
    return merged.filter((frame) => {
      const chunks = mergedIndex.chunksFor(frame);
      if (!chunks) return false;
      return searchMode.value === 'HEX'
        ? hexChunksInclude(chunks, hexNeedle)
        : textChunksInclude(chunks, query);
    });
  });

  const filteredFrameCount = computed(() => {
    void framesVersion?.value;
    return filteredFrames.value.length;
  });

  const visibleFrameCount = computed(() => {
    void framesVersion?.value;
    return visibleFrames.value.length;
  });

  onScopeDispose(() => {
    if (searchTimer) clearTimeout(searchTimer);
    mergedIndex.clear();
  });

  return {
    directionFilter,
    searchInput,
    filteredFrames,
    filteredFrameCount,
    visibleFrames,
    visibleFrameCount,
    /** Materializes a merged rope only for copy/export actions. */
    materializeFrame: (frame: DataFrame) => mergedIndex.materialize(frame),
    /** Enables future consumers to stream-search a merged descriptor. */
    getMergedChunks: (frame: DataFrame) => mergedIndex.chunksFor(frame),
  };
}

function createSubstringMatcher(needle: string): { feed: (char: string) => boolean } {
  const prefix = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = prefix[matched - 1];
    if (needle[index] === needle[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  return {
    feed(char: string): boolean {
      while (matched > 0 && char !== needle[matched]) matched = prefix[matched - 1];
      if (char === needle[matched]) matched += 1;
      if (matched !== needle.length) return false;
      matched = prefix[matched - 1];
      return true;
    },
  };
}

/** Search continuous lowercase hexadecimal across chunk boundaries without a copy. */
export function hexChunksInclude(chunks: readonly Uint8Array[], needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase();
  if (normalizedNeedle.length === 0) return false;
  const matcher = createSubstringMatcher(normalizedNeedle);
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      if (matcher.feed(HEX_DIGITS[byte >>> 4]) || matcher.feed(HEX_DIGITS[byte & 0x0f])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Case-insensitive UTF-8 search across source chunks. The decoder and ANSI
 * CSI stripper are streaming, so no full terminal run is decoded or copied.
 */
export function textChunksInclude(chunks: readonly Uint8Array[], needle: string): boolean {
  const normalizedNeedle = needle.toLowerCase();
  if (normalizedNeedle.length === 0) return false;
  const matcher = createSubstringMatcher(normalizedNeedle);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let ansiCandidate = '';

  const feedPlain = (char: string): boolean => matcher.feed(char.toLowerCase());
  const feedDecoded = (text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (ansiCandidate.length === 0) {
        if (char === ESCAPE) {
          ansiCandidate = char;
        } else if (feedPlain(char)) {
          return true;
        }
        continue;
      }

      ansiCandidate += char;
      if (ansiCandidate.length === 2) {
        if (char !== '[') {
          for (const literal of ansiCandidate) {
            if (feedPlain(literal)) return true;
          }
          ansiCandidate = '';
        }
        continue;
      }

      if ((char >= '0' && char <= '9') || char === ';' || char === '?') continue;
      if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
        ansiCandidate = '';
        continue;
      }
      for (const literal of ansiCandidate) {
        if (feedPlain(literal)) return true;
      }
      ansiCandidate = '';
    }
    return false;
  };

  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.byteLength; offset += STREAM_SEARCH_SLICE_BYTES) {
      const slice = chunk.subarray(
        offset,
        Math.min(chunk.byteLength, offset + STREAM_SEARCH_SLICE_BYTES),
      );
      if (feedDecoded(decoder.decode(slice, { stream: true }))) return true;
    }
  }
  if (feedDecoded(decoder.decode())) return true;
  for (const literal of ansiCandidate) {
    if (feedPlain(literal)) return true;
  }
  return false;
}
