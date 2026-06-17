import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { formatHex, formatUtf8 } from '../../src/lib/format.ts';
import { usePacketFilter } from '../../src/composables/usePacketFilter.ts';
import type { DataFrame, PacketViewMode, SearchMode } from '../../src/types/index.ts';

function makeFrame(id: string, direction: DataFrame['direction'], data: number[]): DataFrame {
  return {
    id,
    direction,
    timestamp: 0,
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

test('merged view reflects frames appended after the initial compute', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([makeFrame('1', 'TX', [1]), makeFrame('2', 'RX', [2])]);
    const searchMode = ref<SearchMode>('TEXT');
    const packetViewMode = ref<PacketViewMode>('MERGED');
    const filter = usePacketFilter({
      frames,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    assert.equal(filter.visibleFrames.value.length, 2);

    // Append another RX frame — the existing RX group must absorb it.
    frames.value.push(makeFrame('3', 'RX', [3]));
    await nextTick();

    const updated = filter.visibleFrames.value;
    assert.equal(updated.length, 2);
    assert.deepEqual(Array.from(updated[1].data), [2, 3]);
  });
  scope.stop();
});

test('frame view reflects frames appended after the initial compute', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([makeFrame('1', 'RX', [1])]);
    const searchMode = ref<SearchMode>('TEXT');
    const packetViewMode = ref<PacketViewMode>('FRAME');
    const filter = usePacketFilter({
      frames,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    assert.equal(filter.visibleFrames.value.length, 1);

    frames.value.push(makeFrame('2', 'RX', [2]));
    await nextTick();

    assert.equal(filter.visibleFrames.value.length, 2);
    assert.deepEqual(Array.from(filter.visibleFrames.value[1].data), [2]);
  });
  scope.stop();
});

test('frame view follows an explicit version tick when the same frames array is mutated', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = shallowRef([makeFrame('1', 'RX', [1])]);
    const framesVersion = ref(0);
    const searchMode = ref<SearchMode>('TEXT');
    const packetViewMode = ref<PacketViewMode>('FRAME');
    const filter = usePacketFilter({
      frames,
      framesVersion,
      searchMode,
      packetViewMode,
      getHexSearchData: (frame) => formatHex(frame.data).replace(/\s/g, '').toLowerCase(),
      getTextSearchData: (frame) => formatUtf8(frame.data).toLowerCase(),
    });

    assert.equal(filter.visibleFrames.value.length, 1);
    assert.equal(filter.filteredFrameCount.value, 1);
    assert.equal(filter.visibleFrameCount.value, 1);

    frames.value.push(makeFrame('2', 'TX', [2]));
    framesVersion.value += 1;
    await nextTick();

    assert.equal(filter.visibleFrames.value.length, 2);
    assert.equal(filter.filteredFrameCount.value, 2);
    assert.equal(filter.visibleFrameCount.value, 2);
    assert.deepEqual(
      filter.visibleFrames.value.map((frame) => frame.id),
      ['1', '2'],
    );
  });
  scope.stop();
});

test('incremental path filters newly-appended frames by active direction filter', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([
      makeFrame('1', 'TX', [1]),
      makeFrame('2', 'RX', [2]),
      makeFrame('3', 'RX', [3]),
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
    assert.deepEqual(
      filter.filteredFrames.value.map((f) => f.id),
      ['2', '3'],
    );

    // Append one TX (must be excluded) and one RX (must be included) — this
    // exercises the incremental cachedFiltered.push branch under a filter.
    frames.value.push(makeFrame('4', 'TX', [4]));
    frames.value.push(makeFrame('5', 'RX', [5]));
    await nextTick();

    assert.deepEqual(
      filter.filteredFrames.value.map((f) => f.id),
      ['2', '3', '5'],
    );
  });
  scope.stop();
});

test('clearing an active search restores all frames (full rebuild)', async () => {
  const scope = effectScope();
  await scope.run(async () => {
    const frames = ref([
      makeFrame('1', 'RX', [65, 66]), // "AB"
      makeFrame('2', 'RX', [67, 68]), // "CD"
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

    // active search narrows to one frame
    filter.searchInput.value = 'ab';
    await delay(180);
    assert.deepEqual(
      filter.filteredFrames.value.map((f) => f.id),
      ['1'],
    );

    // clearing the search must trigger a full rebuild back to all frames
    filter.searchInput.value = '';
    await delay(180);
    assert.deepEqual(
      filter.filteredFrames.value.map((f) => f.id),
      ['1', '2'],
    );
  });
  scope.stop();
});
