/// <reference types="vitest" />
import path from 'path';
import http from 'http';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'url';

// Define __dirname for ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    // 1. Load env vars from local .env files
    const env = loadEnv(mode, __dirname, '');

    // 2. Helper to resolve keys from either local .env or system env (Vercel Build Context)
    // Vercel exposes environment variables in process.env during build.
    const getKey = (key: string) => {
        const val = env[key] || process.env[key];
        if (val) return val;
        return '';
    };

    return {
        server: {
            port: 3000,
            host: '0.0.0.0',
            proxy: {
                // Proxy Distance.tools API to avoid CORS (browser → Vite → API)
                '/api/distance-tools': {
                    target: 'https://api.distance.tools',
                    changeOrigin: true,
                    rewrite: (path: string) => path.replace(/^\/api\/distance-tools/, '/api/v2'),
                    headers: {
                        'X-Billing-Token': getKey('VITE_DISTANCE_TOOLS_KEY'),
                    },
                },
                // Proxy Rainbow.ai API to avoid CORS in local dev
                '/api/rainbow': {
                    target: 'https://api.rainbow.ai',
                    changeOrigin: true,
                    rewrite: (path: string) => path.replace(/^\/api\/rainbow/, '/tiles/v1'),
                },
                // Proxy NGA Maritime Safety Information (broadcast warnings / NTMs)
                '/api/nga-msi': {
                    target: 'https://msi.nga.mil',
                    changeOrigin: true,
                    rewrite: (path: string) => path.replace(/^\/api\/nga-msi/, '/api/publications'),
                },
                // Proxy CMEMS currents binaries from the rolling GitHub Release.
                // github.com release URLs 302 to objects.githubusercontent.com
                // which lacks CORS headers, so we proxy same-origin.
                // Path is `/api/currents` (not `/currents`) to match prod:
                // Vercel's Attack Challenge Mode 403s non-API paths but
                // exempts /api/*, so the client hits /api/currents directly
                // and skips the rewrite that used to live in vercel.json.
                '/api/currents': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/currents/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-currents-latest',
                        ),
                },
                // Same pattern for waves (sister pipeline, sister release).
                '/api/waves': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/waves/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-waves-latest',
                        ),
                },
                // SST (scalar temperature field packed into u-channel).
                '/api/sst': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/sst/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-sst-latest',
                        ),
                },
                // Proxy Signal K mock server (dev only) — avoids CORS for localhost:3100
                '/signalk': {
                    target: 'http://localhost:3100',
                    changeOrigin: true,
                },
                '/tiles': {
                    target: 'http://localhost:3100',
                    changeOrigin: true,
                },
            },
        },
        plugins: [
            // Dynamic CORS proxy for AvNav/SignalK chart servers on LAN
            // Handles: /__chart-proxy/{host}/{port}/path → http://{host}:{port}/path
            {
                name: 'chart-proxy',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                configureServer(server: any) {
                    server.middlewares.use('/__chart-proxy', (req: http.IncomingMessage, res: http.ServerResponse) => {
                        // req.url is the portion AFTER the middleware mount path
                        // e.g. /192.168.50.7/8080/tiles/11/1894/1185.png
                        const match = req.url?.match(/^\/([^/]+)\/(\d+)(\/.*)?$/);
                        if (!match) {
                            res.writeHead(400, { 'Content-Type': 'text/plain' });
                            res.end('Bad chart proxy URL');
                            return;
                        }
                        const [, targetHost, targetPort, targetPath] = match;
                        // Strip browser-specific headers that LAN servers reject
                        const cleanHeaders: Record<string, string | string[] | undefined> = {};
                        for (const [key, val] of Object.entries(req.headers)) {
                            if (
                                key === 'host' ||
                                key === 'origin' ||
                                key === 'referer' ||
                                key === 'cookie' ||
                                key.startsWith('sec-')
                            )
                                continue;
                            cleanHeaders[key] = val;
                        }
                        cleanHeaders['host'] = `${targetHost}:${targetPort}`;
                        const options: http.RequestOptions = {
                            hostname: targetHost,
                            port: Number(targetPort),
                            path: targetPath || '/',
                            method: req.method || 'GET',
                            headers: cleanHeaders,
                        };
                        const proxyReq = http.request(options, (proxyRes) => {
                            // Fix content-type: AvNav download handler sends application/octet-stream
                            // but Mapbox GL needs image/* to decode tiles
                            const contentType = targetPath?.match(/\.png(\?|$)/i)
                                ? 'image/png'
                                : targetPath?.match(/\.jpe?g(\?|$)/i)
                                  ? 'image/jpeg'
                                  : targetPath?.match(/\.webp(\?|$)/i)
                                    ? 'image/webp'
                                    : targetPath?.match(/\.pbf(\?|$)/i)
                                      ? 'application/x-protobuf'
                                      : proxyRes.headers['content-type'] || 'application/octet-stream';
                            const responseHeaders = {
                                ...proxyRes.headers,
                                'content-type': contentType,
                                'access-control-allow-origin': '*',
                                'access-control-allow-methods': 'GET, OPTIONS',
                            };
                            res.writeHead(proxyRes.statusCode || 502, responseHeaders);
                            proxyRes.pipe(res, { end: true });
                        });
                        proxyReq.on('error', (err) => {
                            console.error(
                                `[chart-proxy] Error → ${targetHost}:${targetPort}${targetPath}: ${err.message}`,
                            );
                            if (!res.headersSent) {
                                res.writeHead(502, { 'Content-Type': 'text/plain' });
                            }
                            res.end(`Chart proxy error: ${err.message}`);
                        });
                        req.pipe(proxyReq, { end: true });
                    });
                },
            },
            react(),
            mode === 'production' &&
                visualizer({
                    filename: 'bundle-stats.html',
                    gzipSize: true,
                    brotliSize: true,
                }),
        ].filter(Boolean),
        define: {
            // IMPORTANT: Do NOT set 'process.env': {} — this clobbers React's internal
            // process.env.NODE_ENV detection and causes hooks to fail in lazy-loaded chunks.
            // Instead, define individual keys only.
            'process.env.NODE_ENV': JSON.stringify(mode),

            // --- API KEY INJECTION ---
            // We inject these keys directly into the build so the client can use them.
            // This is required for Vercel static deployments where there is no runtime Node server.

            // 1. Gemini / Google GenAI
            'process.env.API_KEY': JSON.stringify(
                getKey('VITE_GEMINI_API_KEY') || getKey('GEMINI_API_KEY') || getKey('API_KEY') || '',
            ),
            'process.env.GEMINI_API_KEY': JSON.stringify(
                getKey('VITE_GEMINI_API_KEY') || getKey('GEMINI_API_KEY') || getKey('API_KEY') || '',
            ),

            // 2. Stormglass Marine Data
            'process.env.STORMGLASS_API_KEY': JSON.stringify(
                getKey('VITE_STORMGLASS_API_KEY') ||
                    getKey('STORMGLASS_API_KEY') ||
                    getKey('VITE_STORMGLASS_KEY') ||
                    getKey('STORMGLASS_KEY') ||
                    '',
            ),

            // 3. Open-Meteo (Optional Commercial Key)
            'process.env.OPEN_METEO_API_KEY': JSON.stringify(
                getKey('VITE_OPEN_METEO_API_KEY') || getKey('OPEN_METEO_API_KEY') || '',
            ),

            // 4. Mapbox / Maps
            'process.env.MAPBOX_ACCESS_TOKEN': JSON.stringify(
                getKey('VITE_MAPBOX_ACCESS_TOKEN') || getKey('MAPBOX_ACCESS_TOKEN') || '',
            ),

            // 5. Supabase (Backend/Auth)
            'process.env.SUPABASE_URL': JSON.stringify(getKey('VITE_SUPABASE_URL') || getKey('SUPABASE_URL') || ''),
            'process.env.SUPABASE_KEY': JSON.stringify(
                getKey('VITE_SUPABASE_ANON_KEY') || getKey('VITE_SUPABASE_KEY') || getKey('SUPABASE_KEY') || '',
            ),
        },
        // Strip console.*/debugger from production builds
        esbuild:
            mode === 'production'
                ? {
                      drop: ['console', 'debugger'],
                  }
                : undefined,
        build: {
            outDir: 'dist',
            sourcemap: mode !== 'production',
            cssMinify: true,
            chunkSizeWarningLimit: 750,
            rollupOptions: {
                onwarn(warning, warn) {
                    // Suppress "is dynamically imported by X but also statically imported by Y"
                    if (
                        warning.code === 'MIXED_IMPORTS' ||
                        warning.message?.includes('dynamic import will not move module')
                    )
                        return;
                    warn(warning);
                },
                output: {
                    manualChunks: {
                        'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
                        'vendor-leaflet': ['leaflet'],
                        'vendor-supabase': ['@supabase/supabase-js'],
                        'vendor-sentry': ['@sentry/react'],
                        'vendor-mapbox': ['mapbox-gl'],
                        'vendor-capacitor': [
                            '@capacitor/preferences',
                            '@capacitor/share',
                            '@capacitor/filesystem',
                            '@capacitor/app',
                        ],
                        'vendor-react': ['react', 'react-dom'],
                    },
                },
            },
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './'),
            },
        },
        test: {
            environment: 'jsdom',
            exclude: ['**/node_modules/**', '**/e2e/**'],
            globals: true,
        },
    };
});
