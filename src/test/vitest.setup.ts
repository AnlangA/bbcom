import { afterEach, beforeEach } from 'vitest';
import { resetSettingsServiceForTests } from '@/features/settings/settings-service-instance.ts';

let originalConsoleError: typeof console.error;
let originalConsoleWarn: typeof console.warn;
let unexpectedConsoleError: unknown[][] = [];
let lifecycleWarnings: unknown[][] = [];

beforeEach(() => {
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;
  unexpectedConsoleError = [];
  lifecycleWarnings = [];
  // Stores hydrate from the process-wide settings service; drop its cached
  // document so each test sees its own freshly installed storage mock.
  resetSettingsServiceForTests();

  // Tests that intentionally exercise the logger replace these functions and
  // restore them before their assertion. All other console errors are product
  // failures, not harmless test output.
  console.error = (...args: unknown[]) => {
    unexpectedConsoleError.push(args);
  };
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[Vue warn]')) {
      lifecycleWarnings.push(args);
      return;
    }
    originalConsoleWarn(...args);
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  if (lifecycleWarnings.length > 0) {
    throw new Error(`unexpected Vue lifecycle warning: ${String(lifecycleWarnings[0]?.[0])}`);
  }
  if (unexpectedConsoleError.length > 0) {
    throw new Error(`unexpected console.error: ${String(unexpectedConsoleError[0]?.[0])}`);
  }
});
