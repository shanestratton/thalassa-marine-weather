/// <reference types="vitest" />
import path from 'path';
import { execSync } from 'node:child_process';
import http from 'http';
import net from 'node:net';
import fs from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'url';
import {
    PUBLIC_BETA_FEATURE_ARTIFACT_FILE,
    publicBetaCredentialPresenceFromEnvironment,
    publicBetaFeatureDefines,
    publicBetaFeatureEnvironmentConflicts,
    readPublicBetaFeatureProfile,
    serializePublicBetaFeatureArtifact,
} from './scripts/public-beta-feature-profile.mjs';

// Define __dirname for ESM context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicBetaFeatureProfile = readPublicBetaFeatureProfile(__dirname);

export const MARINE_PROXY_DATASETS = ['currents', 'waves', 'sst', 'chl', 'seaice', 'mld', 'mpa'] as const;

/**
 * Local QA must exercise the same shard-aware Edge boundary as production.
 * Rolling GitHub tags carry redundant manifest-v2-a/b.json discovery slots;
 * immutable generation files live in ISO-week asset tags selected by the
 * canonical proxy.
 */
export const canonicalMarineDevProxy = Object.fromEntries(
    MARINE_PROXY_DATASETS.map((dataset) => [
        `/api/${dataset}`,
        {
            target: 'https://thalassawx.vercel.app',
            changeOrigin: true,
        },
    ]),
);

function releasePublicBetaFeatureManifest(credentialPresence: Record<string, boolean>): Plugin {
    const source = serializePublicBetaFeatureArtifact(publicBetaFeatureProfile, credentialPresence);
    const define = publicBetaFeatureDefines(publicBetaFeatureProfile);

    return {
        name: 'release-public-beta-feature-manifest',
        apply: 'build',
        config() {
            // The committed profile owns production feature switches and
            // public endpoint choices. Local files and CI/Vercel variables
            // cannot silently create a different release candidate.
            return { define };
        },
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: PUBLIC_BETA_FEATURE_ARTIFACT_FILE,
                source,
            });
        },
    };
}

function releasePublicInputFence() {
    let outDir = path.resolve(__dirname, 'dist');

    function removeFinderMetadata(directory: string): void {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) removeFinderMetadata(target);
            else if (entry.name === '.DS_Store') fs.rmSync(target, { force: true });
        }
    }

    return {
        name: 'release-public-input-fence',
        apply: 'build' as const,
        configResolved(config: { root: string; build: { outDir: string } }) {
            outDir = path.resolve(config.root, config.build.outDir);
        },
        closeBundle() {
            // `public/enc-samples` is an ignored local chart-development input.
            // It must never make a submitted web/Capacitor artifact differ from
            // a clean CI checkout, regardless of the cell's provenance.
            fs.rmSync(path.join(outDir, 'enc-samples'), { recursive: true, force: true });
            removeFinderMetadata(outDir);
        },
    };
}

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

/**
 * `vite preview` serves the production bytes but does not interpret
 * `vercel.json`. Mirror the small, public document-routing surface here so
 * the local release gate can exercise the same deep links without pretending
 * that it has proved Vercel's edge configuration. The release verifier also
 * audits `vercel.json` directly and the deployment workflow checks the real
 * hosted responses.
 */
function releasePreviewDocumentRoutes() {
    return {
        name: 'release-preview-document-routes',
        configurePreviewServer(server: any) {
            server.middlewares.use((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    next();
                    return;
                }

                const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
                const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/';

                if (pathname === '/float' || pathname.startsWith('/float/')) {
                    res.statusCode = 307;
                    res.setHeader('Location', '/logs');
                    res.end();
                    return;
                }

                let destination: string | null = null;
                if (pathname === '/terms') destination = '/terms.html';
                else if (pathname === '/voyage-log-api') destination = '/voyage-log-api.html';
                else if (pathname === '/logs' || pathname.startsWith('/logs/')) destination = '/logs.html';
                else if (pathname === '/beta') destination = '/beta.html';
                else if (pathname === '/feedback') destination = '/feedback.html';
                else if (pathname === '/plan' || pathname.startsWith('/plan/')) destination = '/index.html';
                else if (pathname !== '/' && !pathname.split('/').pop()?.includes('.')) destination = '/index.html';

                if (destination) req.url = `${destination}${requestUrl.search}`;
                next();
            });
        },
    };
}

/** The commit this bundle was built from, or 'unknown' — never a build failure. */
function resolveCommitSha(): string {
    const fromCi = String(process.env.GITHUB_SHA ?? '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(fromCi)) return fromCi.slice(0, 12);
    try {
        return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return 'unknown';
    }
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
    const publicBetaCredentialPresence = publicBetaCredentialPresenceFromEnvironment(publicBetaFeatureProfile, {
        ...env,
        ...process.env,
    });
    const publicBetaEnvironmentConflicts = publicBetaFeatureEnvironmentConflicts(publicBetaFeatureProfile, {
        ...env,
        ...process.env,
    });
    if (mode === 'production' && publicBetaEnvironmentConflicts.length > 0) {
        throw new Error(
            `Production environment disagrees with config/public-beta-features.json: ${publicBetaEnvironmentConflicts.join(', ')}`,
        );
    }

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
                // Exercise the deployed server-only OWM boundary in local QA;
                // no paid provider credential enters the Vite process/bundle.
                '/api/owm-tile': {
                    target: 'https://thalassawx.vercel.app',
                    changeOrigin: true,
                },
                // Same-origin dev routes retain their /api/{dataset}/... path
                // and pass through the canonical shard-aware production proxy.
                ...canonicalMarineDevProxy,
                // Xweather proxy removed 2026-04-22 with the Xweather
                // decommission. Lightning moved to Blitzortung WebSocket
                // (no proxy needed, browser-direct WSS). Squall awaiting
                // NOAA replacement.
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
            releasePreviewDocumentRoutes(),
            mode === 'production' && releasePublicBetaFeatureManifest(publicBetaCredentialPresence),
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
                        proxyReq.on('error', () => {
                            // The host/path originate in the development request. Keep
                            // them out of terminal logs and browser responses so control
                            // characters or upstream diagnostics cannot forge log lines.
                            console.error('[chart-proxy] LAN chart request failed');
                            if (!res.headersSent) {
                                res.writeHead(502, { 'Content-Type': 'text/plain' });
                            }
                            res.end('Chart proxy request failed');
                        });
                        proxyReq.end();
                    });
                },
            },
            react(),
            mode === 'production' && releasePublicInputFence(),
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

            // The build stamp, shown in Settings > General. Exists because a
            // week of Log-page fixes was debugged against a phone still
            // running a five-day-old build: `npm run build` + `cap sync` stage
            // the bundle into the Xcode PROJECT, but nothing reaches the phone
            // until Xcode RUNS it there. With a visible stamp, "is the fix on
            // the phone?" is a five-second glance instead of an argument.
            __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'),
            // Exact build identity for diagnostics: an error tagged only
            // "1.2.0" cannot be tied to a commit or a TestFlight build number.
            // CI supplies GITHUB_SHA; a local build asks git; neither is fatal.
            __COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
            __APP_BUILD__: JSON.stringify(String(process.env.VITE_APP_BUILD ?? '').trim()),

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
                getKey('VITE_SUPABASE_ANON_KEY') || getKey('VITE_SUPABASE_KEY') || '',
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
            // Production emits source maps ONLY for a run that will upload and
            // then delete them (scripts/upload-sourcemaps.mjs, SENTRY_SOURCEMAPS=1
            // in CI). 'hidden' omits the sourceMappingURL comment, but the .map
            // files still land in dist — and dist is what Vercel serves and what
            // cap copy ships inside the app — so a local `npm run build` must
            // never produce them (audit item 21).
            sourcemap: mode !== 'production' ? true : process.env.SENTRY_SOURCEMAPS === '1' ? 'hidden' : false,
            cssMinify: true,
            chunkSizeWarningLimit: 750,
            rollupOptions: {
                // Standalone public surfaces stay independent from the main
                // app's legal/auth/provider boot path: Voyage Log renders at
                // /logs/<handle>, the Founding Skippers form at /beta, and
                // Product Feedback at /feedback.
                //
                // plan.html carried the shore-crew float plan and is gone with
                // it — a float plan on a public URL announces an unattended
                // boat and its next move. It is composed on the device now and
                // shared directly to one person.
                input: {
                    main: path.resolve(__dirname, 'index.html'),
                    logs: path.resolve(__dirname, 'logs.html'),
                    beta: path.resolve(__dirname, 'beta.html'),
                    feedback: path.resolve(__dirname, 'feedback.html'),
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
