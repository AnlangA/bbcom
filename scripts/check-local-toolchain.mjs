#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = (name) => (process.platform === 'win32' && name === 'pnpm' ? 'pnpm.cmd' : name);
const errors = [];

function commandVersion(command, args, label, expression) {
  const result = spawnSync(executable(command), args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows .cmd shims (pnpm.cmd) require a shell; spawnSync without one
    // fails with EINVAL in some host environments.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    errors.push(`${label} is unavailable: ${result.error.message}`);
    return undefined;
  }
  if (result.status !== 0) {
    errors.push(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return undefined;
  }
  const version = result.stdout.match(expression)?.[1];
  if (!version) {
    errors.push(`${label} returned an unrecognized version: ${result.stdout.trim()}`);
    return undefined;
  }
  return version;
}

function requireExact(label, actual, expected, installHint) {
  if (actual !== undefined && actual !== expected) {
    errors.push(
      `${label} must be exactly ${expected}; found ${actual}.${installHint ? ` ${installHint}` : ''}`,
    );
  }
}

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const expectedNode = (await readFile(resolve(root, '.node-version'), 'utf8')).trim();
const expectedPnpm = packageJson.packageManager?.match(/^pnpm@(.+)$/)?.[1];
const workspaceConfig = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
const workspaceNode = workspaceConfig.match(/^nodeVersion:\s*([^\s#]+)\s*$/m)?.[1];
const devRuntime = packageJson.devEngines?.runtime;
const nodeTypes = packageJson.devDependencies?.['@types/node'];
const toolchainToml = await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8');
const expectedRust = toolchainToml.match(/^channel\s*=\s*"([^"]+)"/m)?.[1];

if (!/^\d+\.\d+\.\d+$/.test(expectedNode)) {
  errors.push('.node-version must pin an exact Node.js version.');
}
if (!expectedPnpm) errors.push('package.json must pin packageManager as pnpm@<exact-version>.');
if (!expectedRust) errors.push('rust-toolchain.toml must pin an exact channel.');
if (packageJson.engines?.node !== expectedNode) {
  errors.push('package.json engines.node must exactly match .node-version.');
}
if (
  !devRuntime ||
  Array.isArray(devRuntime) ||
  devRuntime.name !== 'node' ||
  devRuntime.version !== expectedNode ||
  devRuntime.onFail !== 'download'
) {
  errors.push(
    'package.json devEngines.runtime must download the exact Node.js version from .node-version.',
  );
}
if (workspaceNode !== expectedNode) {
  errors.push('pnpm-workspace.yaml nodeVersion must exactly match .node-version.');
}
if (!/^\d+\.\d+\.\d+$/.test(nodeTypes) || nodeTypes.split('.')[0] !== expectedNode.split('.')[0]) {
  errors.push('package.json must exactly pin @types/node to the Node.js major in .node-version.');
}
if (!/^engineStrict:\s*true\s*$/m.test(workspaceConfig)) {
  errors.push('pnpm-workspace.yaml must enable engineStrict.');
}
if (!/^runtimeOnFail:\s*download\s*$/m.test(workspaceConfig)) {
  errors.push('pnpm-workspace.yaml must set runtimeOnFail to download.');
}
if (packageJson.engines?.pnpm !== expectedPnpm) {
  errors.push('package.json engines.pnpm must exactly match packageManager.');
}

requireExact('Node.js', process.versions.node, expectedNode, 'Use the version in .node-version.');
if (expectedPnpm) {
  requireExact('pnpm', commandVersion('pnpm', ['--version'], 'pnpm', /^(\S+)/), expectedPnpm);
}
if (expectedRust) {
  requireExact(
    'rustc',
    commandVersion('rustc', ['--version'], 'rustc', /^rustc\s+(\S+)/),
    expectedRust,
  );
  requireExact(
    'cargo',
    commandVersion('cargo', ['--version'], 'cargo', /^cargo\s+(\S+)/),
    expectedRust,
  );
}
requireExact(
  'cargo-llvm-cov',
  commandVersion('cargo', ['llvm-cov', '--version'], 'cargo llvm-cov', /^cargo-llvm-cov\s+(\S+)/),
  '0.8.7',
  'Install with: cargo install cargo-llvm-cov --version 0.8.7 --locked.',
);
requireExact(
  'cargo-audit',
  commandVersion('cargo', ['audit', '--version'], 'cargo audit', /^cargo-audit(?:-audit)?\s+(\S+)/),
  '0.22.2',
  'Install with: cargo install cargo-audit --version 0.22.2 --locked.',
);
commandVersion('shellcheck', ['--version'], 'shellcheck', /version:\s*v?(\S+)/);

if (errors.length > 0) {
  console.error(`Local quality gate toolchain check failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Toolchains pinned: Node ${expectedNode}, pnpm ${expectedPnpm}, Rust ${expectedRust}.`,
  );
}
