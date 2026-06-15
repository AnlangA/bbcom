import type { AiModel, LogAiContextMode } from '../../types';
import type { AiRisk } from '../../lib/ipc';
import { t } from '../../lib/i18n';

export const aiModelOptions: { label: string; value: AiModel }[] = [
  { label: 'GLM-5.1', value: 'glm-5.1' },
  { label: 'GLM-5 Turbo', value: 'glm-5-turbo' },
  { label: 'GLM-4.7', value: 'glm-4.7' },
  { label: 'GLM-4.5 Air', value: 'glm-4.5-air' },
];

export function getLogContextModeOptions(): { label: string; value: LogAiContextMode }[] {
  return [
    { label: t('ai.context.latest10k'), value: 'latest-10k' },
    { label: t('ai.context.latestNFrames'), value: 'latest-n-frames' },
    { label: t('ai.context.fullCapped'), value: 'full-capped' },
  ];
}

export const aiModelMenuProps = {
  class: 'ai-model-menu',
  style: 'max-height: 72px;',
};

/** Display label for each AI command risk level. */
export function aiRiskLabel(risk: AiRisk): string {
  return t(`ai.risk.${risk}`);
}

export type RiskTagType = 'success' | 'warning' | 'error';

/** Map an AI risk level to a naive-ui tag type for the result card. */
export function aiRiskTagType(risk: AiRisk): RiskTagType {
  return risk === 'safe' ? 'success' : risk === 'caution' ? 'warning' : 'error';
}
