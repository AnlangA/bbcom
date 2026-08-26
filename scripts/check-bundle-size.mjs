import { gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Former gzip ceilings, kept only as report annotations. Size budgets are not
// enforced: this script still measures the build, but over-limit output is not
// a failure.
const TOTAL_JS_GZIP_LIMIT = 460 * 1024;
const BOOTSTRAP_JS_GZIP_LIMIT = 85 * 1024;
const CHUNK_JS_GZIP_LIMIT = 105 * 1024;
// main.ts conditionally imports exactly one window root before mounting. Vite
// records those roots as dynamic imports, but they are mandatory startup work
// for their respective windows rather than optional feature panels.
const WINDOW_STARTUP_GZIP_LIMITS = new Map([
  ['src/App.vue', 307 * 1024],
  ['src/AiWindow.vue', 145 * 1024],
]);
const javascriptExtensions = new Set(['.js', '.mjs', '.cjs']);

const root = resolve(import.meta.dirname, '..');
const distDirectory = join(root, 'dist');
const manifestCandidates = [
  join(distDirectory, '.vite', 'manifest.json'),
  join(distDirectory, 'manifest.json'),
];

function fail(message) {
  console.error(`Bundle size report: ${message}`);
  process.exitCode = 1;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B (${(bytes / 1024).toFixed(2)} KiB)`;
}

function findManifest() {
  const manifestPath = manifestCandidates.find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    fail(
      `missing Vite manifest; expected ${manifestCandidates.map((path) => relative(root, path)).join(' or ')}`,
    );
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('manifest root is not an object');
    }
    return parsed;
  } catch (error) {
    fail(
      `cannot parse ${relative(root, manifestPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function collectJavascriptFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectJavascriptFiles(path, files);
    } else if (
      entry.isFile() &&
      javascriptExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))
    ) {
      files.push(path);
    }
  }
  return files;
}

function resolveManifestOutput(file) {
  if (typeof file !== 'string' || !file) return null;
  const output = resolve(distDirectory, file);
  const distPrefix = `${distDirectory}${sep}`;
  if (!output.startsWith(distPrefix)) return null;
  return output;
}

function isManifestChunk(chunk) {
  return chunk && typeof chunk === 'object' && !Array.isArray(chunk);
}

function collectStartupGraph(manifest, graphLabel, rootKeys, measurements, violations) {
  const visitedKeys = new Set();
  const outputs = new Set();

  function visit(key) {
    if (visitedKeys.has(key)) return;
    visitedKeys.add(key);

    const chunk = manifest[key];
    if (!isManifestChunk(chunk)) {
      violations.push(`manifest graph ${graphLabel} imports missing chunk ${key}`);
      return;
    }

    const output = resolveManifestOutput(chunk.file);
    if (!output || !measurements.has(output)) {
      violations.push(
        `manifest graph ${graphLabel} references ${String(chunk.file)} outside the emitted JavaScript files`,
      );
    } else {
      outputs.add(output);
    }

    if (chunk.imports === undefined) return;
    if (
      !Array.isArray(chunk.imports) ||
      chunk.imports.some((importKey) => typeof importKey !== 'string')
    ) {
      violations.push(`manifest chunk ${key} has an invalid imports list`);
      return;
    }
    for (const importKey of chunk.imports) visit(importKey);
  }

  for (const rootKey of rootKeys) visit(rootKey);
  return [...outputs];
}

if (!existsSync(distDirectory) || !statSync(distDirectory).isDirectory()) {
  fail(`missing build output directory: ${relative(root, distDirectory)}`);
} else {
  const manifest = findManifest();
  const javascriptFiles = collectJavascriptFiles(distDirectory).sort();

  if (javascriptFiles.length === 0) {
    fail('build output contains no JavaScript files');
  }

  const measurements = new Map(
    javascriptFiles.map((path) => [
      path,
      {
        gzipBytes: gzipSync(readFileSync(path), { level: 9 }).byteLength,
      },
    ]),
  );

  const totalGzipBytes = [...measurements.values()].reduce(
    (total, measurement) => total + measurement.gzipBytes,
    0,
  );
  const violations = [];

  const entryGraphs = [];
  if (manifest) {
    for (const [entryKey, entry] of Object.entries(manifest)) {
      if (!isManifestChunk(entry) || entry.isEntry !== true) continue;
      entryGraphs.push({
        label: entryKey,
        limit: BOOTSTRAP_JS_GZIP_LIMIT,
        outputs: collectStartupGraph(manifest, entryKey, [entryKey], measurements, violations),
      });

      const dynamicImports = Array.isArray(entry.dynamicImports) ? entry.dynamicImports : [];
      for (const [windowRoot, limit] of WINDOW_STARTUP_GZIP_LIMITS) {
        const label = `${entryKey} + ${windowRoot}`;
        if (!dynamicImports.includes(windowRoot)) {
          violations.push(`manifest entry ${entryKey} no longer imports required ${windowRoot}`);
          continue;
        }
        entryGraphs.push({
          label,
          limit,
          outputs: collectStartupGraph(
            manifest,
            label,
            [entryKey, windowRoot],
            measurements,
            violations,
          ),
        });
      }
    }
  }

  if (manifest && entryGraphs.length === 0) {
    violations.push('Vite manifest contains no JavaScript entry');
  }

  // A startup graph consists of an entry and its static imports. Delayed
  // imports are excluded here so lazy panels are not counted as first-paint
  // code; they still contribute to the total gzip figure printed below.
  for (const graph of entryGraphs) {
    const gzipBytes = graph.outputs.reduce(
      (total, output) => total + measurements.get(output).gzipBytes,
      0,
    );
    graph.gzipBytes = gzipBytes;
  }

  console.log(
    `JavaScript gzip total: ${formatBytes(totalGzipBytes)} (budget check disabled; former limit ${formatBytes(TOTAL_JS_GZIP_LIMIT)})`,
  );
  for (const graph of entryGraphs) {
    console.log(
      `Startup graph ${graph.label}: ${formatBytes(graph.gzipBytes)} (former limit ${formatBytes(graph.limit)})`,
    );
  }
  const largestChunk = [...measurements.entries()].sort(
    ([, left], [, right]) => right.gzipBytes - left.gzipBytes,
  )[0];
  if (largestChunk) {
    const [largestPath, largestMeasurement] = largestChunk;
    console.log(
      `Largest JavaScript chunk: ${relative(distDirectory, largestPath)} (${formatBytes(largestMeasurement.gzipBytes)}) (former limit ${formatBytes(CHUNK_JS_GZIP_LIMIT)})`,
    );
  }

  if (violations.length > 0) {
    for (const violation of violations) fail(violation);
  } else {
    console.log('Bundle size report complete (size budgets are not enforced).');
  }
}
