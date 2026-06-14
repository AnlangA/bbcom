import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DataBits as PluginDataBits,
  StopBits as PluginStopBits,
  Parity as PluginParity,
  FlowControl as PluginFlowControl,
} from 'tauri-plugin-serialplugin-api';
import {
  mapDataBits,
  mapFlowControl,
  mapParity,
  mapStopBits,
} from '../../src/lib/serial-config.ts';

test('mapDataBits maps each valid count and defaults unknown to 8', () => {
  assert.equal(mapDataBits(5), PluginDataBits.Five);
  assert.equal(mapDataBits(6), PluginDataBits.Six);
  assert.equal(mapDataBits(7), PluginDataBits.Seven);
  assert.equal(mapDataBits(8), PluginDataBits.Eight);
  assert.equal(mapDataBits(99), PluginDataBits.Eight); // unknown -> default
});

test('mapStopBits maps 1 and 2 and defaults unknown to 1', () => {
  assert.equal(mapStopBits(1), PluginStopBits.One);
  assert.equal(mapStopBits(2), PluginStopBits.Two);
  assert.equal(mapStopBits(7), PluginStopBits.One); // unknown -> default
});

test('mapParity maps odd/even/none and defaults unknown to none', () => {
  assert.equal(mapParity('odd'), PluginParity.Odd);
  assert.equal(mapParity('even'), PluginParity.Even);
  assert.equal(mapParity('none'), PluginParity.None);
  assert.equal(mapParity('bogus'), PluginParity.None); // unknown -> default
});

test('mapFlowControl maps software/hardware/none and defaults unknown to none', () => {
  assert.equal(mapFlowControl('software'), PluginFlowControl.Software);
  assert.equal(mapFlowControl('hardware'), PluginFlowControl.Hardware);
  assert.equal(mapFlowControl('none'), PluginFlowControl.None);
  assert.equal(mapFlowControl('telepathy'), PluginFlowControl.None); // unknown -> default
});
