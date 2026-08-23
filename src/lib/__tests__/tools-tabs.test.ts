import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  activeToolCounts,
  buildQuickCommandPayload,
  canRunToolAction,
  defaultToolsTab,
} from '@/lib/tools-tabs.ts';
import { createSessionRecord } from '@/lib/session-persistence.ts';
import type { PortConfig, SerialSession } from '@/types/index.ts';

const cfg: PortConfig = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function session(overrides: Partial<SerialSession> = {}): SerialSession {
  return createSessionRecord('s1', 'COM1', cfg, overrides);
}

test('activeToolCounts counts active tools by their tab badge semantics', () => {
  const s = session({
    macros: [
      { id: 'm1', name: 'Boot', steps: [{ data: 'AT', isHex: false, delayMs: 0 }] },
      { id: 'm2', name: 'Ping', steps: [{ data: 'PING', isHex: false, delayMs: 0 }] },
    ],
    triggers: [
      {
        id: 't1',
        name: 'Login',
        enabled: true,
        matchMode: 'text',
        pattern: 'login:',
        response: 'root',
        responseIsHex: false,
        cooldownMs: 0,
      },
      {
        id: 't2',
        name: 'Off',
        enabled: false,
        matchMode: 'text',
        pattern: 'ready',
        response: 'go',
        responseIsHex: false,
        cooldownMs: 0,
      },
    ],
    highlights: [
      {
        id: 'h1',
        name: 'Errors',
        enabled: true,
        matchMode: 'text',
        pattern: 'ERR',
        direction: 'RX',
        color: 'red',
      },
      {
        id: 'h2',
        name: 'Disabled',
        enabled: false,
        matchMode: 'text',
        pattern: 'DBG',
        direction: 'ALL',
        color: 'amber',
      },
    ],
  });

  assert.deepEqual(
    activeToolCounts(
      s,
      [{ id: 'q1', name: 'Quick', data: 'AT', isHex: false }],
      [
        { data: 'A', isHex: false },
        { data: 'B', isHex: true },
      ],
    ),
    {
      quick: 1,
      macros: 2,
      triggers: 1,
      highlights: 1,
      history: 2,
      checksum: 0,
    },
  );
});

test('defaultToolsTab keeps user-selected tabs and otherwise follows tool priority', () => {
  assert.equal(
    defaultToolsTab('history', {
      quick: 0,
      macros: 1,
      triggers: 1,
      highlights: 1,
      history: 1,
      checksum: 0,
    }),
    'history',
  );
  assert.equal(
    defaultToolsTab('quick', {
      quick: 1,
      macros: 1,
      triggers: 1,
      highlights: 1,
      history: 1,
      checksum: 0,
    }),
    'quick',
  );
  assert.equal(
    defaultToolsTab('quick', {
      quick: 0,
      macros: 1,
      triggers: 1,
      highlights: 1,
      history: 1,
      checksum: 0,
    }),
    'macros',
  );
  assert.equal(
    defaultToolsTab('quick', {
      quick: 0,
      macros: 0,
      triggers: 1,
      highlights: 1,
      history: 1,
      checksum: 0,
    }),
    'triggers',
  );
  assert.equal(
    defaultToolsTab('quick', {
      quick: 0,
      macros: 0,
      triggers: 0,
      highlights: 1,
      history: 1,
      checksum: 0,
    }),
    'highlights',
  );
  assert.equal(
    defaultToolsTab('quick', {
      quick: 0,
      macros: 0,
      triggers: 0,
      highlights: 0,
      history: 1,
      checksum: 0,
    }),
    'history',
  );
});

test('buildQuickCommandPayload preserves data and falls back to truncated input name', () => {
  assert.equal(buildQuickCommandPayload('   ', 'name', false), null);
  assert.deepEqual(buildQuickCommandPayload('AT+RESET', ' Reset ', false), {
    name: 'Reset',
    data: 'AT+RESET',
    isHex: false,
  });
  assert.deepEqual(buildQuickCommandPayload('123456789012345', '', true), {
    name: '123456789012...',
    data: '123456789012345',
    isHex: true,
  });
});

test('canRunToolAction mirrors the component disabled guard', () => {
  assert.equal(canRunToolAction(undefined), true);
  assert.equal(canRunToolAction(false), true);
  assert.equal(canRunToolAction(true), false);
});
