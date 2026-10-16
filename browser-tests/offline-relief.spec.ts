import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { RELIEF_WEB_CACHE } from '../services/offlineReliefPlan';
const servers: Server[] = [];
test.afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

/** Bundle a public-only fixture so the production SW can cache hashed-style JS,
 * then launch a fresh page with ALL networking disabled. No dev-module cache shortcut. */
test('saved terrain renders after an offline cold restart through the real service worker', async ({
    page,
    context,
    browserName,
}) => {
    test.setTimeout(90000);
    const compiled = await build({
        entryPoints: [resolve('e2e/fixtures/offline-relief.ts')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        define: { 'import.meta.env': '{}' },
        plugins: [
            {
                name: 'synthetic-metering-policy',
                setup(b) {
                    b.onLoad({ filter: /[\\/]services[\\/]networkPolicy\.ts$/ }, () => ({
                        contents: 'export const satelliteModeBlocks = () => false;',
                        loader: 'ts',
                    }));
                    b.onLoad({ filter: /[\\/]stores[\\/]uiStore\.ts$/ }, () => ({
                        contents: 'export const useUIStore = {getState:()=>({isOffline:false})};',
                        loader: 'ts',
                    }));
                },
            },
        ],
    });
    const script = compiled.outputFiles[0].text;
    const html =
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#map{margin:0;width:100%;height:100%;background:#333b45}.mapboxgl-control-container{position:absolute;bottom:0;color:white}</style></head><body><div id="map"></div><script src="/assets/offline-relief-fixture-134.js"></script></body></html>';
    // 127.0.0.2 is a secure loopback origin but avoids the production SW's
    // localhost dev bypass. Serve SW scripts for real: WebKit cannot route them.
    const worker = readFileSync(resolve('public/sw.js'), 'utf8');
    // Fault injection surrounds the unchanged production worker: once commanded,
    // every WAN fetch rejects. Needed for WebKit's documented emulation bug:
    // https://github.com/microsoft/playwright/issues/42775 (even literal SW replies fail).
    const offlineFault = `let offlineFault=false;const attempted=[];const networkFetch=self.fetch.bind(self);self.fetch=(...args)=>{if(offlineFault){attempted.push(typeof args[0]==='string'?args[0]:args[0].url);return Promise.reject(new TypeError('Offline fixture network unavailable'));}return networkFetch(...args);};self.addEventListener('message',e=>{if(e.data==='offline-fault')offlineFault=true;e.ports[0]?.postMessage({blocked:offlineFault,attempted});});\n`;
    const server = createServer((req, res) => {
        if (req.url === '/sw.js') {
            res.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' });
            res.end(offlineFault + worker);
        } else if (req.url === '/assets/offline-relief-fixture-134.js') {
            res.writeHead(200, { 'content-type': 'application/javascript' });
            res.end(script);
        } else {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html);
        }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', () => resolve()));
    const origin = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    let tiles = 0;
    await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== origin) return route.abort();
        return route.continue();
    });
    // Generate decodable 256px PNG/WebP in this browser. All terrain is fictional.
    await page.goto(origin + '/e2e/fixtures/offline-relief.html');
    const images = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 256;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = 'rgb(150,0,0)';
        ctx.fillRect(0, 0, 256, 256);
        const png = c.toDataURL('image/png');
        ctx.fillStyle = 'rgb(128,0,0)';
        ctx.fillRect(0, 0, 256, 256);
        return { png, webp: c.toDataURL('image/webp', 1) };
    });
    expect(images.webp.startsWith('data:image/webp;')).toBe(true);
    await context.route('https://tiles.thalassatiles.com/**', (route) => {
        tiles++;
        const dem = route.request().url().includes('/dem/'),
            data = dem ? images.webp : images.png;
        return route.fulfill({
            contentType: dem ? 'image/webp' : 'image/png',
            headers: { 'access-control-allow-origin': '*' },
            body: Buffer.from(data.split(',')[1], 'base64'),
        });
    });
    await page.reload();
    const save = await page.evaluate(async () => {
        const fixture = (window as unknown as { __offlineRelief: { save: () => Promise<unknown> } }).__offlineRelief;
        return await fixture.save();
    });
    expect(save).toMatchObject({ result: { phase: 'done', failed: 0, missing: 0 } });
    expect((save as { storage: { tiles: number } }).storage.tiles).toBeGreaterThan(0);
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller)
            await new Promise<void>((resolve) =>
                navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }),
            );
    });
    // Cache the exact fixture shell in the app-shell lane used by the real SW.
    // Production Vite emits these assets; this self-contained test bundle is equivalent.
    const core = /const CACHE_NAME = '([^']+)'/.exec(worker)![1];
    await page.evaluate(
        async ({ html, script, core }) => {
            const c = await caches.open(core);
            await c.put(
                '/e2e/fixtures/offline-relief.html',
                new Response(html, { headers: { 'content-type': 'text/html' } }),
            );
            await c.put(
                '/assets/offline-relief-fixture-134.js',
                new Response(script, { headers: { 'content-type': 'application/javascript' } }),
            );
            // A saved-area proof must not rely on terrain cached during ordinary viewing.
            await caches.delete('thalassa-v199-runtime-tiles');
        },
        { html, script, core },
    );
    await page.evaluate(
        async () =>
            await new Promise((resolve) => {
                const c = new MessageChannel();
                c.port1.onmessage = (e) => resolve(e.data);
                navigator.serviceWorker.controller!.postMessage('offline-fault', [c.port2]);
            }),
    );
    await page.close();
    await context.unrouteAll({ behavior: 'wait' });
    const before = tiles;
    if (browserName === 'webkit') {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        servers.splice(servers.indexOf(server), 1);
    } else await context.setOffline(true);
    const cold = await context.newPage();
    await cold.goto(origin + '/e2e/fixtures/offline-relief.html');
    await expect
        .poll(() => cold.evaluate(() => typeof (window as unknown as { __offlineRelief?: unknown }).__offlineRelief))
        .toBe('object');
    let proof: unknown;
    await expect
        .poll(
            async () => {
                proof = await cold.evaluate(
                    async () =>
                        await (
                            window as unknown as { __offlineRelief: { probe: () => Promise<unknown> } }
                        ).__offlineRelief.probe(),
                );
                const p = (proof as { pixel: number[] }).pixel;
                return p[2] > 2 * p[0] + 10 && p[1] > p[0] + 10 && p[3] === 255;
            },
            { message: 'the saved public terrain is drawn after an actual cold offline render', timeout: 15000 },
        )
        .toBe(true);
    expect(proof).toMatchObject({ offline: browserName !== 'webkit', loaded: true });
    const pixel = (proof as { pixel: number[] }).pixel;
    expect(pixel[2]).toBeGreaterThan(2 * pixel[0] + 10);
    expect(pixel[1]).toBeGreaterThan(pixel[0] + 10);
    expect(pixel[3]).toBe(255);
    expect((proof as { attribution: string }).attribution).toContain('GEBCO');
    expect(tiles).toBe(before);
    const fault = await cold.evaluate(
        async () =>
            await new Promise<{ blocked: boolean; attempted: string[] }>((resolve) => {
                const c = new MessageChannel();
                c.port1.onmessage = (e) => resolve(e.data);
                navigator.serviceWorker.controller!.postMessage('read-offline-fault', [c.port2]);
            }),
    );
    expect(fault.blocked).toBe(true);
    const keys = await cold.evaluate(
        async (name) => (await (await caches.open(name)).keys()).map((r) => r.url),
        RELIEF_WEB_CACHE,
    );
    expect(
        keys
            .filter((url) => !url.includes('__offline-relief-manifest'))
            .every((url) => url.startsWith('https://tiles.thalassatiles.com/v1/relief-')),
    ).toBe(true);
    // Mapbox may ask for finer, unsaved tiles before overzooming a saved parent.
    // Every saved tile must be served locally; every network fallback is forced to fail.
    expect(fault.attempted.filter((url) => keys.includes(url))).toEqual([]);
    expect((proof as { storage: { tiles: number } }).storage.tiles).toBe(
        (save as { storage: { tiles: number } }).storage.tiles,
    );
    await test.info().attach('offline-relief-proof', {
        body: JSON.stringify(
            {
                save,
                proof,
                fault,
                offlineMethod:
                    browserName === 'webkit'
                        ? 'origin stopped + SW fetch rejection (Playwright42775)'
                        : 'context offline + SW fetch rejection',
                wanTilesBeforeRestart: before,
                wanTilesAfterRestart: tiles,
            },
            null,
            2,
        ),
        contentType: 'application/json',
    });
});
