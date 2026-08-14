#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.env.npm_execpath || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const serverUrl = 'http://127.0.0.1:5173/';
const readyDeadlineMs = 40_000;
const viteCli = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
let vite;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function ensurePortIsAvailable() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', (error) => {
      rejectPort(
        new Error(
          `Browser E2E requires 127.0.0.1:5173, but the port is unavailable: ${error.message}`,
        ),
      );
    });
    probe.listen(5173, '127.0.0.1', () => {
      probe.close((error) => {
        if (error) rejectPort(error);
        else resolvePort();
      });
    });
  });
}

function run(command, args, cwd = root) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
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

async function waitForServer() {
  const deadline = Date.now() + readyDeadlineMs;
  let lastError = 'server did not respond';
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite exited before browser E2E started (status ${vite.exitCode}).`);
    }
    try {
      const response = await fetch(serverUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`Vite did not become ready at ${serverUrl}: ${lastError}`);
}

async function stopVite() {
  if (!vite || vite.exitCode !== null) return;
  vite.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => vite.once('exit', resolveExit)), delay(5_000)]);
  if (vite.exitCode === null) vite.kill('SIGKILL');
}

async function main() {
  await ensurePortIsAvailable();
  vite = spawn(
    process.execPath,
    [viteCli, '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  const startError = await new Promise((resolveStart) => {
    vite.once('error', (error) => resolveStart(error));
    vite.once('spawn', () => resolveStart(undefined));
  });
  if (startError) throw startError;
  await waitForServer();
  await run(pnpm, ['run', 'e2e:browser', ...process.argv.slice(2)]);
}

try {
  await main();
} finally {
  await stopVite();
}
