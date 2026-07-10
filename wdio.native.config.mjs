/**
 * Native nightly smoke suite. CI supplies BBCOM_E2E_BINARY after building the
 * platform target; the external provider keeps Tauri's test driver separate
 * from the shipping application binary.
 */
const application = process.env.BBCOM_E2E_BINARY;
if (!application) throw new Error('BBCOM_E2E_BINARY must point to the built bbcom executable');

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/native/**/*.e2e.mjs'],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 1,
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: application,
        driverProvider: 'external',
        autoInstallTauriDriver: true,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application },
    },
  ],
  framework: 'jasmine',
  reporters: ['spec'],
  jasmineOpts: {
    defaultTimeoutInterval: 90_000,
  },
};
