import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runControlFlow,
  matchesCondition,
  DEFAULT_MAX_STEPS,
  type ControlFlowMacro,
  type ControlFlowHost,
  type ControlStep,
} from '../../src/lib/macro-control-flow.ts';

/** Build a test host with injectable send/delay/RX behavior. */
function makeHost(
  opts: {
    sendOk?: boolean;
    rxTexts?: string[];
    onRxCallback?: (cb: (text: string) => void) => () => void;
  } = {},
): { host: ControlFlowHost; sent: Array<{ data: string; isHex: boolean }>; delays: number[] } {
  const sent: Array<{ data: string; isHex: boolean }> = [];
  const delays: number[] = [];
  let rxIndex = 0;
  const rxTexts = opts.rxTexts ?? [];
  const host: ControlFlowHost = {
    send: async (data, isHex) => {
      sent.push({ data, isHex });
      return opts.sendOk !== false;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
    lastRxText: () => rxTexts[Math.min(rxIndex, rxTexts.length - 1)] ?? '',
    onRxBytes: opts.onRxCallback ?? (() => () => {}),
  };
  // Advance rxIndex on each lastRxText call so sequential reads return the next text.
  const origLastRx = host.lastRxText;
  host.lastRxText = () => {
    const t = origLastRx();
    rxIndex = Math.min(rxIndex + 1, Math.max(0, rxTexts.length - 1));
    return t;
  };
  return { host, sent, delays };
}

function macro(steps: ControlStep[], maxSteps?: number): ControlFlowMacro {
  return { id: 'm1', name: 'test', steps, maxSteps };
}

const S = (data: string, isHex = false): ControlStep => ({ type: 'send', data, isHex });
const D = (ms: number): ControlStep => ({ type: 'delay', ms });
const L = (name: string): ControlStep => ({ type: 'label', name });
const G = (target: string): ControlStep => ({ type: 'goto', target });
const W = (pattern: string, timeoutMs: number, isHex = false): ControlStep => ({
  type: 'wait',
  pattern,
  timeoutMs,
  isHex,
});
const I = (contains: string, then: string, els?: string): ControlStep => ({
  type: 'if',
  condition: { contains },
  then,
  else: els,
});

test('matchesCondition: case-insensitive substring match', () => {
  assert.equal(matchesCondition('OK', 'ok'), true);
  assert.equal(matchesCondition('ERROR: timeout', 'error'), true);
  assert.equal(matchesCondition('ready', 'READY'), true);
  assert.equal(matchesCondition('booting', 'ready'), false);
  assert.equal(matchesCondition('anything', ''), true, 'empty pattern always matches');
});

test('send + delay: runs steps in order, collecting sends and delays', async () => {
  const { host, sent, delays } = makeHost();
  const result = await runControlFlow(macro([S('AT'), D(100), S('AT+RESET')]), host);
  assert.deepEqual(result.failedAt, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(
    sent.map((s) => s.data),
    ['AT', 'AT+RESET'],
  );
  assert.deepEqual(delays, [100]);
});

test('send failure stops execution and reports the failing index', async () => {
  const { host, sent } = makeHost({ sendOk: false });
  const result = await runControlFlow(macro([S('first'), S('second')]), host);
  assert.equal(result.failedAt, 0);
  assert.deepEqual(
    sent.map((s) => s.data),
    ['first'],
    'second never sent',
  );
});

test('wait: resolves immediately when the pattern already arrived', async () => {
  const { host } = makeHost({ rxTexts: ['OK\r\n'] });
  const result = await runControlFlow(macro([W('OK', 5000)]), host);
  assert.equal(result.timedOut, false);
  assert.equal(result.failedAt, null);
});

test('wait: times out when the pattern never arrives', async () => {
  const { host } = makeHost({ rxTexts: ['something else'], onRxCallback: () => () => {} });
  const result = await runControlFlow(macro([W('READY', 50)]), host);
  assert.equal(result.timedOut, true, 'wait timed out');
  assert.equal(result.failedAt, null);
});

test('wait: matches when the host reports matching RX bytes', async () => {
  // Simulate the host delivering 'READY' after 10ms.
  const { host } = makeHost({
    rxTexts: [''],
    onRxCallback: (cb) => {
      const t = setTimeout(() => cb('DEVICE READY'), 10);
      return () => clearTimeout(t);
    },
  });
  const result = await runControlFlow(macro([W('READY', 1000)]), host);
  assert.equal(result.timedOut, false, 'matched before timeout');
});

test('if/then: jumps to the then-label when condition is true', async () => {
  const { host, sent } = makeHost({ rxTexts: ['OK'] });
  // if OK → goto success; else → goto fail
  const steps = [
    I('OK', 'success', 'fail'),
    L('fail'),
    S('FAIL_PATH'),
    G('end'),
    L('success'),
    S('SUCCESS_PATH'),
    L('end'),
  ];
  const result = await runControlFlow(macro(steps), host);
  assert.equal(result.failedAt, null);
  assert.deepEqual(
    sent.map((s) => s.data),
    ['SUCCESS_PATH'],
    'took the then branch',
  );
});

test('if/else: jumps to the else-label when condition is false', async () => {
  const { host, sent } = makeHost({ rxTexts: ['ERROR'] });
  const steps = [
    I('OK', 'success', 'fail'),
    L('fail'),
    S('FAIL_PATH'),
    G('end'),
    L('success'),
    S('SUCCESS_PATH'),
    L('end'),
  ];
  const result = await runControlFlow(macro(steps), host);
  assert.deepEqual(
    sent.map((s) => s.data),
    ['FAIL_PATH'],
    'took the else branch',
  );
});

test('goto/label: loops a bounded number of times then exits via condition', async () => {
  // A countdown loop: label loop → send TICK → goto loop. With maxSteps=5 it
  // must stop (hitStepLimit) rather than looping forever.
  const { host } = makeHost();
  const steps: ControlStep[] = [L('loop'), S('TICK'), G('loop')];
  const result = await runControlFlow(macro(steps, 5), host);
  assert.equal(result.hitStepLimit, true, 'maxSteps guard fired');
  assert.ok(result.stepsExecuted >= 5);
});

test('goto to an unknown label stops execution (no silent infinite loop)', async () => {
  const { host } = makeHost();
  const result = await runControlFlow(macro([G('nonexistent')]), host);
  assert.equal(result.failedAt, null);
  assert.equal(result.stepsExecuted, 1, 'stopped after the goto');
});

test('full bring-up script: send AT → wait OK → if OK send CMD else send RETRY', async () => {
  const { host, sent } = makeHost({
    rxTexts: ['AT\r\nOK\r\n'],
    onRxCallback: (cb) => {
      const t = setTimeout(() => cb('OK'), 5);
      return () => clearTimeout(t);
    },
  });
  const steps = [
    S('AT'),
    W('OK', 2000),
    I('OK', 'go', 'retry'),
    L('retry'),
    S('ATR'),
    G('end'),
    L('go'),
    S('AT+CMD'),
    L('end'),
  ];
  const result = await runControlFlow(macro(steps), host);
  assert.equal(result.failedAt, null);
  assert.equal(result.timedOut, false);
  // AT sent, wait matched, if OK → go → AT+CMD.
  assert.deepEqual(
    sent.map((s) => s.data),
    ['AT', 'AT+CMD'],
  );
});

test('DEFAULT_MAX_STEPS is a sane anti-loop ceiling', () => {
  assert.ok(DEFAULT_MAX_STEPS >= 1000, 'ceiling is high enough for real macros');
  assert.ok(DEFAULT_MAX_STEPS <= 100_000, 'ceiling is low enough to catch loops');
});
