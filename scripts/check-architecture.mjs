import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { parse as parseSfc } from 'vue/compiler-sfc';

const repoRoot = resolve(import.meta.dirname, '..');
const sourceExtensions = new Set(['.ts', '.tsx', '.vue']);
const isSelfTest = process.argv.includes('--self-test');

// ---------------------------------------------------------------------------
// Import extraction (TypeScript compiler AST + Vue SFC script blocks)
// ---------------------------------------------------------------------------

function scriptTextFor(file) {
  const text = readFileSync(file, 'utf8');
  if (extname(file) !== '.vue') return { text, scriptKind: ts.ScriptKind.TS };
  const { descriptor, errors } = parseSfc(text, { filename: file });
  if (errors.length > 0) return { text: '', scriptKind: ts.ScriptKind.TS };
  const blocks = [descriptor.script?.content ?? '', descriptor.scriptSetup?.content ?? ''];
  return { text: blocks.join('\n'), scriptKind: ts.ScriptKind.TS };
}

function extractImportSpecifiers(file) {
  const { text, scriptKind } = scriptTextFor(file);
  if (!text.trim()) return [];
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  }
  sourceFile.forEachChild(visit);
  return specifiers;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'test') continue;
      collectFiles(path, files);
    } else if (sourceExtensions.has(extname(entry))) files.push(normalize(path));
  }
  return files;
}

function makeResolver(rootDir, fileSet) {
  const sourceRoot = join(rootDir, 'src');
  return function resolveSourceImport(fromFile, specifier) {
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
  };
}

// ---------------------------------------------------------------------------
// Layer classification used by the architecture gate.
// ---------------------------------------------------------------------------

function layerOf(portablePath) {
  if (portablePath === 'src/bootstrap/main.ts') return 'entry';
  if (portablePath.startsWith('src/bootstrap/')) return 'bootstrap';
  if (portablePath.startsWith('src/design-system/')) return 'design-system';
  if (portablePath.startsWith('src/lib/')) return 'lib';
  if (portablePath === 'src/App.vue' || portablePath === 'src/AiWindow.vue') return 'ui';
  const feature = /^src\/features\/([^/]+)\/(.*)$/.exec(portablePath);
  if (feature) {
    const rest = feature[2];
    if (rest.startsWith('ui/')) return 'ui';
    if (rest.startsWith('application/')) return 'application';
    if (rest.startsWith('domain/')) return 'domain';
    if (rest.startsWith('store/')) return 'store';
    if (rest.startsWith('ports/')) return 'ports';
    if (rest.startsWith('infrastructure/')) return 'infrastructure';
    if (rest === 'index.ts') return 'feature-api';
    return 'feature-core';
  }
  if (portablePath.startsWith('src/types/')) return 'types';
  return 'shared';
}

const TAURI_SDK = '@tauri-apps/api';
const SERIAL_SDK = 'tauri-plugin-serialplugin-api';
const FORBIDDEN_DOMAIN_PACKAGES = ['vue', 'pinia', 'naive-ui', TAURI_SDK, SERIAL_SDK];

function isPackageImport(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

function ruleReports(files, fileSet, resolveImport, displayPath) {
  const reports = [];
  for (const file of files) {
    const portablePath = displayPath(file);
    const layer = layerOf(portablePath);
    const feature = /^src\/features\/([^/]+)\//.exec(portablePath)?.[1] ?? null;
    for (const specifier of extractImportSpecifiers(file)) {
      const target = resolveImport(file, specifier);
      const targetPath = target ? displayPath(target) : null;

      if (layer === 'domain') {
        // Hard rule today: keep parity with the previous checker.
        if (
          FORBIDDEN_DOMAIN_PACKAGES.some((dependency) => isPackageImport(specifier, dependency)) ||
          (targetPath?.includes('/ui/') ?? false) ||
          (targetPath?.includes('/infrastructure/') ?? false) ||
          (targetPath?.includes('/store') ?? false)
        ) {
          reports.push({
            rule: 'domain-framework-free',
            severity: 'hard',
            source: portablePath,
            target: specifier,
          });
        }
      }

      if (layer === 'lib') {
        if (
          (targetPath?.startsWith('src/features/') && targetPath.includes('/ui/')) ||
          targetPath?.endsWith('.vue') ||
          isPackageImport(specifier, TAURI_SDK)
        ) {
          reports.push({
            rule: 'lib-no-reverse-deps',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
      }

      if (layer === 'application') {
        if (targetPath?.endsWith('.vue')) {
          reports.push({
            rule: 'application-no-vue-component',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
        if (isPackageImport(specifier, TAURI_SDK)) {
          reports.push({
            rule: 'application-no-tauri-sdk',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
      }

      if (layer === 'ui') {
        if (isPackageImport(specifier, TAURI_SDK)) {
          reports.push({
            rule: 'ui-no-direct-tauri',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
        if (isPackageImport(specifier, SERIAL_SDK)) {
          reports.push({
            rule: 'ui-no-serial-sdk',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
      }

      if (feature && targetPath) {
        const targetFeature = /^src\/features\/([^/]+)\//.exec(targetPath)?.[1] ?? null;
        if (targetFeature !== null && targetFeature !== feature && !targetPath.startsWith('@')) {
          const barrel = `src/features/${targetFeature}/index.ts`;
          if (targetPath !== barrel) {
            reports.push({
              rule: 'cross-feature-public-api',
              severity: 'report',
              source: portablePath,
              target: specifier,
            });
          }
        }
      }

      if (layer === 'entry') {
        const legalTarget =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier.startsWith('@/design-system/') ||
          specifier.startsWith('@/styles/') ||
          specifier.startsWith('@/features/') ||
          targetPath === 'src/App.vue' ||
          targetPath === 'src/AiWindow.vue' ||
          /^src\/features\/[^/]+\/index\.ts$/.test(targetPath ?? '') ||
          specifier === 'vue' ||
          specifier === 'pinia';
        if (!legalTarget) {
          reports.push({
            rule: 'entry-bootstrap-only',
            severity: 'report',
            source: portablePath,
            target: specifier,
          });
        }
      }
    }
  }
  return reports;
}

// Lower layers must never reach back into a Vue component or feature UI. This
// makes data-plane code safe to run from the session runtime and Worker
// without accidentally importing a renderer concern.
function lowerLayerUiReports(files, resolveImport, displayPath) {
  const reports = [];
  for (const file of files) {
    const portablePath = displayPath(file);
    const isLib = portablePath.startsWith('src/lib/');
    const isRuntime = portablePath.includes('/features/') && portablePath.includes('/runtime/');
    if (!isLib && !isRuntime) continue;
    for (const specifier of extractImportSpecifiers(file)) {
      const target = resolveImport(file, specifier);
      const targetPath = target ? displayPath(target) : '';
      if (
        targetPath.startsWith('src/design-system/') ||
        (targetPath.includes('/features/') && targetPath.includes('/ui/'))
      ) {
        reports.push({
          rule: 'lower-layer-no-ui',
          severity: 'hard',
          source: portablePath,
          target: specifier,
        });
      }
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Scan driver
// ---------------------------------------------------------------------------

function scanSourceTree(rootDir) {
  const sourceRoot = join(rootDir, 'src');
  const files = collectFiles(sourceRoot);
  const fileSet = new Set(files);
  const resolveImport = makeResolver(rootDir, fileSet);
  const displayPath = (file) => relative(rootDir, file).split(sep).join('/');
  const importsOf = (file) => extractImportSpecifiers(file);
  const graph = new Map(
    files.map((file) => [
      file,
      importsOf(file)
        .map((specifier) => resolveImport(file, specifier))
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

  // Production modules must be reachable from a window entry point or an
  // explicitly allowed Worker. This catches "completed" prototypes that have
  // no shipping call site while leaving generated declarations and Worker
  // entry points out of the result.
  //
  const entryFiles = [
    join(sourceRoot, 'bootstrap', 'main.ts'),
    join(sourceRoot, 'App.vue'),
    join(sourceRoot, 'AiWindow.vue'),
  ]
    .map(normalize)
    .filter((file) => fileSet.has(file));
  const workerFiles = files.filter((file) => displayPath(file).includes('/src/workers/'));
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
    .filter((file) => !displayPath(file).includes('/__tests__/'))
    .filter((file) => !displayPath(file).includes('/src/test/'))
    .filter((file) => !displayPath(file).includes('/src/workers/'))
    .filter((file) => {
      const path = displayPath(file);
      if (path === 'src/design-system/index.ts') return false;
      if (/^src\/features\/[^/]+\/index\.ts$/.test(path)) return false;
      if (/^src\/features\/[^/]+\/ui\/index\.ts$/.test(path)) return false;
      return true;
    });

  const ruleResults = [
    ...ruleReports(files, fileSet, resolveImport, displayPath),
    ...lowerLayerUiReports(files, resolveImport, displayPath),
  ];

  return {
    rootDir,
    files,
    cycles,
    orphans,
    hardViolations: ruleResults.filter((report) => report.severity === 'hard'),
    reports: ruleResults.filter((report) => report.severity === 'report'),
    displayPath,
  };
}

// ---------------------------------------------------------------------------
// Rust workspace dependency direction
// ---------------------------------------------------------------------------

const WORKSPACE_LEAF_CRATES = new Set(['bbcom-contracts']);
const APP_CRATE = 'bbcom';

function rustWorkspaceReports() {
  if (!existsSync(join(repoRoot, 'Cargo.toml')) || !existsSync(join(repoRoot, 'crates'))) {
    return [];
  }
  let metadata;
  try {
    metadata = JSON.parse(
      execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    console.log('Rust dependency check skipped (cargo metadata unavailable).');
    return [];
  }
  const members = new Map();
  for (const pkg of metadata.packages) {
    if (resolve(pkg.manifest_path).startsWith(repoRoot)) members.set(pkg.name, pkg);
  }
  const reports = [];
  for (const [name, pkg] of members) {
    if (!name.startsWith('bbcom') || name === APP_CRATE) continue;
    for (const dependency of pkg.dependencies) {
      if (!members.has(dependency.name)) continue;
      if (dependency.name === APP_CRATE) {
        reports.push({
          rule: 'rust-no-app-dependency',
          severity: 'report',
          source: name,
          target: dependency.name,
        });
      }
      if (WORKSPACE_LEAF_CRATES.has(name) && dependency.name !== 'bbcom-contracts') {
        reports.push({
          rule: 'rust-contract-crates-are-leaves',
          severity: 'report',
          source: name,
          target: dependency.name,
        });
      }
    }
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printScan(scan) {
  const { rootDir, files, cycles, orphans, hardViolations, reports, displayPath } = scan;
  let failed = false;
  if (cycles.length) {
    failed = true;
    console.error('Circular dependencies:');
    for (const cycle of cycles) {
      console.error(`  ${cycle.map((file) => relative(rootDir, file)).join(' -> ')}`);
    }
  }
  if (hardViolations.length) {
    failed = true;
    console.error('Boundary violations:');
    for (const violation of hardViolations) {
      console.error(`  ${violation.source} -> ${violation.target} [${violation.rule}]`);
    }
  }
  if (orphans.length) {
    failed = true;
    console.error('Production orphan modules:');
    for (const orphan of orphans) console.error(`  ${displayPath(orphan)}`);
  }
  if (reports.length) {
    console.log('');
    console.log(`Architecture rule reports (${reports.length}) — phase 1 report-only:`);
    const byRule = new Map();
    for (const report of reports) {
      if (!byRule.has(report.rule)) byRule.set(report.rule, []);
      byRule.get(report.rule).push(report);
    }
    for (const [rule, ruleReports_] of [...byRule.entries()].sort()) {
      console.log(`  ${rule} (${ruleReports_.length}):`);
      for (const report of ruleReports_) {
        console.log(`    ${report.source} -> ${report.target}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`Architecture check passed (${files.length} source modules, no cycles).`);
  return { reports };
}

if (isSelfTest) {
  const fixtureRoot = join(repoRoot, 'scripts', 'architecture-fixtures');
  const expected = JSON.parse(readFileSync(join(fixtureRoot, 'expected-reports.json'), 'utf8'));
  const scan = scanSourceTree(fixtureRoot);
  // The fixture tree has no workers or dangling modules by construction, so
  // only compare rule reports; hard domain violations stay asserted too.
  const actual = [...scan.hardViolations, ...scan.reports]
    .map((report) => ({ rule: report.rule, source: report.source, target: report.target }))
    .sort((left, right) =>
      `${left.rule}:${left.source}:${left.target}`.localeCompare(
        `${right.rule}:${right.source}:${right.target}`,
      ),
    );
  const wanted = [...expected].sort((left, right) =>
    `${left.rule}:${left.source}:${left.target}`.localeCompare(
      `${right.rule}:${right.source}:${right.target}`,
    ),
  );
  let mismatch = false;
  if (actual.length !== wanted.length) mismatch = true;
  for (let index = 0; index < Math.max(actual.length, wanted.length); index += 1) {
    const left = actual[index];
    const right = wanted[index];
    const same =
      left !== undefined &&
      right !== undefined &&
      left.rule === right.rule &&
      left.source === right.source &&
      left.target === right.target;
    if (!same) {
      mismatch = true;
      console.error(
        `fixture mismatch at ${index}: got ${JSON.stringify(left)} want ${JSON.stringify(right)}`,
      );
    }
  }
  if (scan.cycles.length || scan.orphans.length) {
    mismatch = true;
    console.error('fixture tree unexpectedly contains cycles or orphans');
  }
  if (mismatch) {
    process.exitCode = 1;
    console.error('Architecture checker self-test FAILED.');
  } else {
    console.log(
      `Architecture checker self-test passed (${wanted.length} expected reports matched exactly).`,
    );
  }
} else {
  const scan = scanSourceTree(repoRoot);
  printScan(scan);
  const rustReports = rustWorkspaceReports();
  if (rustReports.length) {
    process.exitCode = 1;
    console.error('');
    console.error(`Rust workspace boundary violations (${rustReports.length}):`);
    for (const report of rustReports) {
      console.error(`  ${report.rule}: ${report.source} -> ${report.target}`);
    }
  }
}
