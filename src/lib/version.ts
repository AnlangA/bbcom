import pkg from '../../package.json';

/** Application version, sourced from package.json at build time. */
export const APP_VERSION: string = pkg.version;
