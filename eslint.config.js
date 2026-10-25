import globals from 'globals';
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'; // This exports a config object

export default [
  // Global ignores
  {
    ignores: [
      'dist/',
      'node_modules/',
      '**/*.config.js', // Ignores this file, vite.config.js, prettierrc.js etc.
      '**/*.config.ts', // Ignores vite.config.ts, vitest.config.ts etc.
      '.github/',
      '*.html', // HTML files are not linted by ESLint for JS/TS
    ],
  },

  // Base configuration for all JS/TS files
  {
    files: ['src/**/*.ts', 'src/**/*.js', '*.ts'], // Apply to .ts and .js files in src, and root .ts files like vite-plugin-component-manifest.ts
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      // 'prettier' plugin is part of eslintPluginPrettierRecommended
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      // ...tseslint.configs.stylistic.rules, // Optional: for more stylistic rules
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // Prettier configuration - should be last to override other formatting rules
  // eslintPluginPrettierRecommended already includes `eslint-config-prettier`
  // to turn off conflicting ESLint rules and adds `eslint-plugin-prettier`'s rules.
  {
    files: ['src/**/*.ts', 'src/**/*.js', '*.ts'], // Ensure Prettier rules also apply to these files
    ...eslintPluginPrettierRecommended, // Spread the recommended Prettier config
    rules: {
      ...eslintPluginPrettierRecommended.rules, // Make sure to include its rules
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          semi: true,
          trailingComma: 'es5',
          printWidth: 80,
          tabWidth: 2,
          endOfLine: 'lf',
        },
      ],
    },
  },
];
