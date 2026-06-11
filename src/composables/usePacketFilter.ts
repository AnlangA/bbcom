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

  watch(searchInput, (value) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery.value = value;
    }, SEARCH_DEBOUNCE_MS);
  });

  const filteredFrames = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const hasDirectionFilter = directionFilter.value !== 'ALL';
    const hasSearch = query.length > 0;

    if (!hasDirectionFilter && !hasSearch) return frames.value;

    const hexNeedle = searchMode.value === 'HEX' ? query.replace(/[^0-9a-f]/g, '') : '';
    return frames.value.filter((frame) => {
      if (hasDirectionFilter && frame.direction !== directionFilter.value) return false;
      if (!hasSearch) return true;
      if (searchMode.value === 'HEX') return hexNeedle.length > 0 && getHexSearchData(frame).includes(hexNeedle);
      return getTextSearchData(frame).includes(query);
    });
  });

  const visibleFrames = computed<DataFrame[]>(() => {
    if (packetViewMode.value === 'FRAME') return filteredFrames.value;

    const merged: DataFrame[] = [];
    let currentDirection: DataFrame['direction'] | null = null;
    let currentTimestamp = '';
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
