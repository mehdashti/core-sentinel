// SPDX-License-Identifier: GPL-2.0-or-later
import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    global: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    globalThis: 'readonly',
};

export default [
    {ignores: ['node_modules/', 'dist/']},
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: gjsGlobals},
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
        },
    },
];
