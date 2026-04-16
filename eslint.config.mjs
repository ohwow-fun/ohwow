import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': ['error'],
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
    },
  },
  {
    files: ['src/tui/**', 'src/index.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'src/web/**',
      'node_modules/**',
      // Transient smoke artifacts emitted by the self-bench experiment
      // runner (also excluded from tsconfig in cd7d7fa). Files appear and
      // unlink within seconds; a lint glob racing them trips ENOENT.
      'src/self-bench/experiments/tmpl-smoke-*.ts',
      'src/self-bench/experiments/mig-smoke-*.ts',
      'src/self-bench/experiments/subprocess-smoke-*.ts',
    ],
  },
);
