import type { AiModel, LogAiContextMode } from '@/types';
import type { AiRisk } from '@/features/platform/native';
import { getAiModelOptions } from '@/lib/ai-models';
import { t } from '@/lib/i18n';

export const aiModelOptions: { label: string; value: AiModel }[] = getAiModelOptions();

export function getLogContextModeOptions(): { label: string; value: LogAiContextMode }[] {
  return [
    { label: t('ai.context.latest10k'), value: 'latest-10k' },
    { label: t('ai.context.latestNFrames'), value: 'latest-n-frames' },
    { label: t('ai.context.fullCapped'), value: 'full-capped' },
  ];
}

/** Display label for each AI command risk level. */
export function aiRiskLabel(risk: AiRisk): string {
  return t(`ai.risk.${risk}`);
}

export type RiskTagType = 'success' | 'warning' | 'error';

/** Map an AI risk level to a naive-ui tag type for the result card. */
export function aiRiskTagType(risk: AiRisk): RiskTagType {
  return risk === 'safe' ? 'success' : risk === 'caution' ? 'warning' : 'error';
}
