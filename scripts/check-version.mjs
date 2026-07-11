#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const cargo = await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
const tauri = JSON.parse(await readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

if (cargoVersion !== pkg.version || tauri.version !== pkg.version) {
  throw new Error(
    `version mismatch: package=${pkg.version}, cargo=${cargoVersion ?? 'missing'}, tauri=${tauri.version ?? 'missing'}`,
  );
}
