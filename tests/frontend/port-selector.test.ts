import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPortOptions,
  canCalculateChecksum,
  checksumInputState,
  connectedPortNames,
  isCopyableChecksumResult,
  localizeChecksumOptions,
  localizeValueOptions,
  missingActivePorts,
  nextSelectedPort,
  normalizeChecksumInputValue,
  serialFormatLabel,
  serialParityCode,
  serialSignalSummary,
} from '../../src/lib/port-selector.ts';
import type { PortConfig } from '../../src/types/index.ts';

test('derives connected, missing, and selectable ports', () => {
  const sessions = [
    { portName: 'COM1', isConnected: true },
    { portName: 'COM2', isConnected: false },
    { portName: 'COM3', isConnected: true },
  ];
  const usedPorts = connectedPortNames(sessions);

  assert.deepEqual([...usedPorts].sort(), ['COM1', 'COM3']);
  assert.deepEqual(missingActivePorts(sessions, ['COM1', 'COM2']), ['COM3']);
  assert.deepEqual(buildPortOptions(['COM1', 'COM2', 'COM3'], usedPorts, 'in use'), [
    { label: 'COM1 (in use)', value: 'COM1', disabled: true },
    { label: 'COM2', value: 'COM2', disabled: false },
    { label: 'COM3 (in use)', value: 'COM3', disabled: true },
  ]);
});

test('selects the first available port only when current selection is empty', () => {
  assert.equal(nextSelectedPort('', ['COM4', 'COM5']), 'COM4');
  assert.equal(nextSelectedPort('COM9', ['COM4', 'COM5']), 'COM9');
  assert.equal(nextSelectedPort('', []), '');
});

test('formats serial config summary labels', () => {
  const base: PortConfig = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    dtr: false,
    rts: false,
  };

  assert.equal(serialParityCode('none'), 'N');
  assert.equal(serialParityCode('odd'), 'O');
  assert.equal(serialParityCode('even'), 'E');
  assert.equal(serialFormatLabel(base), '8N1');
  assert.equal(serialFormatLabel({ ...base, dataBits: 7, parity: 'even', stopBits: 2 }), '7E2');
  assert.equal(serialSignalSummary(base, 'None'), 'None');
  assert.equal(serialSignalSummary({ ...base, dtr: true }, 'None'), 'DTR');
  assert.equal(serialSignalSummary({ ...base, dtr: true, rts: true }, 'None'), 'DTR+RTS');
});

test('localizes value and checksum options without changing values', () => {
  assert.deepEqual(
    localizeValueOptions(
      [
        { label: 'None', value: 'none' },
        { label: 'Hardware', value: 'hardware' },
      ],
      (value, fallback) => `${fallback}:${value}`,
    ),
    [
      { label: 'None:none', value: 'none' },
      { label: 'Hardware:hardware', value: 'hardware' },
    ],
  );

  assert.deepEqual(
    localizeChecksumOptions(
      [
        { label: 'Checksum', value: 'CHECKSUM' },
        { label: 'CRC-16', value: 'CRC16' },
      ],
      'Sum',
    ),
    [
      { label: 'Sum', value: 'CHECKSUM' },
      { label: 'CRC-16', value: 'CRC16' },
    ],
  );
});

test('reports checksum input validity, byte count, and calculation eligibility', () => {
  assert.deepEqual(checksumInputState(''), {
    isValid: true,
    byteCount: 0,
    status: undefined,
  });
  assert.deepEqual(checksumInputState('AA BB CC'), {
    isValid: true,
    byteCount: 3,
    status: undefined,
  });
  assert.deepEqual(checksumInputState('AA B'), {
    isValid: false,
    byteCount: 1,
    status: 'error',
  });

  assert.equal(canCalculateChecksum('AA BB'), true);
  assert.equal(canCalculateChecksum('AA B'), false);
  assert.equal(canCalculateChecksum('  '), false);
});

test('normalizes valid checksum input and preserves invalid or empty values', () => {
  assert.equal(normalizeChecksumInputValue('aa,bb cc'), 'AA BB CC');
  assert.equal(normalizeChecksumInputValue('AA B'), 'AA B');
  assert.equal(normalizeChecksumInputValue('  '), '  ');
});

test('guards checksum copy result', () => {
  assert.equal(isCopyableChecksumResult('AB CD', 'Failed'), true);
  assert.equal(isCopyableChecksumResult('', 'Failed'), false);
  assert.equal(isCopyableChecksumResult('Failed', 'Failed'), false);
});
