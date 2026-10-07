import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const root = dirname(fileURLToPath(import.meta.url));
const denied = '\0thalassa-private-pilot-legacy-denied';
const forbidden =
    /\/(?:services\/(?:ChatService|GuardianService|PushNotificationService|supabase)\.(?:ts|tsx)|stores\/authStore\.(?:ts|tsx)|components\/LegacyChatPage\.tsx)(?:\?|$)/;
export default defineConfig({
    root,
    base: './',
    envDir: resolve(root, 'no-environment-files'),
    cacheDir: resolve(root, '.vite-cache'),
    esbuild: { jsx: 'automatic' },
    plugins: [
        {
            name: 'closed-private-research-graph',
            enforce: 'pre',
            resolveId(source, importer) {
                if (source === './LegacyChatPage' && importer?.endsWith('/components/ChatPage.tsx')) return denied;
                return null;
            },
            load(id) {
                if (id === denied)
                    return "export function LegacyChatPage(){throw new Error('Legacy private messaging is unavailable.')}";
                if (forbidden.test(id))
                    throw new Error('Production service imported into private-message research graph');
                return null;
            },
        },
    ],
    build: { outDir: resolve(root, 'dist'), emptyOutDir: false, sourcemap: false, target: 'es2022' },
});
