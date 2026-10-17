import { test, expect } from '@playwright/test';

declare global {
    interface Window {
        fixture?: { ui: string[]; svg: string[]; classes?: string[]; frozen: boolean };
        providerMounted?: boolean;
        workerResult?: number[];
    }
}

test.beforeEach(async ({ context }) => {
    await context.route('**/*', (route) =>
        ['http://127.0.0.1:4307', 'http://127.0.0.2:4307'].includes(new URL(route.request().url()).origin)
            ? route.continue()
            : route.abort(),
    );
});

for (const policy of ['strict', 'native', 'web']) {
    for (const entry of ['index.html', 'logs.html']) {
        test(`${entry} consumes exact static/dynamic tables under ${policy} CSP`, async ({ page, request }, info) => {
            const expected = await (await request.get('/expected.json')).json();
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`/${entry}?policy=${policy}`);
            await expect(page.locator('#root')).toHaveText(expected.ui[0]);
            expect(await page.evaluate(() => window.fixture?.ui)).toEqual(expected.ui);
            expect(await page.evaluate(() => window.fixture?.svg)).toEqual(expected.svg);
            expect(await page.evaluate(() => window.fixture?.frozen)).toBe(true);
            if (entry === 'index.html') await page.locator('#dynamic').click();
            await expect.poll(() => page.evaluate(() => window.fixture?.classes)).toEqual(expected.classes);
            expect(await page.evaluate(() => Object.isFrozen(window.fixture?.classes))).toBe(true);
            await expect(page.locator('script[type="application/json"]')).toHaveCount(0);
            expect(await page.evaluate(() => window.providerMounted)).toBe(true);
            expect(errors).toEqual([]);
            if (policy === 'strict') await page.screenshot({ path: info.outputPath('exact-display.png') });
        });
    }
}

for (const entry of ['beta', 'feedback', 'ocean']) {
    test(`${entry} remains an independent entry without inert tables`, async ({ page }) => {
        await page.goto(`/${entry}`);
        await expect(page.locator('#root')).toHaveText(`${entry} independent`);
        await expect(page.locator('script[type="application/json"]')).toHaveCount(0);
        expect(await page.evaluate(() => window.fixture)).toBeUndefined();
        expect(await page.evaluate(() => window.providerMounted)).toBeUndefined();
    });
}

for (const fault of ['missing', 'duplicate', 'stale', 'mixed', 'malformed', 'metadata', 'checksum']) {
    for (const entry of ['index.html', 'logs.html']) {
        test(`${entry} shows an early fixed fallback for ${fault} data`, async ({ page }, info) => {
            await page.setViewportSize({ width: 300, height: 700 });
            await page.goto(`/${entry}?fault=${fault}`);
            await expect(page.getByRole('alert')).toHaveText(
                'Thalassa could not load its bundled display data. Reload the app.Reload',
            );
            expect(await page.evaluate(() => window.providerMounted)).toBeUndefined();
            expect(await page.evaluate(() => window.fixture)).toBeUndefined();
            const button = page.getByRole('button', { name: 'Reload', exact: true });
            expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
            ).toBe(true);
            await expect(page.getByRole('alert')).toHaveCount(1);
            if (fault === 'missing') await page.screenshot({ path: info.outputPath('early-fixed-error.png') });
        });
    }
}

test('a missing lazy class table fails without erasing an already mounted entry', async ({ page }) => {
    await page.goto('/index.html?fault=dynamic-class');
    await expect.poll(() => page.evaluate(() => window.providerMounted)).toBe(true);
    const original = await page.locator('#root').textContent();
    await page.locator('#dynamic').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('#root')).toHaveText(original!);
    expect(await page.evaluate(() => window.fixture?.classes)).toBeUndefined();
});

test('the independent real module worker still executes', async ({ page }) => {
    await page.goto('http://127.0.0.2:4307/index.html');
    await page.locator('#worker').click();
    await expect.poll(() => page.evaluate(() => window.workerResult)).toEqual([4, 9, 25]);
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('actual service-worker controlled cached HTML carries its data through offline deep navigation', async ({
    page,
    request,
}) => {
    await page.goto('http://127.0.0.2:4307/index.html');
    await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.goto('http://127.0.0.2:4307/plan/synthetic-proof');
    await page.locator('#dynamic').click();
    await expect.poll(() => page.evaluate(() => !!window.fixture?.classes)).toBe(true);
    await expect.poll(() => page.evaluate(async () => !!(await caches.match('/plan/synthetic-proof')))).toBe(true);
    // Windows WebKit's setOffline(true) aborts even a SW-served navigation.
    // Refuse actual server transport instead, with no HTTP/JS data fallback.
    await request.get('/_qa/transport?offline=1');
    try {
        await page.reload();
        await expect.poll(() => page.evaluate(() => window.providerMounted)).toBe(true);
        await page.locator('#dynamic').click();
        await expect.poll(() => page.evaluate(() => !!window.fixture?.classes)).toBe(true);
        await page.goto('http://127.0.0.2:4307/plan/new-offline-path');
        await expect.poll(() => page.evaluate(() => window.providerMounted)).toBe(true);
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect((await (await request.get('/_qa/transport')).json()).failedRequests).toBeGreaterThan(0);
    } finally {
        await request.get('/_qa/transport?offline=0');
    }
});

test('synthetic native-public byte copy is self-contained preparation, without a native acceptance claim', async ({
    page,
    request,
}) => {
    const proof = await (await request.get('/copy-proof.json')).json();
    expect(proof).toMatchObject({ byteIdentical: true, webDirDist: true, noRemoteServerUrl: true });
    expect(proof.matchingFiles).toBeGreaterThan(10);
    const sources: string[] = [];
    page.on('response', (response) => sources.push(response.headers()['x-fixture-source']));
    await page.goto('/index.html?copy=1');
    await expect.poll(() => page.evaluate(() => window.providerMounted)).toBe(true);
    await page.locator('#dynamic').click();
    await expect.poll(() => page.evaluate(() => !!window.fixture?.classes)).toBe(true);
    expect(sources.length).toBeGreaterThan(2);
    expect(sources.every((source) => source === 'native-public-copy')).toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
});
