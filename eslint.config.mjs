import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  prettier,
  {
    files: [
      'src/**/*.{ts,vue}',
      'src/**/__tests__/**/*.ts',
      'src/test/**/*.ts',
      'scripts/**/*.{ts,mjs}',
      '*.config.{ts,mjs}',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      'no-console': 'error',
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'vue/multi-word-component-names': 'off',
      'vue/define-macros-order': ['error', { order: ['defineProps', 'defineEmits'] }],
      'vue/no-unused-refs': 'error',
    },
  },
  {
    // Promise and discriminated-union handling are too error-prone for a
    // desktop app to leave to convention. Type-aware analysis applies to the
    // production TS and executable config; colocated tests keep the lighter
    // lint profile they had under tests/frontend/.
    files: ['src/**/*.ts', 'scripts/**/*.ts', '*.config.ts'],
    ignores: ['src/**/__tests__/**', 'src/test/**'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // The logger is the single sanctioned console surface in src/.
    files: ['src/lib/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**', 'src/test/**', 'scripts/**', '*.config.{ts,mjs}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'target/**',
      // Checker self-test fixtures are scanner inputs, not lint targets.
      'scripts/architecture-fixtures/**',
    ],
  },
];
