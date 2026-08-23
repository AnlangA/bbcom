import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildLogAiContext } from '@/lib/ai-log-context.ts';
import { encodeUtf8 } from '@/lib/format.ts';
import type { DataFrame, SerialSession } from '@/types/index.ts';
import { frame } from '@/test/helpers/frames.ts';

function arrayIndex(property: string | symbol): number | null {
  if (typeof property !== 'string' || !/^(0|[1-9]\d*)$/.test(property)) return null;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

/** Lazily materialize frames so a test can observe exactly which indices are read. */
function observedFrames(
  count: number,
  onRead: (index: number) => void,
  data: Uint8Array,
): DataFrame[] {
  const target = new Array<DataFrame>(count);
  return new Proxy(target, {
    has(array, property) {
      const index = arrayIndex(property);
      return index === null ? Reflect.has(array, property) : index < count;
    },
    get(array, property, receiver) {
      const index = arrayIndex(property);
      if (index === null) return Reflect.get(array, property, receiver);
      onRead(index);
      return frame(String(index), index % 2 === 0 ? 'RX' : 'TX', data, index);
    },
  });
}

function baseSession(overrides: Partial<SerialSession> = {}): SerialSession {
  return {
    id: 's1',
    portName: 'COM1',
    portConfig: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    isConnected: true,
    frames: [],
    txBytes: 0,
    rxBytes: 0,
    txFrames: 0,
    rxFrames: 0,
    startTime: null,
    sendHistory: [],
    sendDraft: '',
    quickCommands: [],
    autoLogEnabled: false,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
    ...overrides,
  };
}

test('latest-10k mode includes all frames and reports the 50k safety cap', () => {
  const session = baseSession({
    frames: [frame('1', 'RX', encodeUtf8('boot ok')), frame('2', 'TX', encodeUtf8('ping'))],
  });
  const result = buildLogAiContext(session);

  assert.equal(result.charLimit, 50_000);
  assert.equal(result.frameCount, 2);
  assert.equal(result.truncated, false);
  assert.match(result.text, /boot ok/);
  assert.match(result.text, /ping/);
  // readable text uses the UTF8 payload marker
  assert.match(result.text, /UTF8: boot ok/);
});

test('latest-n-frames mode selects only the trailing N frames', () => {
  const frames: DataFrame[] = [];
  for (let i = 0; i < 5; i += 1) frames.push(frame(`${i}`, 'RX', encodeUtf8(`line${i}`), i));
  const session = baseSession({ frames, logAiContextMode: 'latest-n-frames', logAiFrameLimit: 2 });

  const result = buildLogAiContext(session);
  assert.equal(result.frameCount, 2);
  assert.match(result.text, /line3/);
  assert.match(result.text, /line4/);
  assert.doesNotMatch(result.text, /line0|line1|line2/);
  // fewer frames selected than exist → truncated
  assert.equal(result.truncated, true);
});

test('full-capped mode uses the same 50k char limit', () => {
  const session = baseSession({
    frames: [frame('1', 'RX', encodeUtf8('hi'))],
    logAiContextMode: 'full-capped',
  });
  assert.equal(buildLogAiContext(session).charLimit, 50_000);
});

test('binary frames are rendered as HEX instead of UTF8', () => {
  // Mostly non-printable bytes → not readable → HEX payload
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xaa, 0xbb]);
  const session = baseSession({ frames: [frame('1', 'RX', binary)] });

  const result = buildLogAiContext(session);
  assert.match(result.text, /HEX:/);
  assert.match(result.text, /00 01 02 03 FF FE AA BB/);
  assert.doesNotMatch(result.text, /UTF8:/);
});

test('context is trimmed to the char limit from the front (keeps the tail)', () => {
  // Each line is ~marker + 8 chars; build enough to exceed the 50k limit.
  const frames: DataFrame[] = [];
  for (let i = 0; i < 7000; i += 1) {
    frames.push(frame(`${i}`, 'RX', encodeUtf8('AAAAAAAAAA'), i)); // 10 chars each
  }
  const session = baseSession({ frames });

  const result = buildLogAiContext(session);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 50_000, 'trimmed text must respect the char limit');
  // the most recent frame marker should survive (tail kept)
  assert.match(result.text, /AAAAAAAAAA/);
});

test('large histories only access and format the tail needed by the character budget', () => {
  const totalFrames = 100_000;
  const accessed: number[] = [];
  const payload = encodeUtf8('A'.repeat(200));
  const frames = observedFrames(totalFrames, (index) => accessed.push(index), payload);
  const session = baseSession({ frames, logAiContextMode: 'latest-10k' });

  const result = buildLogAiContext(session);

  assert.equal(
    result.frameCount,
    totalFrames,
    'frameCount keeps the existing selected-frame contract',
  );
  assert.equal(result.charLimit, 50_000);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 50_000);
  assert.equal(accessed[0], totalFrames - 1, 'scan starts at the newest frame');
  assert.ok(
    accessed.length < 300,
    `only budget-relevant tail frames should be formatted, read ${accessed.length}`,
  );
  assert.ok(accessed.at(-1)! > totalFrames - 300, 'no old history frame should be touched');
});

test('latest-n mode preserves selected frameCount while stopping at the character budget', () => {
  const totalFrames = 20_000;
  const selectedFrames = 5_000;
  const accessed: number[] = [];
  const frames = observedFrames(
    totalFrames,
    (index) => accessed.push(index),
    encodeUtf8('B'.repeat(200)),
  );
  const session = baseSession({
    frames,
    logAiContextMode: 'latest-n-frames',
    logAiFrameLimit: selectedFrames,
  });

  const result = buildLogAiContext(session);

  assert.equal(result.frameCount, selectedFrames);
  assert.equal(result.truncated, true);
  assert.ok(accessed.length < 300);
  assert.equal(accessed[0], totalFrames - 1);
  assert.ok(accessed.at(-1)! >= totalFrames - selectedFrames);
});

test('empty session yields empty, non-truncated context', () => {
  const result = buildLogAiContext(baseSession());
  assert.equal(result.text, '');
  assert.equal(result.frameCount, 0);
  assert.equal(result.truncated, false);
});

test('null bytes and control chars are sanitized out of the rendered text', () => {
  const raw = encodeUtf8('a\x00b\rc\nd');
  const session = baseSession({ frames: [frame('1', 'RX', raw)] });
  const text = buildLogAiContext(session).text;

  assert.doesNotMatch(text, /\0/);
  assert.match(text, /\\r/);
  assert.match(text, /\\n/);
});

test('latest-n context handles zero, negative, non-finite, and fractional frame limits defensively', () => {
  const frames = [
    frame('one', 'RX', encodeUtf8('one'), 1),
    frame('two', 'RX', encodeUtf8('two'), 2),
  ];
  const select = (frameLimit: number) =>
    buildLogAiContext(
      baseSession({ frames, logAiContextMode: 'latest-n-frames', logAiFrameLimit: frameLimit }),
    );

  assert.deepEqual(select(0), { text: '', truncated: true, frameCount: 0, charLimit: 50_000 });
  assert.deepEqual(select(-1), { text: '', truncated: true, frameCount: 0, charLimit: 50_000 });
  assert.equal(select(Number.NaN).frameCount, 2);
  assert.equal(select(Number.POSITIVE_INFINITY).frameCount, 2);
  assert.equal(select(0.5).frameCount, 2);
  assert.equal(select(1.8).frameCount, 1);
});

test('empty and whitespace serial payloads are deliberately rendered as HEX context', () => {
  const result = buildLogAiContext(
    baseSession({
      frames: [frame('empty', 'RX', new Uint8Array()), frame('blank', 'TX', encodeUtf8('   '))],
    }),
  );

  assert.match(result.text, /RX HEX:/);
  assert.match(result.text, /TX HEX:/);
  assert.doesNotMatch(result.text, /UTF8:/);
});
