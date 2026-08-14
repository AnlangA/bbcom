import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim() || rustHostTuple();
if (!/^[A-Za-z0-9_.-]{3,128}$/.test(targetTriple)) {
  throw new Error('Tauri did not provide a valid target triple for the plugin sidecar');
}

const cargoArguments = ['build', '-p', 'bbcom-plugin-host', '--locked', '--target', targetTriple];
if (!debug) cargoArguments.push('--release');
run('cargo', cargoArguments);

const windowsTarget = targetTriple.includes('windows');
const extension = windowsTarget ? '.exe' : '';
const profile = debug ? 'debug' : 'release';
const source = resolve(
  workspaceRoot,
  'target',
  targetTriple,
  profile,
  `bbcom-plugin-host${extension}`,
);
const destination = resolve(
  workspaceRoot,
  'src-tauri',
  'binaries',
  `bbcom-plugin-host-${targetTriple}${extension}`,
);
if (!statSync(source).isFile()) throw new Error('Cargo did not produce the plugin sidecar');
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);

function rustHostTuple() {
  const result = spawnSync('rustc', ['--print', 'host-tuple'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'rustc host tuple failed');
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
  }
}
