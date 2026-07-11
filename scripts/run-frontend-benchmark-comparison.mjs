#!/usr/bin/env node

import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const runs = 3;
let temporaryRoot;
let baseDirectory;
let worktreeRegistered = false;

// Git hooks export repository-specific variables such as GIT_INDEX_FILE. A
// temporary worktree must never inherit them: they point at the primary index
// and make `git worktree add` resolve a non-existent index inside the new tree.
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function commandOutput(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function run(command, args, cwd, environment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...childEnvironment, ...environment },
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(`${command} ${args.join(' ')} exited with ${signal ?? `status ${code}`}`),
        );
    });
  });
}

function benchmarkEnvironment(outputPath) {
  const environment = { ...process.env, BENCH_OUTPUT: outputPath };
  delete environment.BENCH_WRITE;
  return environment;
}

function benchmarkCommand() {
  const nodeArgs = [
    '--test',
    '--experimental-strip-types',
    '--import',
    './tests/frontend/register-loader.mjs',
    'tests/frontend/perf.bench.ts',
  ];
  if (process.platform !== 'linux') return { command: process.execPath, prefix: nodeArgs };

  const affinity = spawnSync('taskset', ['-pc', String(process.pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (affinity.error?.code === 'ENOENT') {
    console.warn(
      'taskset is unavailable; retaining the required 3 x 7 CV gate without CPU pinning.',
    );
    return { command: process.execPath, prefix: nodeArgs };
  }
  if (affinity.error || affinity.status !== 0) {
    throw new Error(
      affinity.stderr.trim() || 'taskset could not determine the current CPU affinity.',
    );
  }
  const cpu = affinity.stdout.match(/:\s*([0-9]+)/)?.[1];
  if (!cpu)
    throw new Error(`taskset returned an unrecognized CPU affinity: ${affinity.stdout.trim()}`);
  return { command: 'taskset', prefix: ['--cpu-list', cpu, process.execPath, ...nodeArgs] };
}

async function cleanup() {
  if (!temporaryRoot) return;
  if (worktreeRegistered && baseDirectory) {
    const remove = spawnSync(git, ['worktree', 'remove', '--force', baseDirectory], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment,
    });
    if (remove.status !== 0 && !remove.error) {
      console.warn(`Could not unregister temporary benchmark worktree: ${remove.stderr.trim()}`);
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
  baseDirectory = undefined;
  worktreeRegistered = false;
}

async function main() {
  const baseRevision = commandOutput(git, ['rev-parse', 'HEAD']);
  temporaryRoot = await mkdtemp(join(tmpdir(), 'bbcom-precommit-benchmark-'));
  baseDirectory = join(temporaryRoot, 'base');
  const resultsDirectory = join(temporaryRoot, 'results');
  await mkdir(resultsDirectory);

  await run(git, ['worktree', 'add', '--detach', baseDirectory, baseRevision], root);
  worktreeRegistered = true;
  await run(pnpm, ['install', '--frozen-lockfile'], baseDirectory);
  // The comparison deliberately runs the same benchmark contract on both
  // revisions. Source stays at the base revision; only the harness is copied.
  await copyFile(
    resolve(root, 'tests/frontend/perf.bench.ts'),
    resolve(baseDirectory, 'tests/frontend/perf.bench.ts'),
  );

  const benchmark = benchmarkCommand();
  for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
    await run(
      benchmark.command,
      benchmark.prefix,
      baseDirectory,
      benchmarkEnvironment(join(resultsDirectory, `base-${runNumber}.json`)),
    );
    await run(
      benchmark.command,
      benchmark.prefix,
      root,
      benchmarkEnvironment(join(resultsDirectory, `head-${runNumber}.json`)),
    );
  }
  await run(process.execPath, ['scripts/compare-frontend-benchmarks.mjs', resultsDirectory], root);
}

try {
  await main();
} finally {
  await cleanup();
}
