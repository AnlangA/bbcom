import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_SERIAL_SHELL_CONFIG,
  SerialShellDecoder,
  SerialShellRxMapper,
  cloneSerialShellConfig,
  echoTextForSerialShellKey,
  encodeSerialShellKey,
  encodeSerialShellText,
  isImmediateSerialShellKey,
  normalizeSerialShellConfig,
  serialShellKeysFromData,
  serialShellNewlineBytes,
} from '@/lib/serial-shell';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

test('normalizeSerialShellConfig fills defaults and drops legacy fields', () => {
  const config = normalizeSerialShellConfig({
    inputMode: 'char',
    localEcho: 'yes',
    showTimestamp: true,
    history: ['stale'],
    txNewline: 'lf',
  });
  assert.deepEqual(config, {
    localEcho: false,
    txNewline: 'lf',
    rxNewline: 'auto',
    encoding: 'utf-8',
    backspace: 'bs',
  });
  assert.deepEqual(normalizeSerialShellConfig(null), DEFAULT_SERIAL_SHELL_CONFIG);
});

test('cloneSerialShellConfig falls back to defaults for unknown enum values', () => {
  const cloned = cloneSerialShellConfig({
    ...DEFAULT_SERIAL_SHELL_CONFIG,
    txNewline: 'weird' as never,
    encoding: 'utf-16' as never,
  });
  assert.equal(cloned.txNewline, DEFAULT_SERIAL_SHELL_CONFIG.txNewline);
  assert.equal(cloned.encoding, 'utf-8');
});

test('encodeSerialShellKey maps enter, backspace, and Ctrl-C', () => {
  assert.deepEqual(encodeSerialShellKey({ kind: 'enter' }, 'utf-8', 'cr', 'bs'), bytes(0x0d));
  assert.deepEqual(
    encodeSerialShellKey({ kind: 'enter' }, 'utf-8', 'crlf', 'bs'),
    bytes(0x0d, 0x0a),
  );
  assert.deepEqual(encodeSerialShellKey({ kind: 'backspace' }, 'utf-8', 'lf', 'del'), bytes(0x7f));
  assert.deepEqual(
    encodeSerialShellKey({ kind: 'control', code: 3 }, 'utf-8', 'lf', 'bs'),
    bytes(0x03),
  );
  assert.equal(isImmediateSerialShellKey({ kind: 'control', code: 3 }), true);
  assert.equal(isImmediateSerialShellKey({ kind: 'text', text: 'a' }), false);
  assert.deepEqual(serialShellNewlineBytes('none'), bytes());
});

test('echoTextForSerialShellKey uses terminal-ready sequences', () => {
  assert.equal(echoTextForSerialShellKey({ kind: 'enter' }), '\r\n');
  assert.equal(echoTextForSerialShellKey({ kind: 'backspace' }), '\b \b');
  assert.equal(echoTextForSerialShellKey({ kind: 'text', text: 'ls' }), 'ls');
  assert.equal(echoTextForSerialShellKey({ kind: 'bytes', bytes: bytes(0x1b) }), null);
});

test('serialShellKeysFromData maps typing, enter, and control characters', () => {
  assert.deepEqual(serialShellKeysFromData('ls -la'), [{ kind: 'text', text: 'ls -la' }]);
  assert.deepEqual(serialShellKeysFromData('\r'), [{ kind: 'enter' }]);
  assert.deepEqual(serialShellKeysFromData('\u007f'), [{ kind: 'backspace' }]);
  assert.deepEqual(serialShellKeysFromData('\t'), [{ kind: 'tab' }]);
  assert.deepEqual(serialShellKeysFromData('\u0003'), [{ kind: 'control', code: 3 }]);
  assert.deepEqual(serialShellKeysFromData('ab\rcd'), [
    { kind: 'text', text: 'ab' },
    { kind: 'enter' },
    { kind: 'text', text: 'cd' },
  ]);
});

test('serialShellKeysFromData forwards arrow keys and CSI sequences as raw bytes', () => {
  const up = serialShellKeysFromData('\u001b[A');
  assert.equal(up.length, 1);
  assert.equal(up[0]?.kind, 'bytes');
  assert.deepEqual(Array.from((up[0] as { bytes: Uint8Array }).bytes), [0x1b, 0x5b, 0x41]);

  const del = serialShellKeysFromData('\u001b[3~');
  assert.equal(del[0]?.kind, 'bytes');
  assert.deepEqual(Array.from((del[0] as { bytes: Uint8Array }).bytes), [0x1b, 0x5b, 0x33, 0x7e]);

  const lone = serialShellKeysFromData('\u001b');
  assert.deepEqual(lone, [{ kind: 'control', code: 0x1b }]);

  const alt = serialShellKeysFromData('\u001bb');
  assert.equal(alt[0]?.kind, 'bytes');
  assert.deepEqual(Array.from((alt[0] as { bytes: Uint8Array }).bytes), [0x1b, 0x62]);
});

test('RX auto maps bare LF to CRLF and keeps CRLF and lone CR intact', () => {
  const mapper = new SerialShellRxMapper('auto');
  assert.equal(mapper.push('one\r\ntwo\nthree'), 'one\r\ntwo\r\nthree');
  assert.equal(mapper.push('load\rload'), 'load\rload');
});

test('RX auto keeps a CRLF pair split across chunks as one line ending', () => {
  const mapper = new SerialShellRxMapper('auto');
  assert.equal(mapper.push('ok\r'), 'ok\r');
  assert.equal(mapper.push('\nnext'), '\nnext');
});

test('RX cr maps CR to CRLF and swallows an LF right after it', () => {
  const mapper = new SerialShellRxMapper('cr');
  assert.equal(mapper.push('one\rtwo'), 'one\r\ntwo');
  assert.equal(mapper.push('a\r\nb'), 'a\r\nb');
  assert.equal(mapper.push('c\nd'), 'c\r\nd');
});

test('RX none and crlf pass device bytes through untouched', () => {
  assert.equal(new SerialShellRxMapper('none').push('a\rb\nc'), 'a\rb\nc');
  assert.equal(new SerialShellRxMapper('crlf').push('a\r\nb'), 'a\r\nb');
});

test('GBK encode/decode round-trips Chinese text', () => {
  const text = '汉字';
  const encoded = encodeSerialShellText(text, 'gbk');
  assert.ok(encoded.byteLength >= 4);
  const decoder = new SerialShellDecoder('gbk');
  assert.equal(decoder.push(encoded), text);
});

test('decoder holds split multi-byte sequences across chunks', () => {
  const decoder = new SerialShellDecoder('utf-8');
  const encoded = encodeSerialShellText('中', 'utf-8');
  assert.equal(decoder.push(encoded.slice(0, 1)), '');
  assert.equal(decoder.push(encoded.slice(1)), '中');
});
