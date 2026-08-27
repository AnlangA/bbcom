import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * SessionView renders every display mode into `.display-area`. Panels size
 * themselves with `flex: 1`, which only resolves against the viewport while
 * that container stays a flex box — as a block box it collapses to content
 * height and long lists get clipped by `overflow: hidden` instead of
 * scrolling. Both halves of that contract are asserted here: the container
 * stays flex, and each panel root also pins its own height so neither change
 * alone can silently reintroduce the clipping.
 */
const DISPLAY_AREA_PANELS = [
  ['src/features/terminal/ui/DataPacketList.vue', 'packet-list'],
  ['src/features/terminal/ui/ParserPanel.vue', 'parser-panel'],
  ['src/features/terminal/ui/ModbusPanel.vue', 'modbus-panel'],
  ['src/features/terminal/ui/WaveformPanel.vue', 'waveform-panel'],
  ['src/features/terminal/ui/SerialShellPanel.vue', 'shell-panel'],
  ['src/features/terminal/ui/mcumgr/McumgrPanel.vue', 'mcumgr-panel'],
] as const;

function rootRule(path: string, className: string): string {
  const source = readFileSync(path, 'utf8');
  const match = new RegExp(`^\\.${className}\\s*\\{([^}]*)\\}`, 'm').exec(source);
  assert.ok(match, `${path} is missing a top-level .${className} rule`);
  return match[1];
}

test('display-area stays a flex container so panel `flex: 1` resolves', () => {
  const rule = rootRule('src/features/sessions/ui/SessionView.vue', 'display-area');
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /flex-direction:\s*column/);
  assert.match(rule, /min-height:\s*0/);
});

test('display-area panels size themselves so inner lists scroll instead of clipping', () => {
  for (const [path, className] of DISPLAY_AREA_PANELS) {
    assert.match(
      rootRule(path, className),
      /height:\s*100%/,
      `.${className} in ${path} must declare height: 100%`,
    );
  }
});

test('parser record list owns a bounded scrollport under the panel body', () => {
  const panel = readFileSync('src/features/terminal/ui/ParserPanel.vue', 'utf8');
  const list = readFileSync('src/features/terminal/ui/ParserRecordList.vue', 'utf8');

  // The body is the row flex container; the list root stretches inside it and
  // the scrollport takes the remaining space with its own overflow.
  assert.match(panel, /\.parser-body\s*\{[^}]*flex:\s*1/);
  assert.match(panel, /\.parser-body\s*\{[^}]*min-height:\s*0/);
  assert.match(list, /\.pp-list-root\s*\{[^}]*flex:\s*1/);
  assert.match(list, /\.pp-list-root\s*\{[^}]*min-height:\s*0/);
  assert.match(list, /\.pp-list\s*\{[^}]*overflow:\s*auto/);
  assert.match(list, /\.pp-list\s*\{[^}]*min-height:\s*0/);
});
