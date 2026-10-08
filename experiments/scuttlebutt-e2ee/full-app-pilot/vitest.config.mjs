import { createFullAppGraphIsolation } from './graphIsolation.mjs';
import { fileURLToPath } from 'node:url';
export default {
    cacheDir: fileURLToPath(new URL('./.vitest-cache', import.meta.url)),
    envDir: false,
    envPrefix: [],
    esbuild: { jsx: 'automatic' },
    define: {
        __APP_BUILD__: JSON.stringify('research'),
        __COMMIT_SHA__: JSON.stringify('isolated'),
        __BUILD_STAMP__: JSON.stringify('2026-10-09 00:00Z'),
    },
    plugins: [createFullAppGraphIsolation()],
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./experiments/scuttlebutt-e2ee/full-app-pilot/fixtureSetup.ts'],
        include: ['tests/E2eeFullAppMount.test.tsx'],
        maxWorkers: 1,
        fileParallelism: false,
        cache: false,
        testTimeout: 20000,
        hookTimeout: 20000,
    },
};
