#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const checks = [
  ['frontend coverage', ['run', 'coverage:frontend']],
  ['P0 frontend coverage', ['run', 'coverage:p0']],
];
const failures = [];

for (const [label, args] of checks) {
  console.log(`\nRunning ${label}...`);
  const result = spawnSync(pnpm, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    failures.push(`${label}: ${result.error.message}`);
  } else if (result.status !== 0) {
    failures.push(`${label}: exited with status ${result.status ?? 'unknown'}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFrontend coverage gate failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
}
