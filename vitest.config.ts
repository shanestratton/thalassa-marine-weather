import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        // Keep ordinary tests tightly bounded. The handful of real-ENC routing
        // repros set measured, suite-local ceilings because V8 coverage
        // instrumentation makes their grid searches substantially slower; the
        // assertions themselves remain identical in covered and uncovered runs.
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
            // Preserve the coverage evidence when an unrelated test is red so
            // CI failures remain diagnosable instead of discarding the report.
            reportOnFailure: true,
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
                // Ratchet floor — raised 2026-08-03 to sit just below the
                // verified full-suite CI baseline (43.76/38.00/44.13/45.49,
                // runs 30789257756 + 30791179481; the old 25-floor had gone
                // 19pts stale after the safety-hook/parity/float-plan test
                // additions nearly doubled coverage).
                // These prevent regression. Raise as test coverage improves.
                // TARGET: 80% across the board.
                // Keyed carefully: the CI summary prints Statements/
                // Branches/Functions/Lines in THAT order — a transposed
                // floor (branches vs functions) red-flagged run 30793489231.
                lines: 44, // actual 45.49
                functions: 42.5, // actual 44.11
                branches: 36.5, // actual 38.00
                statements: 42, // actual 43.75
            },
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, '.'),
        },
    },
});
