import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_SERIAL_SHELL_CONFIG,
  SerialShellEngine,
  SerialShellRxMapper,
  cloneSerialShellConfig,
  encodeSerialShellKey,
  encodeSerialShellLine,
  encodeSerialShellText,
  isImmediateSerialShellKey,
  normalizeSerialShellConfig,
  pushShellHistory,
  serialShellKeyFromKeyboard,
  serialShellNewlineBytes,
} from '../../src/lib/serial-shell';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function utf8(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

test('normalizeSerialShellConfig fills defaults and clamps history', () => {
  const config = normalizeSerialShellConfig({
    inputMode: 'weird',
    localEcho: 'yes',
    history: ['  ok', '', 1, 'x'.repeat(2_000)],
  });
  assert.equal(config.inputMode, 'line');
  assert.equal(config.localEcho, false);
  assert.equal(config.txNewline, 'crlf');
  assert.equal(config.history[0], '  ok');
  assert.equal(config.history[1]?.length, 1_024);
});

test('cloneSerialShellConfig copies history by value', () => {
  const original = cloneSerialShellConfig({
    ...DEFAULT_SERIAL_SHELL_CONFIG,
    history: ['AT'],
  });
  original.history.push('second');
  const cloned = cloneSerialShellConfig(original);
  cloned.history.push('third');
  assert.deepEqual(original.history, ['AT', 'second']);
  assert.deepEqual(cloned.history, ['AT', 'second', 'third']);
});

test('pushShellHistory de-duplicates and bounds the list', () => {
  assert.deepEqual(pushShellHistory(['a', 'b'], 'a'), ['b', 'a']);
  assert.deepEqual(pushShellHistory(['a'], '   '), ['a']);
});

test('encodeSerialShellLine appends the configured newline', () => {
  assert.deepEqual(encodeSerialShellLine('AT', 'utf-8', 'crlf'), utf8(0x41, 0x54, 0x0d, 0x0a));
  assert.deepEqual(serialShellNewlineBytes('none'), bytes());
});

test('encodeSerialShellKey maps enter, backspace, and Ctrl-C', () => {
  assert.deepEqual(encodeSerialShellKey({ kind: 'enter' }, 'utf-8', 'cr', 'bs'), bytes(0x0d));
  assert.deepEqual(encodeSerialShellKey({ kind: 'backspace' }, 'utf-8', 'lf', 'del'), bytes(0x7f));
  assert.deepEqual(
    encodeSerialShellKey({ kind: 'control', code: 3 }, 'utf-8', 'lf', 'bs'),
    bytes(0x03),
  );
  assert.equal(isImmediateSerialShellKey({ kind: 'control', code: 3 }), true);
  assert.equal(isImmediateSerialShellKey({ kind: 'text', text: 'a' }), false);
});

test('serialShellKeyFromKeyboard maps typing, enter, and arrows', () => {
  assert.deepEqual(
    serialShellKeyFromKeyboard({ key: 'a', ctrlKey: false, altKey: false, metaKey: false }),
    {
      kind: 'text',
      text: 'a',
    },
  );
  assert.deepEqual(
    serialShellKeyFromKeyboard({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false }),
    {
      kind: 'enter',
    },
  );
  assert.deepEqual(
    serialShellKeyFromKeyboard({ key: 'c', ctrlKey: true, altKey: false, metaKey: false }),
    {
      kind: 'control',
      code: 3,
    },
  );
  assert.deepEqual(
    serialShellKeyFromKeyboard({ key: 'ArrowUp', ctrlKey: false, altKey: false, metaKey: false }),
    {
      kind: 'bytes',
      bytes: bytes(0x1b, 0x5b, 0x41),
    },
  );
  assert.equal(
    serialShellKeyFromKeyboard({ key: 'c', ctrlKey: false, altKey: true, metaKey: false }),
    null,
  );
});

test('GBK encode/decode round-trips Chinese text', () => {
  const text = '汉字';
  const encoded = encodeSerialShellText(text, 'gbk');
  assert.ok(encoded.byteLength >= 4);
  const engine = new SerialShellEngine({ encoding: 'gbk', rxNewline: 'none' });
  engine.feedRx(encoded, 10);
  assert.equal(engine.snapshot().current.text, text);
});

test('RX auto maps CR, LF, and CRLF to a single committed line', () => {
  const mapper = new SerialShellRxMapper('auto');
  assert.equal(mapper.push('one\r\ntwo\rthree\nfour'), 'one\ntwo\nthree\nfour');
  assert.equal(mapper.flush(), '');
});

test('RX crlf keeps a lone CR as overwrite and treats CRLF as newline', () => {
  const mapper = new SerialShellRxMapper('crlf');
  assert.equal(mapper.push('ab\r'), 'ab');
  assert.equal(mapper.push('cd'), '\rcd');
  assert.equal(mapper.push('ok\r\n'), 'ok\n');
});

test('engine overwrites the current line on CR when mapping is none', () => {
  const engine = new SerialShellEngine({ rxNewline: 'none' });
  engine.feedRx(encodeSerialShellText('hello\rworld', 'utf-8'), 1);
  assert.equal(engine.snapshot().current.text, 'world');
  assert.deepEqual(engine.snapshot().lines, []);
});

test('engine commits CRLF as one line and keeps the next partial', () => {
  const engine = new SerialShellEngine({ rxNewline: 'auto' });
  engine.feedRx(encodeSerialShellText('ready\r\nAT', 'utf-8'), 5);
  const snap = engine.snapshot();
  assert.equal(snap.lines.length, 1);
  assert.equal(snap.lines[0]?.text, 'ready');
  assert.equal(snap.current.text, 'AT');
});

test('engine backspace deletes the previous character', () => {
  const engine = new SerialShellEngine({ rxNewline: 'none' });
  engine.feedRx(encodeSerialShellText('abc\b', 'utf-8'), 1);
  assert.equal(engine.snapshot().current.text, 'ab');
});

test('engine keeps SGR and clears on CSI 2J', () => {
  const engine = new SerialShellEngine({ rxNewline: 'auto' });
  engine.feedRx(encodeSerialShellText('\u001b[31mred\r\nkeep\u001b[2J', 'utf-8'), 1);
  const snap = engine.snapshot();
  assert.equal(snap.lines.length, 0);
  assert.equal(snap.current.text, '');
  assert.ok(snap.resetVersion === 0);
});

test('engine holds a split CSI across RX chunks', () => {
  const engine = new SerialShellEngine({ rxNewline: 'none' });
  engine.feedRx(encodeSerialShellText('\u001b[3', 'utf-8'), 1);
  assert.equal(engine.snapshot().current.text, '');
  engine.feedRx(encodeSerialShellText('1mX', 'utf-8'), 2);
  assert.equal(engine.snapshot().current.text, '\u001b[31mX');
});

test('engine echo path writes local characters without decoding', () => {
  const engine = new SerialShellEngine({ rxNewline: 'auto' });
  engine.feedEcho('cmd\n', 9);
  assert.equal(engine.snapshot().lines[0]?.text, 'cmd');
});

test('engine evicts old lines when the byte budget is exceeded', () => {
  const engine = new SerialShellEngine({ rxNewline: 'auto' }, { maxLines: 2, maxBytes: 16 });
  engine.feedRx(encodeSerialShellText('aaaa\nbbbb\ncccc\n', 'utf-8'), 1);
  const snap = engine.snapshot();
  assert.equal(snap.lines.length, 2);
  assert.equal(snap.lines[0]?.text, 'bbbb');
  assert.ok(snap.droppedLines >= 1);
});
