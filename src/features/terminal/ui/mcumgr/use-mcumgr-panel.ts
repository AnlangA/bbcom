import { computed, ref } from 'vue';
import {
  Activity,
  BarChart3,
  FolderTree,
  Layers,
  Package,
  SlidersHorizontal,
  TerminalSquare,
  Zap,
} from '@lucide/vue';
import { t } from '@/lib/i18n';
import { getMcumgrActionLabel } from '@/lib/mcumgr-error';
import { formatBytes } from '@/lib/format';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrClientConfig } from '@/types';

export const tabDefs = [
  { id: 'os', icon: Activity },
  { id: 'image', icon: Package },
  { id: 'shell', icon: TerminalSquare },
  { id: 'fs', icon: FolderTree },
  { id: 'settings', icon: SlidersHorizontal },
  { id: 'stats', icon: BarChart3 },
  { id: 'groups', icon: Layers },
  { id: 'zephyr', icon: Zap },
] as const;

export type McumgrTab = (typeof tabDefs)[number]['id'];

export interface UseMcumgrPanelOptions {
  config: McumgrClientConfig;
  isConnected: boolean;
  mcumgr: SessionMcumgrController;
}

export function useMcumgrPanel(options: UseMcumgrPanelOptions) {
  const activeTab = ref<McumgrTab>('os');
  const settingsOpen = ref(false);
  const osEcho = ref('hi');
  const imageHash = ref('');
  const upgradeOnly = ref(false);
  const shellLine = ref('');
  const fsPath = ref('/');
  const settingName = ref('');
  const settingValue = ref('');
  const statsName = ref('');
  const rawGroup = ref(0);
  const rawCommand = ref(0);
  const rawOp = ref<'read' | 'write'>('read');
  const rawPayload = ref('{}');

  const rawOpOptions = computed(() => [
    { label: t('mcumgr.raw.read'), value: 'read' as const },
    { label: t('mcumgr.raw.write'), value: 'write' as const },
  ]);

  const busy = computed(() => options.mcumgr.busy.value);
  const yieldBannerText = computed(() => {
    const status = options.mcumgr.status.value;
    if (status.kind === 'progress' || status.kind === 'busy') {
      return t('mcumgr.portYield');
    }
    return t('mcumgr.portResume');
  });
  const hasResult = computed(() => options.mcumgr.lastResult.value.length > 0);
  const statusText = computed(() => {
    const status = options.mcumgr.status.value;
    if (status.kind === 'progress') {
      let text = t('mcumgr.status.busy', { action: getMcumgrActionLabel(status.action) });
      text += ` — ${t(`mcumgr.phase.${status.phase}`)}`;
      if (status.detail) text += ` ${status.detail}`;
      if (status.offset !== undefined && status.total !== undefined && status.total > 0) {
        const percent = Math.floor((status.offset / status.total) * 100);
        text += ` ${formatBytes(status.offset)}/${formatBytes(status.total)} (${percent}%)`;
      }
      return text;
    }
    if (status.kind === 'busy') {
      return t('mcumgr.status.busy', { action: getMcumgrActionLabel(status.action) });
    }
    if (status.kind === 'timeout') return t('mcumgr.status.timeout');
    if (status.kind === 'error') return status.message;
    return t('mcumgr.status.idle');
  });
  const statusClass = computed(() => `is-${options.mcumgr.status.value.kind}`);
  const progressPercent = computed(() => {
    const status = options.mcumgr.status.value;
    if (status.kind !== 'progress') return null;
    if (status.offset === undefined || status.total === undefined || status.total <= 0) return null;
    return Math.min(100, Math.max(0, Math.floor((status.offset / status.total) * 100)));
  });

  return {
    activeTab,
    settingsOpen,
    osEcho,
    imageHash,
    upgradeOnly,
    shellLine,
    fsPath,
    settingName,
    settingValue,
    statsName,
    rawGroup,
    rawCommand,
    rawOp,
    rawPayload,
    rawOpOptions,
    busy,
    yieldBannerText,
    hasResult,
    statusText,
    statusClass,
    progressPercent,
  };
}
