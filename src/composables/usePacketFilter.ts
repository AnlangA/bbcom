import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { DataFrame, DirectionFilter, PacketViewMode, SearchMode } from '../types';

interface PacketFilterOptions {
  frames: Ref<DataFrame[]>;
  searchMode: Ref<SearchMode>;
  packetViewMode: Ref<PacketViewMode>;
  getHexSearchData: (frame: DataFrame) => string;
  getTextSearchData: (frame: DataFrame) => string;
}

const SEARCH_DEBOUNCE_MS = 150;

export function usePacketFilter({
  frames,
  searchMode,
  packetViewMode,
  getHexSearchData,
  getTextSearchData,
}: PacketFilterOptions) {
  const directionFilter = ref<DirectionFilter>('ALL');
  const searchInput = ref('');
  const searchQuery = ref('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  let cachedFiltered: DataFrame[] = [];
  let cachedFrameCount = 0;
  let needsFullRebuild = true;

  function matchesFilter(frame: DataFrame, query: string, hasDirection: boolean, hasSearch: boolean, hexNeedle: string): boolean {
    if (hasDirection && frame.direction !== directionFilter.value) return false;
    if (!hasSearch) return true;
    if (searchMode.value === 'HEX') return hexNeedle.length > 0 && getHexSearchData(frame).includes(hexNeedle);
    return getTextSearchData(frame).includes(query);
  }

  watch([directionFilter, searchQuery, searchMode], () => {
    needsFullRebuild = true;
  });

  watch(searchInput, (value) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery.value = value;
    }, SEARCH_DEBOUNCE_MS);
  });

  const filteredFrames = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const hasDirection = directionFilter.value !== 'ALL';
    const hasSearch = query.length > 0;

    if (!hasDirection && !hasSearch) {
      cachedFiltered = frames.value;
      cachedFrameCount = frames.value.length;
      needsFullRebuild = false;
      return frames.value;
    }

    const hexNeedle = searchMode.value === 'HEX' ? query.replace(/[^0-9a-f]/g, '') : '';

    if (needsFullRebuild) {
      cachedFiltered = frames.value.filter((frame) =>
        matchesFilter(frame, query, hasDirection, hasSearch, hexNeedle),
      );
      cachedFrameCount = frames.value.length;
      needsFullRebuild = false;
    } else if (frames.value.length !== cachedFrameCount) {
      const newCount = frames.value.length;
      const oldCount = cachedFrameCount;
      if (newCount > oldCount) {
        for (let i = oldCount; i < newCount; i++) {
          const frame = frames.value[i];
          if (matchesFilter(frame, query, hasDirection, hasSearch, hexNeedle)) {
            cachedFiltered.push(frame);
          }
        }
      } else {
        cachedFiltered = frames.value.filter((frame) =>
          matchesFilter(frame, query, hasDirection, hasSearch, hexNeedle),
        );
      }
      cachedFrameCount = newCount;
    }

    return cachedFiltered;
  });

  const visibleFrames = computed<DataFrame[]>(() => {
    if (packetViewMode.value === 'FRAME') return filteredFrames.value;

    const merged: DataFrame[] = [];
    let currentDirection: DataFrame['direction'] | null = null;
    let currentTimestamp = 0;
    let currentId = '';
    let currentChunks: Uint8Array[] = [];
    let currentSize = 0;

    function flushCurrent() {
      if (!currentDirection) return;
      const data = new Uint8Array(currentSize);
      let offset = 0;
      for (const chunk of currentChunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      merged.push({
        id: `merged-${currentId}`,
        direction: currentDirection,
        timestamp: currentTimestamp,
        data,
      });
    }

    for (const frame of filteredFrames.value) {
      if (currentDirection !== frame.direction) {
        flushCurrent();
        currentDirection = frame.direction;
        currentTimestamp = frame.timestamp;
        currentId = frame.id;
        currentChunks = [];
        currentSize = 0;
      }
      currentChunks.push(frame.data);
      currentSize += frame.data.length;
    }
    flushCurrent();
    return merged;
  });

  onScopeDispose(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  return {
    directionFilter,
    searchInput,
    filteredFrames,
    visibleFrames,
  };
}
