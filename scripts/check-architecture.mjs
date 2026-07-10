import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.vue']);
const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) collectFiles(path, files);
    else if (sourceExtensions.has(extname(entry))) files.push(normalize(path));
  }
  return files;
}

const files = collectFiles(sourceRoot);
const fileSet = new Set(files);

function resolveSourceImport(fromFile, specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? join(sourceRoot, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[...sourceExtensions].map((extension) => `${base}${extension}`),
    ...[...sourceExtensions].map((extension) => join(base, `index${extension}`)),
  ].map(normalize);
  return candidates.find((candidate) => fileSet.has(candidate) || existsSync(candidate)) ?? null;
}

function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  const imports = [];
  for (const match of source.matchAll(importPattern)) imports.push(match[1] ?? match[2]);
  return imports;
}

const graph = new Map(
  files.map((file) => [
    file,
    importsOf(file)
      .map((specifier) => resolveSourceImport(file, specifier))
      .filter((target) => target && fileSet.has(target)),
  ]),
);

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = [];

function visit(file) {
  if (visited.has(file)) return;
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file]);
    return;
  }
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}

for (const file of files) visit(file);

const boundaryViolations = [];
const forbiddenDomainPackages = [
  'vue',
  'pinia',
  'naive-ui',
  '@tauri-apps/',
  'tauri-plugin-serialplugin-api',
];

for (const file of files) {
  const portablePath = file.split(sep).join('/');
  if (!portablePath.includes('/domain/')) continue;
  for (const specifier of importsOf(file)) {
    const target = resolveSourceImport(file, specifier);
    const targetPath = target?.split(sep).join('/') ?? '';
    if (
      forbiddenDomainPackages.some(
        (dependency) => specifier === dependency || specifier.startsWith(dependency),
      ) ||
      ['/ui/', '/infrastructure/', '/store/'].some((segment) => targetPath.includes(segment))
    ) {
      boundaryViolations.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
}

if (cycles.length || boundaryViolations.length) {
  if (cycles.length) {
    console.error('Circular dependencies:');
    for (const cycle of cycles) {
      console.error(`  ${cycle.map((file) => relative(root, file)).join(' -> ')}`);
    }
  }
  if (boundaryViolations.length) {
    console.error('Domain boundary violations:');
    for (const violation of boundaryViolations) console.error(`  ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed (${files.length} source modules, no cycles).`);
}
