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
            ],
            exclude: ['**/*.test.*', '**/*.spec.*', '**/types.ts', '**/*.d.ts'],
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, '.'),
        },
    },
});
