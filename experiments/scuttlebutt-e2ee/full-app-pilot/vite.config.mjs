import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createFullAppGraphIsolation } from './graphIsolation.mjs';
import { createFullAppBrandAssetPlugin } from './brandAsset.mjs';
const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    root,
    base: './',
    publicDir: false,
    envDir: false,
    envPrefix: [],
    cacheDir: resolve(root, '.vite-cache'),
    esbuild: { jsx: 'automatic' },
    define: {
        __APP_BUILD__: JSON.stringify('research'),
        __COMMIT_SHA__: JSON.stringify('isolated'),
        __BUILD_STAMP__: JSON.stringify('2026-10-09 00:00Z'),
    },
    plugins: [createFullAppGraphIsolation(), createFullAppBrandAssetPlugin()],
    worker: {
        format: 'es',
        plugins: () => [createFullAppGraphIsolation()],
    },
    build: { outDir: resolve(root, 'dist'), emptyOutDir: false, sourcemap: false, target: 'es2022' },
});
