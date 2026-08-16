import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'src');
const tokenDefinitionFiles = [
  'src/styles/variables.css',
  'src/styles/global.css',
  'src/styles/packet-columns.css',
];
const scannedExtensions = new Set(['.vue', '.css']);

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) collectFiles(path, files);
    else if (scannedExtensions.has(extname(entry))) files.push(normalize(path));
  }
  return files;
}

const defined = new Set();
for (const file of tokenDefinitionFiles) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const match of text.matchAll(/(^|[\s{;])(--[a-z0-9-]+)\s*:/g)) defined.add(match[2]);
}

const usagePattern = /var\((--[a-z0-9-]+)/g;
const violations = [];
for (const file of collectFiles(sourceRoot)) {
  const text = readFileSync(file, 'utf8');
  const portablePath = relative(root, file).split('\\').join('/');
  // Token definition files may self-reference; only check usages there too.
  for (const match of text.matchAll(usagePattern)) {
    if (!defined.has(match[1])) violations.push(`${portablePath} -> ${match[1]}`);
  }
}

if (violations.length) {
  console.error(`Undefined CSS custom property tokens (${violations.length}):`);
  for (const violation of [...new Set(violations)].sort()) console.error(`  ${violation}`);
  console.error(
    `Define them in src/styles/variables.css or replace with an existing semantic token.`,
  );
  process.exitCode = 1;
} else {
  console.log(`CSS token check passed (${defined.size} defined tokens).`);
}
