#!/usr/bin/env node
/**
 * Phase 1 directory migration: bulk import path rewrites after git mv.
 * Run from repo root after file moves complete.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcRoot = join(root, 'src');

const replacements = [
  // stores
  ["from '@/stores/app'", "from '@/features/settings/store/app-store'"],
  ["from '@/stores/serial'", "from '@/features/serial/store/serial-store'"],
  ["from './stores/app'", "from '@/features/settings/store/app-store'"],
  ["from './stores/serial'", "from '@/features/serial/store/serial-store'"],
  ["from '../stores/app'", "from '@/features/settings/store/app-store'"],
  ["from '../stores/serial'", "from '@/features/serial/store/serial-store'"],
  ["from '../../stores/app'", "from '@/features/settings/store/app-store'"],
  ["from '../../stores/serial'", "from '@/features/serial/store/serial-store'"],
  // design-system
  ["from '@/components/ui/", "from '@/design-system/"],
  ["from '../ui/", "from '@/design-system/"],
  ["from '../../ui/", "from '@/design-system/"],
  ["from '../../../ui/", "from '@/design-system/"],
  // app-shell
  ["from '@/components/app-shell/", "from '@/features/app-shell/ui/"],
  ["from '@/components/status-bar/", "from '@/features/app-shell/ui/"],
  // sessions ui
  ["from '@/components/session/", "from '@/features/sessions/ui/"],
  ["from '@/components/session-tabs/", "from '@/features/sessions/ui/"],
  // terminal
  ["from '@/components/terminal/", "from '@/features/terminal/ui/"],
  // send-panel
  ["from '@/components/send-panel/", "from '@/features/send-panel/ui/"],
  // workspace
  ["from '@/components/workspace/", "from '@/features/workspace/ui/"],
  // ai
  ["from '@/components/ai/", "from '@/features/ai/ui/"],
  // platform (merge application, shutdown, native)
  ["from '@/features/application'", "from '@/features/platform'"],
  ["from '@/features/application/", "from '@/features/platform/application/"],
  ["from '@/features/shutdown'", "from '@/features/platform'"],
  ["from '@/features/shutdown/", "from '@/features/platform/shutdown/"],
  ["from '@/features/native'", "from '@/features/platform'"],
  ["from '@/features/native/", "from '@/features/platform/native/"],
  // composables -> feature application
  ["from '@/composables/useSerialConnection'", "from '@/features/sessions/application/use-serial-connection'"],
  ["from '@/composables/useSessionFrames'", "from '@/features/sessions/application/use-session-frames'"],
  ["from '@/composables/useSessionModbus'", "from '@/features/sessions/application/use-session-modbus'"],
  ["from '@/composables/useSessionMcumgr'", "from '@/features/sessions/application/use-session-mcumgr'"],
  ["from '@/composables/useTriggers'", "from '@/features/sessions/application/use-triggers'"],
  ["from '@/composables/useMacroRunner'", "from '@/features/sessions/application/use-macro-runner'"],
  ["from '@/composables/useAutoLog'", "from '@/features/sessions/application/use-auto-log'"],
  ["from '@/composables/useSessionActions'", "from '@/features/sessions/application/use-session-actions'"],
  ["from '@/composables/useSessionShortcuts'", "from '@/features/sessions/application/use-session-shortcuts'"],
  ["from '@/composables/useModbusMaster'", "from '@/features/sessions/application/use-modbus-master'"],
  ["from '@/composables/usePacketFormatter'", "from '@/features/terminal/application/use-packet-formatter'"],
  ["from '@/composables/usePacketFilter'", "from '@/features/terminal/application/use-packet-filter'"],
  ["from '@/composables/usePacketVirtualScroll'", "from '@/features/terminal/application/use-packet-virtual-scroll'"],
  ["from '@/composables/useExport'", "from '@/features/workspace/application/use-export'"],
  ["from '@/composables/useAppShortcuts'", "from '@/features/app-shell/application/use-app-shortcuts'"],
  ["from '@/composables/useConfirmRemove'", "from '@/features/app-shell/application/use-confirm-remove'"],
  ["from '@/composables/usePortWatcher'", "from '@/features/serial/application/use-port-watcher'"],
  ["from '@/composables/useAiSessionBridge'", "from '@/features/ai/application/use-ai-session-bridge'"],
  ["from '@/composables/useAiWindowState'", "from '@/features/ai/application/use-ai-window-state'"],
  ["from '@/composables/useAiWindowSession'", "from '@/features/ai/application/use-ai-window-session'"],
  ["from '@/composables/serial/connection-errors'", "from '@/features/serial/application/connection-errors'"],
  ["from '@/composables/serial/shutdown-evidence'", "from '@/features/serial/application/shutdown-evidence-composable'"],
  // bootstrap entry
  ["from './main.ts'", "from './bootstrap/main.ts'"],
  ["src/main.ts", "src/bootstrap/main.ts"],
  // styles tokens
  ["from './styles/variables.css'", "from '@/design-system/tokens/index.css'"],
  ["from '../styles/variables.css'", "from '@/design-system/tokens/index.css'"],
  ["from '@/styles/variables.css'", "from '@/design-system/tokens/index.css'"],
  ["from '@/styles/naive-theme'", "from '@/design-system/naive-theme'"],
  ["from '../styles/naive-theme'", "from '@/design-system/naive-theme'"],
  // SessionRuntimeHost imports SessionView
  ["from '@/components/session/SessionView.vue'", "from '@/features/sessions/ui/SessionView.vue'"],
  ["from '../../../components/session/SessionView.vue'", "from '../ui/SessionView.vue'"],
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'target') continue;
      walk(path, files);
    } else if (['.ts', '.tsx', '.vue', '.mjs', '.json', '.html', '.css'].includes(extname(entry))) {
      files.push(path);
    }
  }
  return files;
}

let changed = 0;
for (const file of walk(join(root, 'src')).concat(walk(join(root, 'tests'))).concat(walk(join(root, 'scripts')))) {
  if (file.includes('migrate-phase1.mjs')) continue;
  let content = readFileSync(file, 'utf8');
  const original = content;
  for (const [from, to] of replacements) {
    content = content.split(from).join(to);
  }
  if (content !== original) {
    writeFileSync(file, content);
    changed++;
  }
}

// index.html entry
const indexHtml = join(root, 'index.html');
let html = readFileSync(indexHtml, 'utf8');
html = html.replace('/src/main.ts', '/src/bootstrap/main.ts');
writeFileSync(indexHtml, html);

console.log(`Updated ${changed} files`);
