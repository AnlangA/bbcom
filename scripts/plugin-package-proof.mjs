import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

const PLATFORM_LAYOUTS = Object.freeze({
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

const options = parseArguments(process.argv.slice(2));
const packageRoot = resolve(options.root);
const output = resolve(options.out);
const expectedSidecar = resolve(options['expected-sidecar']);
const platform = options.platform;
const target = options.target;
const commitSha = process.env.GITHUB_SHA ?? '';
const layout = PLATFORM_LAYOUTS[platform];

if (!layout) fail('platform must be windows, macos, or linux');
if (target !== layout.target) {
  fail(`target ${target} does not match the fixed ${platform} target ${layout.target}`);
}
if (!/^[a-f0-9]{40}$/.test(commitSha)) fail('GITHUB_SHA must bind evidence to the gated commit');

const canonicalRoot = realpathSync(packageRoot);
const packagedPath = resolve(canonicalRoot, ...layout.relativePath.split('/'));
assertContained(canonicalRoot, packagedPath, 'packaged sidecar');
assertPathHasNoSymlinks(canonicalRoot, layout.relativePath);

const packagedHostEntries = walk(canonicalRoot).filter(({ name }) =>
  name.startsWith('bbcom-plugin-host'),
);
if (
  packagedHostEntries.length !== 1 ||
  packagedHostEntries[0].name !== layout.basename ||
  packagedHostEntries[0].path !== packagedPath ||
  packagedHostEntries[0].isSymbolicLink
) {
  fail(`package must contain one regular ${layout.basename} at exactly ${layout.relativePath}`);
}

const packagedStat = lstatSync(packagedPath);
if (!packagedStat.isFile() || packagedStat.isSymbolicLink()) {
  fail('packaged sidecar must be a regular file, not a link');
}
if (basename(packagedPath) !== layout.basename) {
  fail(`packaged sidecar basename must be exactly ${layout.basename}`);
}
if (platform !== 'windows' && (packagedStat.mode & 0o100) === 0) {
  fail('Unix plugin host sidecar must be owner-executable');
}
if (platform !== 'windows' && (packagedStat.mode & 0o022) !== 0) {
  fail('Unix plugin host sidecar must not be group/world writable');
}

const expectedStat = lstatSync(expectedSidecar);
if (!expectedStat.isFile() || expectedStat.isSymbolicLink()) {
  fail('expected build sidecar must be a regular file, not a link');
}
if (basename(expectedSidecar) !== layout.basename) {
  fail(`expected build sidecar basename must be exactly ${layout.basename}`);
}

const packagedBytes = readFileSync(packagedPath);
const expectedBytes = readFileSync(expectedSidecar);
const packagedIdentity = executableIdentity(packagedBytes);
const expectedIdentity = executableIdentity(expectedBytes);
if (
  packagedIdentity.format !== layout.format ||
  packagedIdentity.architecture !== layout.architecture ||
  expectedIdentity.format !== layout.format ||
  expectedIdentity.architecture !== layout.architecture
) {
  fail(
    `expected ${layout.format}/${layout.architecture} sidecars, got package=${packagedIdentity.format}/${packagedIdentity.architecture} build=${expectedIdentity.format}/${expectedIdentity.architecture}`,
  );
}

const packagedSha256 = sha256(packagedBytes);
const expectedSha256 = sha256(expectedBytes);
if (packagedSha256 !== expectedSha256 || packagedBytes.length !== expectedBytes.length) {
  fail('packaged sidecar does not byte-match the sidecar produced by this build');
}

const relativeSidecar = relative(canonicalRoot, realpathSync(packagedPath)).split(sep).join('/');
if (relativeSidecar !== layout.relativePath) {
  fail(`packaged sidecar resolved to unexpected path ${relativeSidecar}`);
}

const evidence = {
  schemaVersion: 2,
  evidenceKind: 'bbcom-installed-plugin-sidecar',
  evidenceScope: 'packaging-integrity-only',
  marketReady: false,
  commitSha,
  platform,
  target,
  installedRootKind: 'extracted-or-installed-native-package',
  sidecar: {
    relativePath: relativeSidecar,
    basename: layout.basename,
    format: packagedIdentity.format,
    architecture: packagedIdentity.architecture,
    bytes: packagedBytes.length,
    sha256: packagedSha256,
    unixExecutable: platform === 'windows' ? null : true,
    expectedBuild: {
      basename: basename(expectedSidecar),
      format: expectedIdentity.format,
      architecture: expectedIdentity.architecture,
      bytes: expectedBytes.length,
      sha256: expectedSha256,
    },
  },
};
if (evidence.sidecar.bytes === 0) fail('plugin host sidecar is empty');
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });

function assertContained(root, path, label) {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    fail(`${label} escaped the installed package root`);
  }
}

function assertPathHasNoSymlinks(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      fail(`packaged sidecar path contains a symbolic link at ${segment}`);
    }
  }
}

function walk(root) {
  const entries = [];
  for (const directoryEntry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, directoryEntry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push({ name: directoryEntry.name, path, isSymbolicLink: true });
    } else if (stat.isDirectory()) {
      entries.push(...walk(path));
    } else {
      entries.push({ name: directoryEntry.name, path, isSymbolicLink: false });
    }
  }
  return entries;
}

function executableIdentity(bytes) {
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const isElf64LittleEndian = bytes[4] === 2 && bytes[5] === 1;
    return {
      format: 'elf',
      architecture: isElf64LittleEndian && bytes.readUInt16LE(18) === 0x003e ? 'x86_64' : 'unknown',
    };
  }

  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset >= 0x40 &&
      peOffset <= bytes.length - 6 &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
    ) {
      return {
        format: 'pe',
        architecture: bytes.readUInt16LE(peOffset + 4) === 0x8664 ? 'x86_64' : 'unknown',
      };
    }
  }

  if (bytes.length >= 8) {
    const magic = bytes.subarray(0, 4).toString('hex');
    if (magic === 'cffaedfe') {
      return {
        format: 'mach-o',
        architecture: bytes.readUInt32LE(4) === 0x0100000c ? 'arm64' : 'unknown',
      };
    }
    if (
      new Set([
        'feedface',
        'cefaedfe',
        'feedfacf',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ]).has(magic)
    ) {
      return { format: 'mach-o', architecture: 'unknown' };
    }
  }

  return { format: 'unknown', architecture: 'unknown' };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) fail('arguments must be --name value pairs');
    const key = name.slice(2);
    if (Object.hasOwn(parsed, key)) fail(`--${key} may be provided only once`);
    parsed[key] = value;
  }
  for (const required of ['root', 'out', 'platform', 'target', 'expected-sidecar']) {
    if (!parsed[required]) fail(`--${required} is required`);
  }
  return parsed;
}

function fail(message) {
  throw new Error(`plugin package proof failed: ${message}`);
}
