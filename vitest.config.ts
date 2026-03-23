import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
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
                // Ratchet floor — just below current baseline.
                // These prevent regression. Raise as test coverage improves.
                // TARGET: 80% across the board.
                lines: 13, // current: 13.79%
                functions: 12, // current: 12.90%
                branches: 10, // current: 10.09%
                statements: 13, // current: 13.48%
            },
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, '.'),
        },
    },
});
