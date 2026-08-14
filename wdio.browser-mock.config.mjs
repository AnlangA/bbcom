/**
 * Fast PR smoke suite. The Tauri service runs the real renderer in Chrome and
 * intercepts Tauri IPC, so no Rust binary or platform WebDriver is needed.
 * The Vite server is deliberately started by CI (and by the developer) rather
 * than hidden in this config, which keeps process lifetime explicit.
 */
export const config = {
  runner: 'local',
  specs: ['./tests/e2e/browser/**/*.e2e.mjs'],
  maxInstances: 1,
  logLevel: 'warn',
  baseUrl: 'http://127.0.0.1:5173',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 30_000,
  connectionRetryCount: 1,
  services: [
    [
      '@wdio/tauri-service',
      {
        mode: 'browser',
        devServerUrl: 'http://127.0.0.1:5173',
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      ...(process.env.CHROME_PATH
        ? { 'goog:chromeOptions': { binary: process.env.CHROME_PATH } }
        : {}),
      ...(process.env.CHROMEDRIVER_PATH
        ? { 'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_PATH } }
        : {}),
    },
  ],
  framework: 'jasmine',
  reporters: ['spec'],
  jasmineOpts: {
    defaultTimeoutInterval: 30_000,
  },
};
