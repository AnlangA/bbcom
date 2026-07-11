#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git';

function isContinuousIntegration() {
  const value = process.env.CI?.trim().toLowerCase();
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function runGit(args) {
  return spawnSync(gitCommand, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Package lifecycle scripts also run for dependency installs in CI and source
// archives. Hooks are meaningful only for an interactive Git worktree, so
// those installations must be harmless no-ops.
if (isContinuousIntegration()) process.exit(0);

const worktree = runGit(['rev-parse', '--is-inside-work-tree']);
if (worktree.error?.code === 'ENOENT' || worktree.status !== 0) process.exit(0);
if (worktree.stdout.trim() !== 'true') process.exit(0);

const hookPath = resolve(root, '.githooks', 'pre-commit');
if (!existsSync(hookPath)) {
  console.error(`Cannot install bbcom Git hooks: missing ${hookPath}`);
  process.exitCode = 1;
} else {
  const configured = runGit(['config', '--local', 'core.hooksPath', '.githooks']);
  if (configured.error) {
    console.error(`Cannot configure bbcom Git hooks: ${configured.error.message}`);
    process.exitCode = 1;
  } else if (configured.status !== 0) {
    console.error(configured.stderr.trim() || 'Cannot configure bbcom Git hooks.');
    process.exitCode = 1;
  } else {
    console.log('Configured Git hooks path: .githooks');
  }
}
