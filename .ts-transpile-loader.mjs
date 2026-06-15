import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const ts = require('typescript');

export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code) ||
        (!specifier.startsWith('.') && !specifier.startsWith('/')) || specifier.endsWith('.ts')) throw error;
    if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return nextResolve(`${specifier}/index.ts`, context);
    try { return await nextResolve(`${specifier}.ts`, context); }
    catch { return nextResolve(`${specifier}/index.ts`, context); }
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file://') && url.endsWith('.ts')) {
    const src = await readFile(fileURLToPath(url), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler, sourceMap: false },
    }).outputText;
    return { format: 'module', shortCircuit: true, source: out };
  }
  return nextLoad(url, context);
}
