import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      globals: {
        // Browser globals
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        history: 'readonly',
        location: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Promise: 'readonly',
        // Chrome extension globals
        chrome: 'readonly',
      },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'docs/',
    ],
  },
];
