import { computed, ref, watch, type Ref } from 'vue';
import type { DataFrame, DirectionFilter, PacketViewMode, SearchMode } from '../types';

interface PacketFilterOptions {
  frames: Ref<DataFrame[]>;
  searchMode: Ref<SearchMode>;
  packetViewMode: Ref<PacketViewMode>;
  getHexSearchData: (frame: DataFrame) => string;
  getTextSearchData: (frame: DataFrame) => string;
}

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
    }, 150);
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
    let current: DataFrame | null = null;
    for (const frame of filteredFrames.value) {
      if (!current || current.direction !== frame.direction) {
        // Shallow-copy the frame; data array is extended in-place below
        current = { ...frame, id: `merged-${frame.id}`, data: frame.data.slice() };
        merged.push(current);
      } else {
        const prev = current.data as number[];
        const next = frame.data as number[];
        const combined = new Array<number>(prev.length + next.length);
        for (let i = 0; i < prev.length; i++) combined[i] = prev[i];
        for (let i = 0; i < next.length; i++) combined[prev.length + i] = next[i];
        current.data = combined;
      }
    }
    return merged;
  });

  return {
    directionFilter,
    searchInput,
    filteredFrames,
    visibleFrames,
  };
}
