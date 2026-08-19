import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) fail('evidence directory argument is required');

const expected = Object.freeze({
  windows: Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    relativePath: 'bbcom-plugin-host.exe',
    basename: 'bbcom-plugin-host.exe',
    format: 'pe',
    architecture: 'x86_64',
  }),
  macos: Object.freeze({
    target: 'aarch64-apple-darwin',
    relativePath: 'bbcom.app/Contents/MacOS/bbcom-plugin-host',
    basename: 'bbcom-plugin-host',
    format: 'mach-o',
    architecture: 'arm64',
  }),
  linux: Object.freeze({
    target: 'x86_64-unknown-linux-gnu',
    relativePath: 'usr/bin/bbcom-plugin-host',
    basename: 'bbcom-plugin-host',
    format: 'elf',
    architecture: 'x86_64',
  }),
});
const platformOnly = parsePlatformOnly(process.argv.slice(3));
const commitSha = process.env.GITHUB_SHA ?? '';
if (!/^[a-f0-9]{40}$/.test(commitSha)) fail('GITHUB_SHA is unavailable or malformed');

const allExpectedFiles = new Set(
  Object.keys(expected).flatMap((platform) => [
    `plugin-g45-${platform}.json`,
    `plugin-g45-sandbox-${platform}.json`,
    `plugin-g45-host-${platform}.json`,
    `plugin-g46-runtime-${platform}.json`,
  ]),
);
const jsonFiles = readdirSync(evidenceRoot)
  .filter((name) => name.endsWith('.json'))
  .sort();
if (jsonFiles.some((name) => !allExpectedFiles.has(name))) {
  fail('evidence directory contains an unexpected JSON file');
}

const requiredFiles = platformOnly
  ? new Set([
      `plugin-g45-${platformOnly}.json`,
      `plugin-g45-sandbox-${platformOnly}.json`,
      `plugin-g45-host-${platformOnly}.json`,
    ])
  : allExpectedFiles;
if (
  [...requiredFiles].some((name) => !jsonFiles.includes(name)) ||
  (!platformOnly && jsonFiles.length !== allExpectedFiles.size)
) {
  fail(`evidence set must contain: ${[...requiredFiles].sort().join(', ')}`);
}

const platforms = platformOnly
  ? [[platformOnly, expected[platformOnly]]]
  : Object.entries(expected);
for (const [platform, layout] of platforms) {
  const packageEvidence = readJson(`plugin-g45-${platform}.json`);
  validatePackageEvidence(packageEvidence, platform, layout);

  const sandboxEvidence = readJson(`plugin-g45-sandbox-${platform}.json`);
  validateSandboxEvidence(sandboxEvidence, platform, layout);

  const hostEvidence = readJson(`plugin-g45-host-${platform}.json`);
  validateHostEvidence(hostEvidence, packageEvidence, platform, layout);

  if (!platformOnly) {
    const runtimeEvidence = readJson(`plugin-g46-runtime-${platform}.json`);
    validateRuntimeEvidence(runtimeEvidence, packageEvidence, platform, layout);
  }
}

function validateSandboxEvidence(item, platform, layout) {
  const requiredControls = [
    'child-process-denied',
    'crash-observed',
    'filesystem-confined',
    'hang-terminated',
    'memory-limit-enforced',
    'network-denied',
  ];
  const observations = item?.observations;
  if (
    item?.schemaVersion !== 1 ||
    item?.evidenceKind !== 'bbcom-native-plugin-sandbox-self-test' ||
    item?.probeProtocol !== 'bbcom-plugin-sandbox-g45/v1' ||
    item?.evidenceScope !== 'native-sandbox-self-test-not-component-attempt' ||
    item?.execution !== 'native-adversarial-process' ||
    item?.commitSha !== commitSha ||
    item?.platform !== platform ||
    item?.target !== layout.target ||
    item?.marketReady !== false ||
    !Array.isArray(item?.controls) ||
    JSON.stringify(item.controls) !== JSON.stringify(requiredControls) ||
    observations?.blocksNetwork !== true ||
    observations?.blocksChildProcesses !== true ||
    observations?.restrictsFilesystem !== true ||
    observations?.enforcesMemoryLimit !== true ||
    observations?.observesCrashedProcess !== true ||
    observations?.terminatesHungProcess !== true
  ) {
    fail(`${platform} native sandbox evidence is malformed, incomplete or mis-correlated`);
  }
}

function validatePackageEvidence(item, platform, layout) {
  const sidecar = item?.sidecar;
  const expectedBuild = sidecar?.expectedBuild;
  if (
    item?.schemaVersion !== 2 ||
    item?.evidenceKind !== 'bbcom-installed-plugin-sidecar' ||
    item?.evidenceScope !== 'packaging-integrity-only' ||
    item?.marketReady !== false ||
    item?.commitSha !== commitSha ||
    item?.platform !== platform ||
    item?.target !== layout.target ||
    item?.installedRootKind !== 'extracted-or-installed-native-package' ||
    sidecar?.relativePath !== layout.relativePath ||
    sidecar?.basename !== layout.basename ||
    sidecar?.format !== layout.format ||
    sidecar?.architecture !== layout.architecture ||
    !Number.isSafeInteger(sidecar?.bytes) ||
    sidecar.bytes <= 0 ||
    !isSha256(sidecar?.sha256) ||
    expectedBuild?.basename !== layout.basename ||
    expectedBuild?.format !== layout.format ||
    expectedBuild?.architecture !== layout.architecture ||
    expectedBuild?.bytes !== sidecar.bytes ||
    expectedBuild?.sha256 !== sidecar.sha256 ||
    (platform === 'windows' ? sidecar?.unixExecutable !== null : sidecar?.unixExecutable !== true)
  ) {
    fail(`${platform} installed-package proof is malformed or not bound to its build sidecar`);
  }
}

function validateHostEvidence(item, packageEvidence, platform, layout) {
  const fixtureRoot = 'tests/fixtures/plugins/malicious';
  const fixtureFiles = Object.freeze([
    ['primary', 'g45-malicious.component.wasm'],
    ['ambient', 'g45-ambient-import.component.wat'],
    ['trap', 'g45-trap.component.wat'],
    ['runaway', 'g45-runaway.component.wat'],
    ['memory', 'g45-memory.component.wat'],
  ]);
  const suite = createHash('sha256');
  const expectedArtifacts = fixtureFiles.map(([name, sourceFile]) => {
    const source = readFileSync(resolve(workspaceRoot, fixtureRoot, sourceFile));
    suite.update(littleEndianU64(Buffer.byteLength(name)));
    suite.update(name);
    suite.update(littleEndianU64(source.length));
    suite.update(source);
    return Object.freeze({
      name,
      sourceFile,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
    });
  });
  const fixtureSha256 = suite.digest('hex');
  const requiredControls = [
    'component-instantiated',
    'component-memory-limit-enforced',
    'component-unlinked-wasi-rejected',
    'component-runaway-bounded',
    'component-trap-observed',
    'oversized-ipc-rejected',
  ];
  const artifacts = item?.fixture?.artifacts;
  const selfTest = item?.platformSelfTest;
  const classifications = item?.classifications;
  const expectedClassificationKeys = ['ambient', 'memory', 'runaway', 'trap'];
  const expectedLimitations = [
    'v2 Component links no WASI, socket, process, filesystem, device, environment, WebView, DOM or Tauri import',
    'native sandbox observations are not relabelled as Component resource attempts',
    'this probe never self-authorizes market release; only the aggregate G45/G46 gate may promote evidence',
  ];
  if (
    item?.schemaVersion !== 1 ||
    item?.evidenceKind !== 'bbcom-packaged-host-malicious-component' ||
    item?.probeProtocol !== 'bbcom-plugin-host-g45/v2' ||
    item?.commitSha !== commitSha ||
    item?.platform !== platform ||
    item?.target !== layout.target ||
    item?.execution !== 'real-wasm-component' ||
    item?.hostExecutable !== 'packaged-bbcom-plugin-host' ||
    item?.marketReady !== false ||
    item?.fixture?.componentPackage !== 'bbcom:g45-malicious-fixture@2.0.0' ||
    item?.fixture?.sha256 !== fixtureSha256 ||
    item?.fixture?.digestAlgorithm !== 'sha256(length-prefixed-name-and-source-v2)' ||
    !Array.isArray(artifacts) ||
    artifacts.length !== expectedArtifacts.length ||
    artifacts.some((artifact, index) => {
      const expectedArtifact = expectedArtifacts[index];
      return (
        artifact?.name !== expectedArtifact.name ||
        artifact?.sourceFile !== expectedArtifact.sourceFile ||
        artifact?.sourceSha256 !== expectedArtifact.sourceSha256 ||
        !isSha256(artifact?.compiledSha256)
      );
    }) ||
    item?.sidecar?.relativePath !== layout.relativePath ||
    item?.sidecar?.format !== layout.format ||
    item?.sidecar?.bytes !== packageEvidence.sidecar.bytes ||
    item?.sidecar?.sha256 !== packageEvidence.sidecar.sha256 ||
    !Array.isArray(item?.controls) ||
    JSON.stringify(item.controls) !== JSON.stringify(requiredControls) ||
    JSON.stringify(Object.keys(classifications ?? {}).sort()) !==
      JSON.stringify(expectedClassificationKeys) ||
    classifications?.ambient !== 'PLUGIN_COMPONENT_INVALID' ||
    classifications?.trap !== 'PLUGIN_TRAP' ||
    !['PLUGIN_FUEL_EXHAUSTED', 'PLUGIN_TIMEOUT'].includes(classifications?.runaway) ||
    classifications?.memory !== 'PLUGIN_MEMORY_LIMIT' ||
    selfTest?.evidenceScope !== 'not-executed-by-component-probe' ||
    selfTest?.requiredEvidence !== 'separate-native-platform-sandbox-self-test' ||
    !Array.isArray(item?.limitations) ||
    JSON.stringify(item.limitations) !== JSON.stringify(expectedLimitations)
  ) {
    fail(
      `${platform} G45 proof did not execute the packaged host with the reviewed malicious Component`,
    );
  }
}

function littleEndianU64(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('fixture length is invalid');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function validateRuntimeEvidence(item, packageEvidence, platform, layout) {
  const runtime = item?.runtime;
  if (
    item?.schemaVersion !== 1 ||
    item?.evidenceKind !== 'bbcom-production-plugin-runtime' ||
    item?.probeProtocol !== 'bbcom-plugin-market-readiness/v1' ||
    item?.commitSha !== commitSha ||
    item?.platform !== platform ||
    item?.target !== layout.target ||
    item?.sidecar?.relativePath !== layout.relativePath ||
    item?.sidecar?.format !== layout.format ||
    item?.sidecar?.bytes !== packageEvidence.sidecar.bytes ||
    item?.sidecar?.sha256 !== packageEvidence.sidecar.sha256 ||
    runtime?.commandService !== 'native-production' ||
    runtime?.lifecycleMonitor !== 'active' ||
    runtime?.hostLauncher !== 'packaged-sidecar' ||
    runtime?.openProjectBehavior !== 'stopped' ||
    runtime?.marketReleaseGate !== 'explicit'
  ) {
    fail(
      `${platform} runtime proof did not attest the packaged production graph and fail-safe startup`,
    );
  }
}

function readJson(name) {
  try {
    return JSON.parse(readFileSync(resolve(evidenceRoot, name), 'utf8'));
  } catch (error) {
    fail(`${name} is not readable canonical JSON: ${String(error)}`);
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parsePlatformOnly(args) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--platform' || !Object.hasOwn(expected, args[1])) {
    fail('optional arguments must be --platform windows|macos|linux');
  }
  return args[1];
}

function fail(message) {
  throw new Error(`plugin market readiness failed: ${message}`);
}
