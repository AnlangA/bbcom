#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = join(import.meta.dirname, '..');
const testDir = join(root, 'tests/frontend');

const pathMap = {
  // Vue components — insert ui/ segment (order: most specific first)
  'features/session-tabs/': 'features/sessions/ui/',
  'features/session/': 'features/sessions/ui/',
  'features/app-shell/AppShell': 'features/app-shell/ui/AppShell',
  'features/app-shell/CreateSessionDialog': 'features/app-shell/ui/CreateSessionDialog',
  'features/app-shell/SettingsModal': 'features/app-shell/ui/SettingsModal',
  'features/app-shell/ShutdownDialog': 'features/app-shell/ui/ShutdownDialog',
  'features/status-bar/': 'features/app-shell/ui/',
  'features/design-system/': 'design-system/',
  'features/ai/AiLogAssistant': 'features/ai/ui/AiLogAssistant',
  'features/ai/AiPanel': 'features/ai/ui/AiPanel',
  'features/ai/AiSettingsPanel': 'features/ai/ui/AiSettingsPanel',
  'features/send-panel/AiTerminalAssistant': 'features/send-panel/ui/AiTerminalAssistant',
  'features/send-panel/SendPanel': 'features/send-panel/ui/SendPanel',
  'features/send-panel/ToolsTabs': 'features/send-panel/ui/ToolsTabs',
  'features/send-panel/TriggerPanel': 'features/send-panel/ui/TriggerPanel',
  'features/send-panel/HighlightPanel': 'features/send-panel/ui/HighlightPanel',
  'features/send-panel/MacroPanel': 'features/send-panel/ui/MacroPanel',
  'features/send-panel/ChecksumPanel': 'features/send-panel/ui/ChecksumPanel',
  'features/terminal/PacketRow': 'features/terminal/ui/PacketRow',
  'features/terminal/DataPacketList': 'features/terminal/ui/DataPacketList',
  'features/terminal/ParserPanel': 'features/terminal/ui/ParserPanel',
  'features/terminal/ModbusPanel': 'features/terminal/ui/ModbusPanel',
  'features/terminal/ModbusHeader': 'features/terminal/ui/ModbusHeader',
  'features/terminal/ModbusAddRegisterForm': 'features/terminal/ui/ModbusAddRegisterForm',
  'features/terminal/ModbusRegisterRow': 'features/terminal/ui/ModbusRegisterRow',
  'features/terminal/ParserConfigBar': 'features/terminal/ui/ParserConfigBar',
  'features/terminal/ParserFrameDetail': 'features/terminal/ui/ParserFrameDetail',
  'features/terminal/WaveformLegend': 'features/terminal/ui/WaveformLegend',
  'features/terminal/WaveformPanel': 'features/terminal/ui/WaveformPanel',
  'features/terminal/McumgrPanel': 'features/terminal/ui/mcumgr/McumgrPanel',
  'features/terminal/SerialShellPanel': 'features/terminal/ui/SerialShellPanel',
  'composables/useSerialConnection': 'features/sessions/application/use-serial-connection',
  'composables/useSessionFrames': 'features/sessions/application/use-session-frames',
  'composables/useSessionModbus': 'features/sessions/application/use-session-modbus',
  'composables/useSessionMcumgr': 'features/sessions/application/use-session-mcumgr',
  'composables/useModbusMaster': 'features/sessions/application/use-modbus-master',
  'composables/usePacketFormatter': 'features/terminal/application/use-packet-formatter',
  'composables/usePacketFilter': 'features/terminal/application/use-packet-filter',
  'composables/usePacketVirtualScroll': 'features/terminal/application/use-packet-virtual-scroll',
  'composables/useExport': 'features/workspace/application/use-export',
  'composables/useAutoLog': 'features/sessions/application/use-auto-log',
  'composables/useMacroRunner': 'features/sessions/application/use-macro-runner',
  'composables/useTriggers': 'features/sessions/application/use-triggers',
  'composables/useAiWindowSession': 'features/ai/application/use-ai-window-session',
  'composables/useAiSessionBridge': 'features/ai/application/use-ai-session-bridge',
  'composables/useAiWindowState': 'features/ai/application/use-ai-window-state',
  'composables/useAppShortcuts': 'features/app-shell/application/use-app-shortcuts',
  'composables/usePortWatcher': 'features/serial/application/use-port-watcher',
  'composables/useSessionActions': 'features/sessions/application/use-session-actions',
  'composables/useSessionShortcuts': 'features/sessions/application/use-session-shortcuts',
  'composables/useConfirmRemove': 'features/app-shell/application/use-confirm-remove',
  'features/sessions/application/useSerialConnection': 'features/sessions/application/use-serial-connection',
  'features/sessions/application/useSessionFrames': 'features/sessions/application/use-session-frames',
  'features/sessions/application/useSessionModbus': 'features/sessions/application/use-session-modbus',
  'features/sessions/application/useSessionMcumgr': 'features/sessions/application/use-session-mcumgr',
  'features/sessions/application/useModbusMaster': 'features/sessions/application/use-modbus-master',
  'features/sessions/application/usePacketFormatter': 'features/terminal/application/use-packet-formatter',
  'features/sessions/application/usePacketFilter': 'features/terminal/application/use-packet-filter',
  'features/sessions/application/usePacketVirtualScroll': 'features/terminal/application/use-packet-virtual-scroll',
  'features/sessions/application/useExport': 'features/workspace/application/use-export',
  'features/sessions/application/useAutoLog': 'features/sessions/application/use-auto-log',
  'features/sessions/application/useMacroRunner': 'features/sessions/application/use-macro-runner',
  'features/sessions/application/useTriggers': 'features/sessions/application/use-triggers',
  'features/sessions/application/useAiWindowSession': 'features/ai/application/use-ai-window-session',
  'features/sessions/application/useAiSessionBridge': 'features/ai/application/use-ai-session-bridge',
  'features/sessions/application/useAiWindowState': 'features/ai/application/use-ai-window-state',
  'features/sessions/application/useAppShortcuts': 'features/app-shell/application/use-app-shortcuts',
  'features/sessions/application/usePortWatcher': 'features/serial/application/use-port-watcher',
  'features/sessions/application/useSessionActions': 'features/sessions/application/use-session-actions',
  'features/sessions/application/useSessionShortcuts': 'features/sessions/application/use-session-shortcuts',
  'components/ui/': 'design-system/',
  'components/app-shell/': 'features/app-shell/ui/',
  'components/session/': 'features/sessions/ui/',
  'components/session-tabs/': 'features/sessions/ui/',
  'components/terminal/': 'features/terminal/ui/',
  'components/send-panel/': 'features/send-panel/ui/',
  'components/workspace/': 'features/workspace/ui/',
  'components/ai/': 'features/ai/ui/',
  'components/status-bar/': 'features/app-shell/ui/',
  'features/ai/ai-options': 'features/ai/ui/ai-options',
  'styles/naive-theme': 'design-system/naive-theme',
};

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (extname(entry) === '.ts') files.push(path);
  }
  return files;
}

let changed = 0;
for (const file of walk(testDir)) {
  let content = readFileSync(file, 'utf8');
  const original = content;
  for (const [from, to] of Object.entries(pathMap)) {
    content = content.split(from).join(to);
  }
  if (content !== original) {
    writeFileSync(file, content);
    changed++;
  }
}
console.log(`Fixed ${changed} test files`);
