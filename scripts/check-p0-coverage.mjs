#!/usr/bin/env node

/**
 * Strict coverage contract for the v0.5.0 P0 frontend data paths.
 *
 * The V8 provider emits Istanbul's `coverage-final.json` format. This script
 * deliberately reads that artifact directly rather than relying on mutable
 * CLI flags: every required module is listed below, a missing module fails,
 * and each domain must independently meet the fixed line/branch thresholds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_COVERAGE_FILE = resolve(ROOT, 'coverage/frontend/coverage-final.json');
const LINE_THRESHOLD = 95;
const BRANCH_THRESHOLD = 90;

/**
 * P0 domains are intentionally enumerated instead of matched with globs.
 * A new implementation file must be consciously added here, which prevents a
 * rename or a source-map omission from weakening this gate.
 */
const P0_DOMAINS = Object.freeze({
  parser: ['src/lib/protocol-parser.ts', 'src/lib/parser-frame-collector.ts'],
  'session-runtime': [
    'src/features/application/application-runtime-registry.ts',
    'src/features/serial/application/async-send-loop.ts',
    'src/features/serial/application/serial-connection-controller.ts',
    'src/features/serial/infrastructure/tauri-serial-port.ts',
    'src/features/sessions/runtime/session-runtime-controller.ts',
    'src/composables/useSerialConnection.ts',
    'src/composables/useSessionModbus.ts',
    'src/composables/useTriggers.ts',
    'src/composables/useModbusMaster.ts',
    'src/lib/modbus/modbus-transaction-runner.ts',
    'src/lib/serial-rx-queue.ts',
    'src/lib/serial-rx-scheduler.ts',
    'src/lib/trigger-engine.ts',
  ],
  'write-scheduler': ['src/lib/serial-write-scheduler.ts'],
  'export-logging': [
    'src/composables/useAutoLog.ts',
    'src/composables/useExport.ts',
    'src/lib/export-filters.ts',
    'src/features/native/tauri-ipc.ts',
  ],
  'ai-security': [
    'src/lib/ai-error.ts',
    'src/features/settings/tauri-ai-key.ts',
    'src/lib/ai-log-context.ts',
    'src/lib/ai-models.ts',
    'src/features/native/tauri-ipc.ts',
  ],
  persistence: [
    'src/lib/session-persistence.ts',
    'src/lib/session-state-database.ts',
    'src/lib/session-store-helpers.ts',
    'src/lib/storage.ts',
    'src/features/sessions/persistence/session-mutation-revision-tracker.ts',
    'src/features/sessions/session-application-service.ts',
    'src/stores/session-core.ts',
  ],
});

function normalizePath(path) {
  return resolve(path).replaceAll('\\', '/');
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return value === 1 ? singular : pluralForm;
}

function percent(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function readCoverage(coverageFile) {
  if (!existsSync(coverageFile)) {
    throw new Error(`Coverage artifact is missing: ${coverageFile}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(coverageFile, 'utf8'));
  } catch (error) {
    throw new Error(`Coverage artifact is not valid JSON: ${coverageFile}`, { cause: error });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Coverage artifact has an invalid top-level shape: ${coverageFile}`);
  }

  return new Map(
    Object.entries(parsed).map(([path, fileCoverage]) => [normalizePath(path), fileCoverage]),
  );
}

/**
 * Istanbul computes a line as covered when any statement beginning on that
 * line was hit. Reproduce that definition exactly so this domain aggregate
 * cannot diverge from its json/html coverage reports.
 */
function lineCounts(fileCoverage) {
  const lineHits = new Map();
  const statementMap = fileCoverage?.statementMap;
  const statementHits = fileCoverage?.s;

  if (!statementMap || !statementHits) return null;

  for (const [id, location] of Object.entries(statementMap)) {
    const line = location?.start?.line;
    const hits = statementHits[id];
    if (!Number.isInteger(line) || typeof hits !== 'number') return null;
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
  }

  return {
    covered: [...lineHits.values()].filter((hits) => hits > 0).length,
    total: lineHits.size,
  };
}

function branchCounts(fileCoverage) {
  const branchMap = fileCoverage?.branchMap;
  const branchHits = fileCoverage?.b;
  if (!branchMap || !branchHits) return null;

  let covered = 0;
  let total = 0;
  for (const id of Object.keys(branchMap)) {
    const hits = branchHits[id];
    if (!Array.isArray(hits)) return null;
    total += hits.length;
    covered += hits.filter((count) => typeof count === 'number' && count > 0).length;
  }

  return { covered, total };
}

function emptyCounts() {
  return { covered: 0, total: 0 };
}

function addCounts(total, next) {
  total.covered += next.covered;
  total.total += next.total;
}

function relative(path) {
  return path.slice(ROOT.length + 1).replaceAll('\\', '/');
}

function checkDomain(name, targets, coverageByFile) {
  const lines = emptyCounts();
  const branches = emptyCounts();
  const missing = [];
  const invalid = [];

  for (const target of targets) {
    const absolutePath = normalizePath(resolve(ROOT, target));
    const fileCoverage = coverageByFile.get(absolutePath);
    if (!fileCoverage) {
      missing.push(target);
      continue;
    }

    const fileLines = lineCounts(fileCoverage);
    const fileBranches = branchCounts(fileCoverage);
    if (!fileLines || !fileBranches || fileLines.total === 0) {
      invalid.push(target);
      continue;
    }

    addCounts(lines, fileLines);
    addCounts(branches, fileBranches);
  }

  const linePercent = percent(lines.covered, lines.total);
  const branchPercent = percent(branches.covered, branches.total);
  const errors = [];

  if (missing.length > 0) {
    errors.push(`missing coverage for ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    errors.push(`invalid or non-instrumented coverage for ${invalid.join(', ')}`);
  }
  if (linePercent < LINE_THRESHOLD) {
    errors.push(
      `lines ${formatPercent(linePercent)} (${lines.covered}/${lines.total}) is below ${LINE_THRESHOLD}%`,
    );
  }
  if (branchPercent < BRANCH_THRESHOLD) {
    errors.push(
      `branches ${formatPercent(branchPercent)} (${branches.covered}/${branches.total}) is below ${BRANCH_THRESHOLD}%`,
    );
  }

  return { name, targets, lines, branches, linePercent, branchPercent, errors };
}

function main() {
  const coverageFile = normalizePath(process.argv[2] ?? DEFAULT_COVERAGE_FILE);
  const coverageByFile = readCoverage(coverageFile);
  const results = Object.entries(P0_DOMAINS).map(([name, targets]) =>
    checkDomain(name, targets, coverageByFile),
  );

  console.log(`P0 frontend coverage from ${relative(coverageFile)}`);
  for (const result of results) {
    console.log(
      `${result.errors.length === 0 ? 'PASS' : 'FAIL'} ${result.name}: ` +
        `lines ${formatPercent(result.linePercent)} (${result.lines.covered}/${result.lines.total}), ` +
        `branches ${formatPercent(result.branchPercent)} (${result.branches.covered}/${result.branches.total})`,
    );
    for (const error of result.errors) console.log(`  - ${error}`);
  }

  const failures = results.filter((result) => result.errors.length > 0);
  if (failures.length > 0) {
    console.log(
      `P0 coverage gate failed for ${failures.length} ${plural(failures.length, 'domain')}. ` +
        `Required: lines >= ${LINE_THRESHOLD}%, branches >= ${BRANCH_THRESHOLD}% per domain.`,
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
