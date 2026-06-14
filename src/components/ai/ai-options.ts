import type { AiModel, LogAiContextMode } from '../../types';
import type { AiRisk } from '../../lib/ipc';

export const aiModelOptions: { label: string; value: AiModel }[] = [
  { label: 'GLM-5.1', value: 'glm-5.1' },
  { label: 'GLM-5 Turbo', value: 'glm-5-turbo' },
  { label: 'GLM-4.7', value: 'glm-4.7' },
  { label: 'GLM-4.5 Air', value: 'glm-4.5-air' },
];

export const logContextModeOptions: { label: string; value: LogAiContextMode }[] = [
  { label: '最新 10k 字符', value: 'latest-10k' },
  { label: '最新 N 帧', value: 'latest-n-frames' },
  { label: '全部日志(50k上限)', value: 'full-capped' },
];

export const aiModelMenuProps = {
  class: 'ai-model-menu',
  style: 'max-height: 72px;',
};

/** Chinese display label for each AI command risk level. */
export const AI_RISK_LABELS: Record<AiRisk, string> = {
  safe: '安全',
  caution: '谨慎',
  dangerous: '危险',
};

export type RiskTagType = 'success' | 'warning' | 'error';

/** Map an AI risk level to a naive-ui tag type for the result card. */
export function aiRiskTagType(risk: AiRisk): RiskTagType {
  return risk === 'safe' ? 'success' : risk === 'caution' ? 'warning' : 'error';
}
