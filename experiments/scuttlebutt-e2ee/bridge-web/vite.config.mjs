import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// Isolated web assets only; no primary app config, .env files or cap:sync.
export default defineConfig({
    root,
    base: './',
    envDir: resolve(root, 'no-environment-files'),
    cacheDir: resolve(root, '.vite-cache'),
    server: { host: '127.0.0.1', port: 5188, strictPort: true },
    build: { outDir: resolve(root, 'dist'), emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
