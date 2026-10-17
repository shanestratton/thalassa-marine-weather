import { test, expect } from '@playwright/test';
import { build, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decode } from 'fast-png';
import { packMapboxShaders } from '../scripts/pack-mapbox-shaders.mjs';
import { compareWorkerBindings } from './helpers/workerBindingEquivalence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server: http.Server, address: string;
let measurement: { original: number; packed: number };
test.beforeAll(async () => {
    test.setTimeout(180_000);
    const file = fs.realpathSync(path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.js'));
    const bundles: Record<string, string> = {};
    for (const profile of ['original', 'packed']) {
        const entry = '\0mapbox-browser-proof';
        const decoder: Plugin = {
            name: 'original-bounded-decoder',
            enforce: 'pre',
            resolveId(id) {
                return id === 'virtual:thalassa-class-data-decoder'
                    ? path.join(root, 'utils/decodeClassNames.ts')
                    : null;
            },
        };
        const result = await build({
            root,
            configFile: false,
            mode: 'production',
            logLevel: 'silent',
            plugins: [
                {
                    name: 'proof-entry',
                    resolveId(id) {
                        return id === 'proof' ? entry : null;
                    },
                    load(id) {
                        return id === entry
                            ? `import sdk from ${JSON.stringify(file)};globalThis.fixtureSdk=sdk;`
                            : null;
                    },
                },
                ...(profile === 'packed' ? [packMapboxShaders(root), decoder] : []),
            ],
            build: {
                write: false,
                copyPublicDir: false,
                minify: 'terser',
                terserOptions: { compress: { passes: 2 } },
                rollupOptions: { input: 'proof', output: { inlineDynamicImports: true } },
            },
        });
        if (Array.isArray(result) || !('output' in result)) throw Error('Expected Mapbox fixture output');
        const chunk = result.output.find((v) => v.type === 'chunk');
        if (!chunk || chunk.type !== 'chunk') throw Error('Missing Mapbox fixture');
        bundles[profile] = chunk.code;
    }
    measurement = { original: Buffer.byteLength(bundles.original), packed: Buffer.byteLength(bundles.packed) };
    const css = fs.readFileSync(path.join(root, 'node_modules/mapbox-gl/dist/mapbox-gl.css'), 'utf8');
    server = http.createServer((req, res) => {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'",
        );
        const profile = req.url?.slice(1).replace('.js', '');
        if (profile && bundles[profile]) {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(bundles[profile]);
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.end(
                `<!doctype html><html><head><style>${css}</style></head><body style="margin:0"><div id="map" style="width:300px;height:240px"></div></body></html>`,
            );
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw Error('Missing fixture port');
    address = `http://127.0.0.1:${bound.port}`;
});
test.afterAll(async () => {
    if (server)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('packed renderer retains real shaders, public APIs and independently running Blob workers', async ({
    browser,
}, testInfo) => {
    test.setTimeout(60_000);
    const profiles = [];
    for (const profile of ['original', 'packed']) {
        const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
        const errors: string[] = [];
        const messages: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (['warning', 'error'].includes(message.type()) && messages.length < 20)
                messages.push(message.text().slice(0, 500));
        });
        await page.route('**/*', (route) =>
            route.request().url().startsWith(address) || route.request().url().startsWith(`blob:${address}/`)
                ? route.continue()
                : route.abort(),
        );
        await page.goto(address);
        await page.evaluate(() => {
            const state = {
                blobs: [] as Blob[],
                workers: 0,
                shaderSources: [] as string[],
                errors: [] as {
                    type: string;
                    message: string;
                    filename: string;
                    lineno: number;
                    error: string;
                    target: string;
                }[],
                messages: [] as { keys: string[]; type: unknown; id: unknown }[],
            };
            Object.assign(window, { fixtureState: state });
            const original = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob: Blob | MediaSource) => {
                if (blob instanceof Blob && blob.type === 'text/javascript') state.blobs.push(blob);
                return original(blob);
            };
            const NativeWorker = window.Worker;
            window.Worker = new Proxy(NativeWorker, {
                construct(Target, args: ConstructorParameters<typeof Worker>) {
                    state.workers++;
                    const worker = new Target(...args);
                    worker.addEventListener('error', (event) =>
                        state.errors.push({
                            type: event.type,
                            message: event.message,
                            filename: event.filename,
                            lineno: event.lineno,
                            error: String(event.error),
                            target: String(event.target),
                        }),
                    );
                    worker.addEventListener('message', (event) => {
                        if (state.messages.length < 20)
                            state.messages.push({
                                keys: Object.keys(event.data ?? {}),
                                type: event.data?.type,
                                id: event.data?.id,
                            });
                    });
                    return worker;
                },
            });
            const shaderSource = WebGL2RenderingContext.prototype.shaderSource;
            WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
                state.shaderSources.push(source);
                return shaderSource.call(this, shader, source);
            };
        });
        const importMs = await page.evaluate(async (url) => {
            const start = performance.now();
            await import(url);
            return performance.now() - start;
        }, `${address}/${profile}.js`);
        try {
            await page.evaluate(async () => {
                // This explicit no-provider fixture never requests Mapbox tiles.
                const sdk = (window as unknown as { fixtureSdk: typeof import('mapbox-gl').default }).fixtureSdk;
                sdk.workerCount = 1;
                sdk.accessToken = 'pk.offline-fixture-no-provider';
                const map = new sdk.Map({
                    container: 'map',
                    center: [0, 0],
                    zoom: 1,
                    attributionControl: false,
                    style: {
                        version: 8,
                        sources: {
                            fixture: {
                                type: 'geojson',
                                data: {
                                    type: 'Feature',
                                    properties: { name: 'proof' },
                                    geometry: {
                                        type: 'Polygon',
                                        coordinates: [
                                            [
                                                [-30, -20],
                                                [30, -20],
                                                [30, 20],
                                                [-30, 20],
                                                [-30, -20],
                                            ],
                                        ],
                                    },
                                },
                            },
                        },
                        layers: [
                            { id: 'background', type: 'background', paint: { 'background-color': '#111827' } },
                            { id: 'fill', type: 'fill', source: 'fixture', paint: { 'fill-color': '#ff0022' } },
                            {
                                id: 'line',
                                type: 'line',
                                source: 'fixture',
                                paint: { 'line-color': '#00ffff', 'line-width': 3 },
                            },
                        ],
                    },
                });
                Object.assign(window, { fixtureMap: map });
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(Error('Actual local map did not load')), 12_000);
                    map.once('idle', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                    map.once('error', (event) => {
                        clearTimeout(timer);
                        reject(event.error);
                    });
                });
            });
        } catch (error) {
            const diagnostic = await page.evaluate(() => {
                const current = window as unknown as {
                    fixtureState: Record<string, unknown>;
                    fixtureMap: import('mapbox-gl').Map;
                };
                const map = current.fixtureMap;
                return {
                    state: { ...current.fixtureState, blobs: undefined, shaderSources: undefined },
                    loaded: map?.loaded(),
                    styleLoaded: map?.isStyleLoaded(),
                    tilesLoaded: map?.areTilesLoaded(),
                    sourceLoaded: map?.isSourceLoaded('fixture'),
                    features: map?.queryRenderedFeatures({ layers: ['fill', 'line'] }).length,
                    visibility: document.visibilityState,
                };
            });
            await testInfo.attach(`${profile}-failure-state`, {
                body: JSON.stringify({ diagnostic, messages, pageErrors: errors }),
                contentType: 'application/json',
            });
            throw error;
        }
        const result = await page.evaluate(async () => {
            const current = window as unknown as {
                fixtureState: { blobs: Blob[]; workers: number; shaderSources: string[]; errors: unknown[] };
                fixtureSdk: typeof import('mapbox-gl').default;
                fixtureMap: import('mapbox-gl').Map;
            };
            return {
                workerBlobs: await Promise.all(current.fixtureState.blobs.map((blob) => blob.text())),
                workers: current.fixtureState.workers,
                shaders: current.fixtureState.shaderSources,
                workerErrors: current.fixtureState.errors,
                features: current.fixtureMap.queryRenderedFeatures({ layers: ['fill', 'line'] }).length,
                version: current.fixtureSdk.version,
                exports: Object.keys(current.fixtureSdk),
                bounds: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
            };
        });
        expect(result.features).toBeGreaterThan(0);
        expect(result.workers).toBeGreaterThan(0);
        expect(result.shaders.length).toBeGreaterThan(0);
        expect(result.workerErrors).toEqual([]);
        expect(errors).toEqual([]);
        expect(result.bounds).toEqual([375, 667]);
        const screenshot = await page.screenshot({ path: testInfo.outputPath(`${profile}.png`) });
        const pixels = decode(screenshot);
        let red = 0;
        for (let i = 0; i < pixels.data.length; i += pixels.channels)
            if (pixels.data[i] > 180 && pixels.data[i + 1] < 100 && pixels.data[i + 2] < 120) red++;
        expect(red).toBeGreaterThan(100);
        profiles.push({ ...result, importMs, redPixels: red });
        await page.close();
    }
    expect(profiles[1].exports).toEqual(profiles[0].exports);
    expect(profiles[1].version).toBe(profiles[0].version);
    expect(profiles[1].shaders).toEqual(profiles[0].shaders);
    const digests = profiles.map((p) => p.workerBlobs.map((value) => createHash('sha256').update(value).digest('hex')));
    expect(profiles[1].workerBlobs).toHaveLength(profiles[0].workerBlobs.length);
    const bindings = profiles[0].workerBlobs.map((value, index) =>
        compareWorkerBindings(value, profiles[1].workerBlobs[index]),
    );
    await testInfo.attach('actual-worker-and-size-proof', {
        body: JSON.stringify({
            measurement,
            workerDigests: digests,
            workers: profiles.map((p) => p.workers),
            shaderCounts: profiles.map((p) => p.shaders.length),
            importMs: profiles.map((p) => p.importMs),
            actualRedPixels: profiles.map((p) => p.redPixels),
            strictFinalBlobByteIdentity: bindings.map((value) => value.byteIdentical),
            independentBindingProof: bindings,
        }),
        contentType: 'application/json',
    });
    // Preserve the strict byte comparison result above. Whole-graph Terser
    // changes bound identifier spelling; an independent scope-resolved AST
    // must still have identical properties/literals/free names/control flow.
    for (const proof of bindings) expect(proof.equivalent).toBe(true);
    expect(measurement.packed).toBeLessThan(measurement.original - 100_000);
});
