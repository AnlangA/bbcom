import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AI_MODEL_IDS,
  AI_MODELS,
  DEFAULT_AI_MODEL,
  aiModelLabel,
  aiModelOptions,
  getAiModelOptions,
  isValidAiModel,
} from '../../src/lib/ai-models.ts';

test('AI model registry is the single source for defaults, validation, labels, and options', () => {
  assert.deepEqual(AI_MODEL_IDS, ['glm-4.5-air', 'glm-4.7', 'glm-5-turbo', 'glm-5.1']);
  assert.equal(DEFAULT_AI_MODEL, 'glm-4.5-air');
  assert.equal(isValidAiModel('glm-5.1'), true);
  assert.equal(isValidAiModel('unregistered-model'), false);
  assert.equal(aiModelLabel('glm-4.7'), 'GLM-4.7');
  assert.equal(aiModelLabel('unknown'), 'unknown');
  assert.deepEqual(
    getAiModelOptions(),
    AI_MODELS.map((model) => ({ label: model.label, value: model.id })),
  );
  assert.equal(aiModelOptions, getAiModelOptions);
});
