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
            reporter: ['text', 'lcov'],
            include: ['services/**', 'hooks/**', 'components/ui/**'],
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, '.'),
        },
    },
});
