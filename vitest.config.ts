import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        // Heavy real-ENC routing repros (e.g. newportPinkenba) take ~2.5s solo
        // but can blow the 5s default under full-suite parallel CPU contention,
        // surfacing as an intermittent STACK_TRACE_ERROR. A generous ceiling
        // (it's a cap, not a delay — fast tests still finish fast) removes the
        // timeout flake without weakening any assertion.
        testTimeout: 20000,
        hookTimeout: 20000,
        include: [
            'tests/**/*.test.ts',
            'tests/**/*.test.tsx',
            'services/**/*.test.ts',
            'components/**/*.test.tsx',
            'components/**/*.test.ts',
            'utils/**/*.test.ts',
            'hooks/**/*.test.ts',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'lcov'],
            include: [
                'services/**/*.ts',
                'hooks/**/*.ts',
                'components/**/*.ts',
                'components/**/*.tsx',
                'utils/**/*.ts',
                'context/**/*.ts',
                'context/**/*.tsx',
                'modules/**/*.ts',
                'managers/**/*.ts',
                'stores/**/*.ts',
                'data/**/*.ts',
            ],
            exclude: ['**/*.test.*', '**/*.spec.*', '**/types.ts', '**/*.d.ts'],
            thresholds: {
                // Ratchet floor — raised from 13/12/10/13 baseline.
                // These prevent regression. Raise as test coverage improves.
                // TARGET: 80% across the board.
                lines: 15,
                functions: 15,
                branches: 12,
                statements: 15,
            },
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, '.'),
        },
    },
});
