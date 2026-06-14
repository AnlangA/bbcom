import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLogAiContext } from '../../src/lib/ai-log-context.ts';
import { encodeUtf8 } from '../../src/lib/format.ts';
import type { DataFrame, LogAiContextMode, SerialSession } from '../../src/types/index.ts';

function frame(id: string, direction: DataFrame['direction'], data: Uint8Array, timestamp = 0): DataFrame {
  return { id, direction, timestamp, data };
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

test('latest-10k mode includes all frames and reports the 10k char limit', () => {
  const session = baseSession({
    frames: [
      frame('1', 'RX', encodeUtf8('boot ok')),
      frame('2', 'TX', encodeUtf8('ping')),
    ],
  });
  const result = buildLogAiContext(session);

  assert.equal(result.charLimit, 10_000);
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

test('full-capped mode uses the larger 50k char limit', () => {
  const session = baseSession({ frames: [frame('1', 'RX', encodeUtf8('hi'))], logAiContextMode: 'full-capped' });
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
  // Each line is ~marker + 8 chars; build enough to exceed the 10k limit.
  const frames: DataFrame[] = [];
  for (let i = 0; i < 1500; i += 1) {
    frames.push(frame(`${i}`, 'RX', encodeUtf8('AAAAAAAAAA'), i)); // 10 chars each
  }
  const session = baseSession({ frames });

  const result = buildLogAiContext(session);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 10_000, 'trimmed text must respect the char limit');
  // the most recent frame marker should survive (tail kept)
  assert.match(result.text, /AAAAAAAAAA/);
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
