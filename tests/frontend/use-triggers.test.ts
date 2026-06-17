import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';
import { useTriggers } from '../../src/composables/useTriggers.ts';
import type { DataFrame, Trigger } from '../../src/types.ts';
import type { TriggerFire } from '../../src/lib/trigger-engine.ts';

function rxFrame(data: Uint8Array | number[], id = 1): DataFrame {
  return {
    id: `f${id}`,
    timestamp: id,
    direction: 'RX',
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  };
}

function textTrigger(
  id: string,
  pattern: string,
  response: string,
  opts: Partial<Trigger> = {},
): Trigger {
  return {
    id,
    name: id,
    enabled: true,
    matchMode: 'text',
    pattern,
    response,
    responseIsHex: false,
    caseSensitive: false,
    cooldownMs: 0,
    ...opts,
  };
}

function hexTrigger(
  id: string,
  pattern: string,
  response: string,
  opts: Partial<Trigger> = {},
): Trigger {
  return {
    id,
    name: id,
    enabled: true,
    matchMode: 'hex',
    pattern,
    response,
    responseIsHex: true,
    caseSensitive: false,
    cooldownMs: 0,
    ...opts,
  };
}

test('useTriggers: feedFrame ignores TX frames', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([
    textTrigger('t1', 'login:', 'root\n'),
  ]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  await feedFrame({ ...rxFrame(toBytes('login: ')), direction: 'TX' } as DataFrame);

  assert.equal(sent.length, 0, 'TX frames never trigger a response');
});

test('useTriggers: feedFrame no-ops when no triggers configured', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  await feedFrame(rxFrame(toBytes('login: ')));

  assert.equal(sent.length, 0, 'empty trigger set short-circuits');
});

test('useTriggers: text match sends the configured response once', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const fires: TriggerFire[] = [];
  const triggers = ref<Trigger[]>([textTrigger('t1', 'login:', 'root\n')]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
    onFire: (fire) => fires.push(fire),
  });

  await feedFrame(rxFrame(toBytes('please login: now')));

  assert.deepEqual(
    sent,
    [{ data: 'root\n', isHex: false }],
    'matched text trigger sends its response through the serialized send',
  );
  assert.equal(fires.length, 1, 'onFire callback invoked once');
  assert.equal(fires[0].triggerId, 't1');
  assert.equal(fires[0].response, 'root\n');
  assert.equal(fires[0].responseIsHex, false);
});

test('useTriggers: response fires for the serialized send argument shape', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([hexTrigger('h1', 'AA BB', 'CC DD')]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  await feedFrame(rxFrame([0xaa, 0xbb]));

  assert.deepEqual(
    sent,
    [{ data: 'CC DD', isHex: true }],
    'hex-mode trigger forwards responseIsHex=true',
  );
});

test('useTriggers: stateful match spans multiple frames', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([textTrigger('t1', 'OK', 'done\n')]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  // Split the pattern across two frames — the rolling buffer must still detect it.
  await feedFrame(rxFrame(toBytes('O'), 1));
  await feedFrame(rxFrame(toBytes('K'), 2));

  assert.equal(sent.length, 1, 'pattern split across frames still matches');
});

test('useTriggers: editing the trigger set rebuilds the engine (resets buffer)', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([textTrigger('t1', 'OK', 'one\n')]);
  const { feedFrame } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  // Build up a partial 'O' in the original engine's rolling buffer.
  await feedFrame(rxFrame(toBytes('O'), 1));
  // Now swap to a different trigger set — the deep watch must rebuild and reset.
  triggers.value = [textTrigger('t2', 'DONE', 'two\n')];
  await nextTick();
  // The stale 'O' partial must not carry over.
  await feedFrame(rxFrame(toBytes('K'), 2));

  assert.equal(sent.length, 0, 'partial match state is dropped on config change');
});

test('useTriggers: enabledCount reflects only enabled triggers', async () => {
  const triggers = ref<Trigger[]>([
    textTrigger('t1', 'a', 'x'),
    textTrigger('t2', 'b', 'y', { enabled: false }),
    textTrigger('t3', 'c', 'z'),
  ]);
  const { enabledCount } = useTriggers({ triggers, send: async () => true });

  assert.equal(enabledCount.value, 2, 'two of three triggers are enabled');

  triggers.value[1].enabled = true;
  triggers.value = [...triggers.value];
  await nextTick();
  assert.equal(enabledCount.value, 3, 'enabling updates enabledCount');
});

test('useTriggers: reset clears matcher state', async () => {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const triggers = ref<Trigger[]>([textTrigger('t1', 'OK', 'done\n')]);
  const { feedFrame, reset } = useTriggers({
    triggers,
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return true;
    },
  });

  await feedFrame(rxFrame(toBytes('O'), 1));
  reset();
  await feedFrame(rxFrame(toBytes('K'), 2));

  assert.equal(sent.length, 0, 'reset drops the partial match so the split pattern no longer fires');
});

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
