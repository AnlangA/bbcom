import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  // The graph contains source modules only. Do not stop on a directory such as
  // `features/sessions` before reaching its `index.ts` barrel.
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function importsOf(file) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
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

// Lower layers must never reach back into a Vue component or feature UI. This
// makes data-plane code safe to run from the session runtime and Worker
// without accidentally importing a renderer concern.
for (const file of files) {
  const portablePath = file.split(sep).join('/');
  const isLib = portablePath.includes('/src/lib/');
  const isRuntime = portablePath.includes('/features/') && portablePath.includes('/runtime/');
  if (!isLib && !isRuntime) continue;
  for (const specifier of importsOf(file)) {
    const target = resolveSourceImport(file, specifier);
    const targetPath = target?.split(sep).join('/') ?? '';
    if (
      targetPath.includes('/src/components/') ||
      (targetPath.includes('/features/') && targetPath.includes('/ui/'))
    ) {
      boundaryViolations.push(`${relative(root, file)} -> ${specifier} (lower layer into UI)`);
    }
  }
}

// Production modules must be reachable from a window entry point or an
// explicitly allowed Worker. This catches “completed” prototypes that have no
// shipping call site while leaving generated declarations and Worker entry
// points out of the result.
const entryFiles = [join(sourceRoot, 'main.ts')].map(normalize).filter((file) => fileSet.has(file));
const workerFiles = files.filter((file) => file.split(sep).join('/').includes('/src/workers/'));
const reachable = new Set();
function markReachable(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  for (const dependency of graph.get(file) ?? []) markReachable(dependency);
}
for (const entry of [...entryFiles, ...workerFiles]) markReachable(entry);

const orphans = files
  .filter((file) => !reachable.has(file))
  .filter((file) => !file.endsWith('.d.ts'))
  .filter((file) => !file.split(sep).join('/').includes('/src/workers/'))
  .map((file) => relative(root, file));

if (cycles.length || boundaryViolations.length || orphans.length) {
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
  if (orphans.length) {
    console.error('Production orphan modules:');
    for (const orphan of orphans) console.error(`  ${orphan}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed (${files.length} source modules, no cycles).`);
}
