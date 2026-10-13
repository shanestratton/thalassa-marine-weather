/**
 * Routing off the main thread, on the production build (127-ROUTE-W): the
 * Phase 0 spike, kept. The engine chunk IS the route worker — one copy, no
 * worker build — so this proves, on the built files, that:
 *   - dist has one `router-engine-*.js`, and its static imports are only the
 *     router's own chunks (an allowlist: `router-engine-*`, `engine-leaf-*`);
 *   - in the page it starts as a module worker and answers a synthetic 5 NM
 *     route job (the synthetic archipelago, built here in Node), forwarding
 *     its log lines to the page;
 *   - that answer is bit-identical to the same chunk import()ed on the page's
 *     main thread (the fallback), and equal to the chunk import()ed in Node
 *     within relative 1e-12 on numbers and exactly on everything else:
 *     mobile-safari is JavaScriptCore, which differs from V8 in the last bits
 *     of a few lengths (measured 2026-10-10), never in the route.
 *
 * And the navGrid fold (127-ROUTE-W2): the tracer's grids are built in a
 * second instance of the same chunk, so
 *   - dist has no `navGridWorker-*.js` (the second copy of the navGrid code,
 *     35,001 B, is gone);
 *   - the chunk, started as a module worker, answers a tracer grid job with
 *     its typed arrays transferred, byte for byte the grid the same chunk
 *     builds on the page's main thread (the tracer's fallback).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { syntheticArchipelago } from '../tests/fixtures/syntheticArchipelago';
import { cellFinenessRank } from '../services/enc/scaleShadow';

const ASSETS = join(process.cwd(), 'dist', 'assets');
const local = existsSync(ASSETS) && !process.env.PREVIEW_URL;

/** The route job tryInshoreRoute would post for the archipelago's 5 NM leg, minus the prep's OSM and marks. */
function fiveMileJob() {
    const a = syntheticArchipelago();
    const layers: Record<string, { type: 'FeatureCollection'; features: unknown[] }> = {};
    for (const cell of a.cells) {
        const rank = cellFinenessRank({ nativeScale: cell.blob.nativeScale, cellId: cell.meta.id });
        for (const [name, fc] of Object.entries(cell.blob.layers))
            (layers[name] ??= { type: 'FeatureCollection', features: [] }).features.push(
                ...fc.features.map((f) => ({ ...f, properties: { ...f.properties, _scaleRank: rank } })),
            );
    }
    const { from, to } = a.routes['5nm'];
    return {
        layers,
        routeOpts: {
            fromLat: from[1],
            fromLon: from[0],
            toLat: to[1],
            toLon: to[0],
            draftM: 2.4,
            safetyM: 0.5,
            obstructionBufferM: 60,
            unchartedPolicy: 'strict',
            routeProfile: 'safest',
            surveyUncheckedCells: [],
        },
        origin: { lat: from[1], lon: from[0] },
        destination: { lat: to[1], lon: to[0] },
        airDraftM: 18,
        cellsUsed: a.cells.map((c) => c.meta.id),
        structuresUnknownCells: [],
        structuresUnknownBboxes: [],
        regionalPairs: [],
        leadGraph: null,
        tideCeilings: [],
    };
}

/** A tracer grid job for the same 5 NM leg, as navGridWorkerHost posts it (buildNavGrid's arguments). */
function fiveMileGridArgs() {
    const job = fiveMileJob();
    const { fromLon, fromLat, toLon, toLat } = job.routeOpts;
    const pad = 0.01;
    return {
        layers: job.layers,
        bbox: [
            Math.min(fromLon, toLon) - pad,
            Math.min(fromLat, toLat) - pad,
            Math.max(fromLon, toLon) + pad,
            Math.max(fromLat, toLat) + pad,
        ],
        resolutionM: 40,
        draftM: 2.4,
        safetyM: 0.5,
        obstructionBufferM: 60,
        relaxedLndare: false,
        relaxZones: [],
        routeProfile: 'safest',
    };
}

/** The route as compared: no timings. */
function answer(output: { result: Record<string, unknown> | null }): unknown {
    const r = output.result;
    return r && 'elapsedMs' in r ? { ...r, elapsedMs: 0 } : r;
}

const canonical = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) =>
        x && typeof x === 'object' && !Array.isArray(x)
            ? Object.fromEntries(
                  Object.keys(x as object)
                      .sort()
                      .map((k) => [k, (x as Record<string, unknown>)[k]]),
              )
            : x,
    );

/** Equal apart from last-place float rounding (relative 1e-12 on numbers, exact on all else); the first difference. */
function nearlyEqual(a: unknown, b: unknown, path = '$'): string | null {
    if (typeof a === 'number' && typeof b === 'number')
        return a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b))
            ? null
            : `${path}: ${a} vs ${b}`;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
        const ka = Object.keys(a)
            .filter((k) => (a as Record<string, unknown>)[k] !== undefined)
            .sort();
        const kb = Object.keys(b)
            .filter((k) => (b as Record<string, unknown>)[k] !== undefined)
            .sort();
        if (ka.join() !== kb.join()) return `${path}: keys [${ka}] vs [${kb}]`;
        for (const k of ka) {
            const d = nearlyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
            if (d) return d;
        }
        return null;
    }
    return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

test.describe('the route worker is the engine chunk', () => {
    test.skip(!local, 'needs the local production build in dist/ (npm run build)');

    const chunk = local ? readdirSync(ASSETS).find((f) => /^router-engine-[\w-]+\.js$/.test(f)) : undefined;

    test('dist has one router-engine chunk, which imports only the router’s own chunks', () => {
        expect(readdirSync(ASSETS).filter((f) => /^router-engine-[\w-]+\.js$/.test(f))).toHaveLength(1);
        const seen = new Set<string>();
        const queue = [chunk!];
        while (queue.length > 0) {
            const file = queue.pop()!;
            if (seen.has(file)) continue;
            seen.add(file);
            const code = readFileSync(join(ASSETS, file), 'utf8');
            for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g)) queue.push(m[1]);
        }
        expect([...seen].filter((f) => !/^(router-engine|engine-leaf)-[\w-]+\.js$/.test(f))).toEqual([]);
    });

    test('dist has no navGrid worker build: the tracer’s grids use the engine chunk too', () => {
        expect(readdirSync(ASSETS).filter((f) => /^navGridWorker-[\w-]+\.js$/.test(f))).toEqual([]);
    });

    test('answers a tracer grid job as a module worker, byte for byte as on the main thread', async ({ page }) => {
        test.setTimeout(120_000);
        const args = fiveMileGridArgs();
        const url = `/assets/${chunk}`;
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        await page.route('**/__route-worker.html', (route) =>
            route.fulfill({ body: '<!doctype html><title>route worker</title>', contentType: 'text/html' }),
        );
        await page.goto('/__route-worker.html');
        const out = await page.evaluate(
            async ({ url, args }) => {
                const worker = new Worker(url, { type: 'module' });
                const fromWorker = await new Promise<Record<string, unknown>>((resolve, reject) => {
                    worker.onerror = (e) => reject(new Error(`route worker failed: ${e.message ?? e.type}`));
                    worker.onmessage = (e: MessageEvent) => {
                        const d = e.data as { type: string; grid?: Record<string, unknown>; message?: string };
                        if (d.type === 'ready') worker.postMessage({ type: 'grid', id: 1, args });
                        else if (d.type === 'grid') resolve(d.grid!);
                        else if (d.type !== 'console') reject(new Error(`${d.type}: ${d.message}`));
                    };
                });
                worker.terminate();
                const ns = (await import(url)) as Record<string, unknown>;
                const engine = Object.values(ns).find(
                    (v): v is { url: string; grid: (...a: unknown[]) => Record<string, unknown> } =>
                        !!v &&
                        typeof v === 'object' &&
                        typeof (v as { grid?: unknown }).grid === 'function' &&
                        (v as { url?: unknown }).url === new URL(url, location.href).href,
                );
                if (!engine) throw new Error('the chunk does not export its grid builder');
                const a = structuredClone(args);
                const onMain = engine.grid(
                    a.layers,
                    a.bbox,
                    a.resolutionM,
                    a.draftM,
                    a.safetyM,
                    a.obstructionBufferM,
                    a.relaxedLndare,
                    a.relaxZones,
                    a.routeProfile,
                );
                // Field by field: a typed array by kind and every byte.
                const differences: string[] = [];
                const keys = [...new Set([...Object.keys(fromWorker), ...Object.keys(onMain)])].sort();
                let typedArrays = 0;
                for (const k of keys) {
                    const w = fromWorker[k];
                    const m = onMain[k];
                    if (ArrayBuffer.isView(w) && ArrayBuffer.isView(m)) {
                        typedArrays++;
                        const wb = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
                        const mb = new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
                        if (
                            w.constructor !== m.constructor ||
                            wb.length !== mb.length ||
                            wb.some((byte, i) => byte !== mb[i])
                        )
                            differences.push(k);
                    } else if (JSON.stringify(w) !== JSON.stringify(m)) differences.push(k);
                }
                return { differences, typedArrays, width: onMain.width as number };
            },
            { url, args },
        );
        expect(pageErrors).toEqual([]);
        expect(out.width).toBeGreaterThan(10);
        expect(out.typedArrays).toBeGreaterThan(3);
        expect(out.differences).toEqual([]);
    });

    test('answers a 5 NM job as a module worker, exactly as on the main thread, and as in Node', async ({ page }) => {
        test.setTimeout(120_000);
        const job = fiveMileJob();
        const url = `/assets/${chunk}`;
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        await page.route('**/__route-worker.html', (route) =>
            route.fulfill({ body: '<!doctype html><title>route worker</title>', contentType: 'text/html' }),
        );
        await page.goto('/__route-worker.html');
        const out = await page.evaluate(
            async ({ url, job }) => {
                const worker = new Worker(url, { type: 'module' });
                const logs: string[] = [];
                const fromWorker = await new Promise<unknown>((resolve, reject) => {
                    worker.onerror = (e) => reject(new Error(`route worker failed: ${e.message ?? e.type}`));
                    worker.onmessage = (e: MessageEvent) => {
                        const d = e.data as { type: string; output?: unknown; message?: string; text?: string };
                        if (d.type === 'ready') worker.postMessage({ type: 'job', id: 1, job });
                        else if (d.type === 'console') logs.push(String(d.text));
                        else if (d.type === 'result') resolve(d.output);
                        else reject(new Error(`${d.type}: ${d.message}`));
                    };
                });
                worker.terminate();
                const ns = (await import(url)) as Record<string, unknown>;
                const engine = Object.values(ns).find(
                    (v): v is { url: string; run: (j: unknown) => unknown } =>
                        !!v &&
                        typeof v === 'object' &&
                        typeof (v as { run?: unknown }).run === 'function' &&
                        (v as { url?: unknown }).url === new URL(url, location.href).href,
                );
                if (!engine) throw new Error('the chunk does not export its engine');
                return { fromWorker, onMain: engine.run(structuredClone(job)), logs };
            },
            { url, job },
        );
        expect(pageErrors).toEqual([]);
        const worker = answer(out.fromWorker as never) as { polyline?: unknown[] } | null;
        expect(worker?.polyline?.length ?? 0, 'the worker routed the 5 NM leg').toBeGreaterThan(1);
        expect(canonical(worker)).toBe(canonical(answer(out.onMain as never)));
        expect(out.logs.some((line) => line.startsWith('[inshoreEngine]'))).toBe(true);

        const ns = (await import(pathToFileURL(join(ASSETS, chunk!)).href)) as Record<string, unknown>;
        const engine = Object.values(ns).find(
            (v): v is { run: (j: unknown) => unknown } =>
                !!v && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'function',
        )!;
        const inNode = answer(engine.run(structuredClone(job)) as never);
        expect(nearlyEqual(worker, inNode)).toBeNull();
    });
});
