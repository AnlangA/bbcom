import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'src');
const tokenDefinitionDirs = [join(sourceRoot, 'design-system', 'tokens')];
const tokenDefinitionFiles = [
  'src/styles/global.css',
  'src/styles/packet-columns.css',
  'src/styles/ansi-packet.css',
];
const scannedExtensions = new Set(['.vue', '.css']);
const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) collectFiles(path, files);
    else if (scannedExtensions.has(extname(entry))) files.push(normalize(path));
  }
  return files;
}

function collectCssFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) collectCssFiles(path, files);
    else if (extname(entry) === '.css') files.push(normalize(path));
  }
  return files;
}

function extractStyleBlocks(text) {
  const blocks = [];
  const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  for (const match of text.matchAll(stylePattern)) blocks.push(match[1]);
  return blocks;
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

const defined = new Set();
for (const dir of tokenDefinitionDirs) {
  for (const file of collectCssFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(^|[\s{;])(--[a-z0-9-]+)\s*:/g)) defined.add(match[2]);
  }
}
for (const file of tokenDefinitionFiles) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const match of text.matchAll(/(^|[\s{;])(--[a-z0-9-]+)\s*:/g)) defined.add(match[2]);
}

const usagePattern = /var\((--[a-z0-9-]+)/g;
const undefinedTokens = [];
for (const file of collectFiles(sourceRoot)) {
  const text = readFileSync(file, 'utf8');
  const portablePath = relative(root, file).split('\\').join('/');
  for (const match of text.matchAll(usagePattern)) {
    if (!defined.has(match[1])) undefinedTokens.push(`${portablePath} -> ${match[1]}`);
  }
}

const hexViolations = [];
const featuresUiRoot = join(sourceRoot, 'features');
for (const file of collectFiles(featuresUiRoot)) {
  const portablePath = relative(root, file).split('\\').join('/');
  if (!portablePath.includes('/ui/')) continue;

  const text = readFileSync(file, 'utf8');
  const styleSources =
    extname(file) === '.vue' ? extractStyleBlocks(text) : extname(file) === '.css' ? [text] : [];

  for (const block of styleSources) {
    const stripped = stripCssComments(block);
    for (const match of stripped.matchAll(hexPattern)) {
      hexViolations.push(`${portablePath} -> ${match[0]}`);
    }
  }
}

let failed = false;

if (undefinedTokens.length) {
  failed = true;
  console.error(`Undefined CSS custom property tokens (${undefinedTokens.length}):`);
  for (const violation of [...new Set(undefinedTokens)].sort()) console.error(`  ${violation}`);
  console.error(
    `Define them in src/design-system/tokens/ or replace with an existing semantic token.`,
  );
}

if (hexViolations.length) {
  failed = true;
  console.error(`Hardcoded hex colors in features/*/ui/ (${hexViolations.length}):`);
  for (const violation of [...new Set(hexViolations)].sort()) console.error(`  ${violation}`);
  console.error(`Use var(--*) semantic tokens from src/design-system/tokens/ instead.`);
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`CSS token check passed (${defined.size} defined tokens).`);
}
