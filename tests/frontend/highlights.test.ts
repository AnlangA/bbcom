import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findFrameHighlight,
  highlightRuleMatchesFrame,
  normalizeHighlightHexPattern,
} from '../../src/lib/highlights.ts';
import { formatUtf8, toContinuousHex } from '../../src/lib/format.ts';
import type { DataFrame, HighlightRule } from '../../src/types/index.ts';

function frame(direction: DataFrame['direction'], text: string): DataFrame {
  return {
    id: `${direction}-${text}`,
    direction,
    timestamp: 0,
    data: new TextEncoder().encode(text),
  };
}

const accessors = {
  getHexSearchData: (f: DataFrame) => toContinuousHex(f.data),
  getTextSearchData: (f: DataFrame) => formatUtf8(f.data).toLowerCase(),
};

test('normalizeHighlightHexPattern strips separators and lowercases', () => {
  assert.equal(normalizeHighlightHexPattern('FF 00-aa'), 'ff00aa');
});

test('text highlight rules match case-insensitively and respect direction', () => {
  const rule: HighlightRule = {
    id: 'r1',
    name: 'Errors',
    enabled: true,
    matchMode: 'text',
    pattern: 'ERROR',
    direction: 'RX',
    color: 'red',
  };
  assert.equal(highlightRuleMatchesFrame(rule, frame('RX', 'error: boot failed'), accessors), true);
  assert.equal(highlightRuleMatchesFrame(rule, frame('TX', 'error: boot failed'), accessors), false);
});

test('hex highlight rules match continuous bytes', () => {
  const rule: HighlightRule = {
    id: 'r2',
    name: 'Magic',
    enabled: true,
    matchMode: 'hex',
    pattern: '45 52',
    direction: 'ALL',
    color: 'amber',
  };
  assert.equal(highlightRuleMatchesFrame(rule, frame('RX', 'ERROR'), accessors), true);
});

test('findFrameHighlight returns the first matching enabled rule', () => {
  const rules: HighlightRule[] = [
    {
      id: 'off',
      name: 'Disabled',
      enabled: false,
      matchMode: 'text',
      pattern: 'error',
      direction: 'ALL',
      color: 'red',
    },
    {
      id: 'on',
      name: 'Warning',
      enabled: true,
      matchMode: 'text',
      pattern: 'warn',
      direction: 'ALL',
      color: 'amber',
    },
  ];
  assert.equal(findFrameHighlight(rules, frame('RX', 'WARN: low voltage'), accessors)?.id, 'on');
});
