export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      !['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code) ||
      (!specifier.startsWith('.') && !specifier.startsWith('/')) ||
      specifier.endsWith('.ts')
    ) {
      throw error;
    }

    if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      return nextResolve(`${specifier}/index.ts`, context);
    }

    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      return nextResolve(`${specifier}/index.ts`, context);
    }
  }
}
