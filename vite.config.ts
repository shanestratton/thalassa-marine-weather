/// <reference types="vitest" />
import path from 'path';
import http from 'http';
import net from 'node:net';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'url';

// Define __dirname for ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isAllowedLanChartHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
    const ipVersion = net.isIP(normalized);
    if (ipVersion === 4) {
        const [a, b] = normalized.split('.').map(Number);
        return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    }
    if (ipVersion === 6) {
        return (
            normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe80:')
        );
    }
    return (
        normalized === 'localhost' ||
        (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/.test(normalized) && normalized.length <= 253)
    );
}

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
            // Localhost by default. LAN exposure is an explicit developer opt-in.
            host: getKey('VITE_DEV_HOST') || '127.0.0.1',
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
                // Chlorophyll (scalar, log-normalised into u-channel).
                '/api/chl': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/chl/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-chl-latest',
                        ),
                },
                // Sea ice concentration (scalar [0,1] direct into u-channel).
                '/api/seaice': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/seaice/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-seaice-latest',
                        ),
                },
                // Mixed-layer depth (scalar metres, log10-encoded into u-channel).
                '/api/mld': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/mld/,
                            '/shanestratton/thalassa-marine-weather/releases/download/cmems-mld-latest',
                        ),
                },
                // Xweather proxy removed 2026-04-22 with the Xweather
                // decommission. Lightning moved to Blitzortung WebSocket
                // (no proxy needed, browser-direct WSS). Squall awaiting
                // NOAA replacement.
                // Marine Protected Areas (CAPAD GeoJSON polygons).
                '/api/mpa': {
                    target: 'https://github.com',
                    changeOrigin: true,
                    followRedirects: true,
                    rewrite: (path: string) =>
                        path.replace(
                            /^\/api\/mpa/,
                            '/shanestratton/thalassa-marine-weather/releases/download/mpa-aus-latest',
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
            // Dev-only mirror of the Vercel rewrite /logs/<handle> → logs.html
            // (vercel.json + middleware.ts own this in prod). Without it the
            // public Voyage Log page can't be exercised locally at all —
            // /logs/serene-summer 404s and logs.html parses an empty handle.
            {
                name: 'logs-html-rewrite',
                configureServer(server: any) {
                    server.middlewares.use((req: http.IncomingMessage, _res: http.ServerResponse, next: () => void) => {
                        if (req.url?.startsWith('/logs/')) req.url = '/logs.html';
                        next();
                    });
                },
            },
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
                        let decodedHost: string;
                        try {
                            decodedHost = decodeURIComponent(targetHost);
                        } catch {
                            res.writeHead(400, { 'Content-Type': 'text/plain' });
                            res.end('Malformed chart proxy host');
                            return;
                        }
                        const port = Number(targetPort);
                        if (
                            !isAllowedLanChartHost(decodedHost) ||
                            !Number.isInteger(port) ||
                            port < 1 ||
                            port > 65535
                        ) {
                            res.writeHead(403, { 'Content-Type': 'text/plain' });
                            res.end('Chart proxy target is not an allowed LAN host');
                            return;
                        }
                        if (req.method === 'OPTIONS') {
                            res.writeHead(204, {
                                'Access-Control-Allow-Origin': '*',
                                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                            });
                            res.end();
                            return;
                        }
                        if (req.method !== 'GET' && req.method !== 'HEAD') {
                            res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain' });
                            res.end('Method not allowed');
                            return;
                        }
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
                        cleanHeaders['host'] = `${decodedHost}:${port}`;
                        const options: http.RequestOptions = {
                            hostname: decodedHost,
                            port,
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
                            console.error(`[chart-proxy] Error → ${decodedHost}:${port}${targetPath}: ${err.message}`);
                            if (!res.headersSent) {
                                res.writeHead(502, { 'Content-Type': 'text/plain' });
                            }
                            res.end(`Chart proxy error: ${err.message}`);
                        });
                        proxyReq.end();
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

            // Paid provider secrets never enter the browser bundle. All three
            // providers are accessed through authenticated, rate-limited relays.
            'process.env.API_KEY': JSON.stringify(''),
            'process.env.GEMINI_API_KEY': JSON.stringify(''),
            'process.env.STORMGLASS_API_KEY': JSON.stringify(''),

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
        // Strip debug-noise console.* from production but KEEP .warn and .error
        // so production incidents actually surface in Xcode Console / Sentry.
        //
        // Previous `drop: ['console']` was over-broad — it removed every
        // console.* call including errors, which meant createLogger's
        // log.warn/log.error and any ad-hoc console.error diagnostics
        // silently vanished after minification, making production debugging
        // of native-bridge failures (e.g. WeatherKit entitlement errors)
        // effectively impossible.
        //
        // `pure` marks these calls as side-effect-free so esbuild's dead-
        // code-elimination removes them because their return value is never
        // consumed. Same net effect as `drop` for .log/.info/.debug but
        // leaves the error/warn channels alone.
        esbuild:
            mode === 'production'
                ? {
                      pure: ['console.log', 'console.info', 'console.debug'],
                      drop: ['debugger'],
                  }
                : undefined,
        // ES-module workers (2026-07-15): the navGrid worker imports the
        // engine graph (navGrid → aStar → marinaCenterline …), which Vite
        // code-splits — unsupported by the default 'iife' worker format. All
        // our workers are spawned with { type: 'module' }, so 'es' is correct.
        worker: {
            format: 'es',
        },
        build: {
            outDir: 'dist',
            sourcemap: mode !== 'production',
            cssMinify: true,
            chunkSizeWarningLimit: 750,
            rollupOptions: {
                // Three entry points: the main Thalassa SPA, the standalone
                // public Voyage Log renderer (logs.html → /logs/<handle>),
                // and the standalone public Passage Plan (plan.html →
                // <handle>.thalassawx.app/plan) — the float-plan surface,
                // deliberately outside the app shell.
                input: {
                    main: path.resolve(__dirname, 'index.html'),
                    logs: path.resolve(__dirname, 'logs.html'),
                    plan: path.resolve(__dirname, 'plan.html'),
                },
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
                    manualChunks(id) {
                        const moduleId = id.replaceAll('\\', '/');
                        if (!moduleId.includes('/node_modules/')) return undefined;

                        // Package-path routing avoids Rollup absorbing React into
                        // whichever React-based vendor happens to be visited
                        // first. The legal boot shell then loads React alone,
                        // while Sentry, DnD, data clients, and maps remain lazy.
                        if (
                            moduleId.includes('/node_modules/react/') ||
                            moduleId.includes('/node_modules/react-dom/') ||
                            moduleId.includes('/node_modules/scheduler/')
                        ) {
                            return 'vendor-react';
                        }
                        if (moduleId.includes('/node_modules/@dnd-kit/')) return 'vendor-dnd';
                        if (moduleId.includes('/node_modules/leaflet/')) return 'vendor-leaflet';
                        if (moduleId.includes('/node_modules/@supabase/')) return 'vendor-supabase';
                        if (moduleId.includes('/node_modules/@sentry/')) return 'vendor-sentry';
                        if (moduleId.includes('/node_modules/mapbox-gl/')) return 'vendor-mapbox';
                        if (moduleId.includes('/node_modules/@capacitor/core/')) return 'vendor-capacitor';
                        return undefined;
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
