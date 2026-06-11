import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { formatHex, formatUtf8 } from '../../src/lib/format.ts';
import { usePacketFilter } from '../../src/composables/usePacketFilter.ts';
import type { DataFrame, PacketViewMode, SearchMode } from '../../src/types/index.ts';

function makeFrame(id: string, direction: DataFrame['direction'], data: number[]): DataFrame {
  return {
    id,
    direction,
    timestamp: `12:00:00.00${id}`,
    data: new Uint8Array(data),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('filters by direction and debounced text search', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([
      makeFrame('1', 'TX', [65, 66]),
      makeFrame('2', 'RX', [67, 68]),
      makeFrame('3', 'RX', [65, 67]),
    ]);
    const searchMode = ref<SearchMode>('TEXT');
    const packetViewMode = ref<PacketViewMode>('FRAME');
    const filter = usePacketFilter({
      frames,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    filter.directionFilter.value = 'RX';
    assert.deepEqual(filter.filteredFrames.value.map((frame) => frame.id), ['2', '3']);

    filter.searchInput.value = 'ac';
    await delay(180);
    assert.deepEqual(filter.filteredFrames.value.map((frame) => frame.id), ['3']);
  });
  scope.stop();
});

test('filters by normalized hex search', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([
      makeFrame('1', 'TX', [0xaa, 0xbb]),
      makeFrame('2', 'RX', [0xcc, 0xdd]),
    ]);
    const searchMode = ref<SearchMode>('HEX');
    const packetViewMode = ref<PacketViewMode>('FRAME');
    const filter = usePacketFilter({
      frames,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    filter.searchInput.value = 'AA BB';
    await delay(180);
    assert.deepEqual(filter.filteredFrames.value.map((frame) => frame.id), ['1']);
  });
  scope.stop();
});

test('merged view concatenates each direction group once', () => {
  const scope = effectScope();
  scope.run(() => {
    const frames = ref([
      makeFrame('1', 'TX', [1]),
      makeFrame('2', 'TX', [2, 3]),
      makeFrame('3', 'RX', [4]),
      makeFrame('4', 'RX', [5]),
      makeFrame('5', 'TX', [6]),
    ]);
    const searchMode = ref<SearchMode>('TEXT');
    const packetViewMode = ref<PacketViewMode>('MERGED');
    const filter = usePacketFilter({
      frames,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    assert.equal(filter.visibleFrames.value.length, 3);
    assert.deepEqual(Array.from(filter.visibleFrames.value[0].data), [1, 2, 3]);
    assert.deepEqual(Array.from(filter.visibleFrames.value[1].data), [4, 5]);
    assert.deepEqual(Array.from(filter.visibleFrames.value[2].data), [6]);
    assert.deepEqual(Array.from(frames.value[0].data), [1]);
  });
  scope.stop();
});
