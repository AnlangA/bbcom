import type { AiModel, LogAiContextMode } from '../../types';

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
