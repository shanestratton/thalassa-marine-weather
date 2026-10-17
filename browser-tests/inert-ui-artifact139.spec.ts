import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';

test.use({
    storageState: {
        cookies: [],
        origins: ['http://127.0.0.1:4309', 'http://127.0.0.2:4309'].flatMap((origin) =>
            ONBOARDED_STORAGE.origins.map((value) => ({ ...value, origin })),
        ),
    },
});
test.beforeEach(async ({ context }) => {
    await context.route('**/*', (route) =>
        ['http://127.0.0.1:4309', 'http://127.0.0.2:4309'].includes(new URL(route.request().url()).origin)
            ? route.continue()
            : route.abort(),
    );
});

for (const policy of ['native', 'web']) {
    test(`actual guest vessel entry consumes all six tables under ${policy} policy`, async ({ page }, info) => {
        await page.goto(`/?view=vessel&policy=${policy}`);
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.locator('script[type="application/json"][id^="thalassa-ui-"]')).toHaveCount(0);
        await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const preferences = page.getByRole('button', { name: /^Open Preferences settings/ });
        await expect(preferences).toBeVisible();
        await expect(preferences).toBeInViewport({ ratio: 0.9 });
        await expect
            .poll(() =>
                preferences.evaluate((element) => {
                    let opacity = 1;
                    for (let node: Element | null = element; node; node = node.parentElement)
                        opacity *= Number(getComputedStyle(node).opacity);
                    return opacity;
                }),
            )
            .toBeGreaterThan(0.99);
        const startup = JSON.stringify(
            await page.evaluate(() => ({
                domInteractive: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)
                    ?.domInteractive,
                remainingDataNodes: document.querySelectorAll('script[type="application/json"][id^="thalassa-ui-"]')
                    .length,
                jsHeapBytes: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize,
            })),
        );
        await writeFile(info.outputPath('actual-startup.json'), startup);
        await info.attach('actual-startup.json', { body: startup, contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('actual-guest-settings.png'), animations: 'disabled' });
    });
}

test('actual planner deep link and Logs entry mount without a backend or display-data failure', async ({ page }) => {
    await page.goto('/plan/synthetic-proof');
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('script[type="application/json"][id^="thalassa-ui-"]')).toHaveCount(0);
    await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
    await page.goto('/logs/no-real-vessel');
    await expect(page.getByRole('heading', { name: 'Voyage log unavailable', exact: true })).toBeVisible();
    await expect(page.locator('script[type="application/json"][id^="thalassa-ui-"]')).toHaveCount(0);
    await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
});

for (const [entry, selector] of [
    ['beta', '#beta-heading'],
    ['feedback', '#feedback-heading'],
    ['ocean', '#oc-h1'],
]) {
    test(`actual independent ${entry} entry mounts without any packed-data blocks`, async ({ page }) => {
        await page.goto('/' + entry);
        await expect(page.locator(selector)).toBeVisible();
        await expect(page.locator('script[type="application/json"][id^="thalassa-ui-"]')).toHaveCount(0);
        await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
    });
}

for (const entry of ['index.html', 'logs.html']) {
    test(`actual ${entry} refuses stale HTML data identities before entry handlers`, async ({ page }, info) => {
        await page.goto(`/${entry}?fault=stale`);
        await expect(page.getByRole('alert')).toHaveText(
            'Thalassa could not load its bundled display data. Reload the app.Reload',
        );
        await expect(page.locator('#root')).toBeEmpty();
        await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath('actual-stale-data-error.png') });
    });
}

test('actual route worker builds a tiny fictional unvouched grid independently of the document reader', async ({
    page,
    request,
}) => {
    const proof = await (await request.get('/_qa/proof.json')).json();
    await page.goto('/?view=vessel');
    const result = await page.evaluate(
        (url) =>
            new Promise<{
                width: number;
                height: number;
                cells: number;
                unvouched: boolean;
                unvouchedLength: number;
                preferred: boolean;
            }>((resolve, reject) => {
                const worker = new Worker(url, { type: 'module' });
                const timer = setTimeout(() => {
                    worker.terminate();
                    reject(Error('Actual worker deadline'));
                }, 8000);
                worker.onerror = () => {
                    clearTimeout(timer);
                    worker.terminate();
                    reject(Error('Actual worker error'));
                };
                worker.onmessage = ({ data }) => {
                    if (data.type === 'ready')
                        worker.postMessage({
                            type: 'grid',
                            id: 139,
                            args: {
                                layers: {},
                                bbox: [0, 0, 0.001, 0.001],
                                resolutionM: 50,
                                draftM: 1,
                                safetyM: 1,
                                obstructionBufferM: 0,
                            },
                        });
                    else if (data.type === 'grid') {
                        clearTimeout(timer);
                        worker.terminate();
                        resolve({
                            width: data.grid.width,
                            height: data.grid.height,
                            cells: data.grid.cells.length,
                            unvouched: Array.from(data.grid.unvouched ?? []).every((value) => value === 1),
                            unvouchedLength: data.grid.unvouched?.length ?? 0,
                            preferred: Array.from(data.grid.preferred).every((value) => value === 0),
                        });
                    } else if (data.type === 'error' || data.type === 'init-error') {
                        clearTimeout(timer);
                        worker.terminate();
                        reject(Error(data.message));
                    }
                };
            }),
        proof.router,
    );
    expect(result.width).toBeGreaterThan(0);
    expect(result.width).toBeLessThan(10);
    expect(result.cells).toBe(result.width * result.height);
    expect(result.unvouched).toBe(true);
    expect(result.unvouchedLength).toBe(result.cells);
    expect(result.preferred).toBe(true);
});

test('actual configured public-byte copy preserves hashes and guest boot, without native hardware claims', async ({
    page,
    request,
}) => {
    const proof = await (await request.get('/_qa/proof.json')).json();
    expect(proof).toMatchObject({
        artifact: process.env.INERT_UI_RELEASE_ARTIFACT === '1' ? 'dist' : 'build139-configured-inert-tuples',
        sourceMode:
            process.env.INERT_UI_RELEASE_ARTIFACT === '1'
                ? 'already-built-release-dist'
                : 'reviewed-configured-artifact',
        copiedPublicBytesIdentical: true,
        sourceMapsExcludedFromCopy: true,
    });
    expect(proof.tables).toHaveLength(6);
    const sources: string[] = [];
    page.on('response', (response) => {
        if (response.headers()['x-fixture-source']) sources.push(response.headers()['x-fixture-source']);
    });
    await page.goto('/?view=vessel&copy=1');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    expect(sources.length).toBeGreaterThan(3);
    expect(sources.every((value) => value === 'actual-public-copy')).toBe(true);
    await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
});

test('actual controlled SW cached vessel page survives a transport outage with its bundled data', async ({
    page,
    request,
}) => {
    await page.goto('http://127.0.0.2:4309/?view=vessel');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => !!(await caches.match(location.href)))).toBe(true);
    await request.get('/_qa/transport?offline=1');
    try {
        await page.reload();
        await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.locator('script[type="application/json"][id^="thalassa-ui-"]')).toHaveCount(0);
        await expect(page.locator('#thalassa-display-data-error')).toHaveCount(0);
        expect((await (await request.get('/_qa/transport')).json()).failedRequests).toBeGreaterThan(0);
    } finally {
        await request.get('/_qa/transport?offline=0');
    }
});
