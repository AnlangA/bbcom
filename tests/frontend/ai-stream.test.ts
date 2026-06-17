import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MODELS,
  DEFAULT_AI_MODEL,
  aiModelLabel,
  aiModelOptions,
  isValidAiModel,
  supportsStreaming,
} from '../../src/lib/ai-models.ts';
import { assembleStream, createStreamAccumulator, type SseDelta } from '../../src/lib/ai-stream.ts';

// ---- AI model dispatch table ----

test('AI_MODELS: includes all models from the Rust match table', () => {
  const ids = AI_MODELS.map((m) => m.id);
  assert.ok(ids.includes('glm-4.5-air'));
  assert.ok(ids.includes('glm-4.7'));
  assert.ok(ids.includes('glm-5-turbo'));
  assert.ok(ids.includes('glm-5.1'));
});

test('DEFAULT_AI_MODEL is a valid registered model', () => {
  assert.ok(isValidAiModel(DEFAULT_AI_MODEL));
});

test('isValidAiModel: rejects unknown model ids', () => {
  assert.equal(isValidAiModel('glm-4.5-air'), true);
  assert.equal(isValidAiModel('gpt-4'), false);
  assert.equal(isValidAiModel(''), false);
});

test('supportsStreaming: all current models support streaming', () => {
  for (const m of AI_MODELS) {
    assert.equal(supportsStreaming(m.id), true, `${m.id} supports streaming`);
  }
  assert.equal(supportsStreaming('unknown'), false, 'unknown model is non-streaming');
});

test('aiModelLabel: returns the display label for known models', () => {
  assert.equal(aiModelLabel('glm-4.5-air'), 'GLM-4.5 Air');
  assert.equal(aiModelLabel('unknown-model'), 'unknown-model', 'falls back to id');
});

test('aiModelOptions: returns one entry per model with label+value', () => {
  const opts = aiModelOptions();
  assert.equal(opts.length, AI_MODELS.length);
  for (const o of opts) {
    assert.ok('label' in o && 'value' in o);
    assert.ok(o.label.length > 0);
    assert.ok(o.value.length > 0);
  }
});

// ---- SSE streaming accumulator ----

function delta(text: string, done = false): SseDelta {
  return { delta: text, done };
}

test('assembleStream: reconstructs the full response from incremental deltas', () => {
  const result = assembleStream([delta('Hello'), delta(', '), delta('world!'), delta('', true)]);
  assert.equal(result.text, 'Hello, world!');
  assert.equal(result.done, true);
  assert.equal(result.tokenCount, 3, 'three non-empty tokens');
  assert.equal(result.error, null);
});

test('assembleStream: empty deltas (keep-alive) do not increment tokenCount', () => {
  const result = assembleStream([delta(''), delta(''), delta('OK'), delta('', true)]);
  assert.equal(result.text, 'OK');
  assert.equal(result.tokenCount, 1);
  assert.equal(result.done, true);
});

test('createStreamAccumulator: push mutates state incrementally', () => {
  const acc = createStreamAccumulator();
  assert.equal(acc.state.text, '');
  acc.push(delta('foo'));
  assert.equal(acc.state.text, 'foo');
  assert.equal(acc.state.tokenCount, 1);
  acc.push(delta('bar'));
  assert.equal(acc.state.text, 'foobar');
  acc.push(delta('', true));
  assert.equal(acc.state.done, true);
});

test('createStreamAccumulator: ignores deltas after done', () => {
  const acc = createStreamAccumulator();
  acc.push(delta('done', true));
  acc.push(delta('ignored'));
  assert.equal(acc.state.text, 'done');
  assert.equal(acc.state.tokenCount, 1, 'post-done delta ignored');
});

test('createStreamAccumulator: abort sets an error and stops accumulation', () => {
  const acc = createStreamAccumulator();
  acc.push(delta('partial'));
  acc.abort('connection reset');
  assert.equal(acc.state.error, 'connection reset');
  acc.push(delta('ignored'));
  assert.equal(acc.state.text, 'partial', 'post-abort delta ignored');
});

test('assembleStream: empty delta list produces an empty, not-done result', () => {
  const result = assembleStream([]);
  assert.equal(result.text, '');
  assert.equal(result.done, false);
  assert.equal(result.tokenCount, 0);
});
