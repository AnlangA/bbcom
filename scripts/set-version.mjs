#!/usr/bin/env node
/** Synchronize the three version authorities from package.json. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packagePath = resolve(root, 'package.json');
const cargoPath = resolve(root, 'src-tauri/Cargo.toml');
const tauriPath = resolve(root, 'src-tauri/tauri.conf.json');

const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error(`package.json version is not SemVer: ${pkg.version}`);
}

const cargo = await readFile(cargoPath, 'utf8');
const nextCargo = cargo.replace(
  /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
  `$1${pkg.version}$2`,
);
if (nextCargo === cargo) throw new Error('could not locate [package].version in Cargo.toml');

const tauri = JSON.parse(await readFile(tauriPath, 'utf8'));
tauri.version = pkg.version;

await Promise.all([
  writeFile(cargoPath, nextCargo),
  writeFile(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`),
]);

process.stdout.write(`Synchronized bbcom version ${pkg.version}\n`);
