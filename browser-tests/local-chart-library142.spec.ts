import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const fixtures = resolve(ROOT, 'tests/fixtures/local-charts142');
const fixturePixels = JSON.parse(readFileSync(resolve(fixtures, 'expected.json'), 'utf8')) as {
    files: Record<string, { displayRgba: number[] }>;
};
const originalPixel = (name: string, x: number, y: number) =>
    fixturePixels.files[name].displayRgba.slice((y * 8 + x) * 4, (y * 8 + x + 1) * 4);
type State = {
    ready: boolean;
    active: boolean;
    credit: { text: string; warning: boolean } | null;
    blobUrlsHanded: number;
    errors: string[];
    violations: unknown[];
    probe(lon: number, lat: number): number[];
    sourcePresent(): boolean;
    switchAccount(owner: 'a' | 'b'): void;
};
type FixtureWindow = Window & { __localChart142: State };
test.afterEach(async ({ page }, info) => {
    const state = await page
        .evaluate(() => {
            const value = (window as FixtureWindow).__localChart142;
            return value
                ? {
                      ready: value.ready,
                      active: value.active,
                      credit: value.credit,
                      blobs: value.blobUrlsHanded,
                      errors: value.errors,
                      violations: value.violations,
                      source: value.sourcePresent(),
                  }
                : null;
        })
        .catch(() => null);
    await info.attach('final-actual-fixture-state', { body: JSON.stringify(state), contentType: 'application/json' });
});
function policy(which: 'native' | 'web') {
    if (which === 'native') {
        const match = readFileSync(resolve(ROOT, 'index.html'), 'utf8').match(
            /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
        );
        if (!match) throw new Error('Native CSP missing');
        return match[1];
    }
    const value = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
        headers: { headers: { key: string; value: string }[] }[];
    };
    const csp = value.headers
        .flatMap((x) => x.headers)
        .find((x) => x.key.toLowerCase() === 'content-security-policy')?.value;
    if (!csp) throw new Error('Web CSP missing');
    return csp;
}
async function library(page: Page) {
    await page.getByRole('button', { name: 'Charts', exact: true }).click();
    await page.getByRole('button', { name: /Import a chart file ·/ }).click();
    await expect(page.getByRole('heading', { name: 'Your local charts' })).toBeVisible();
}
async function save(page: Page, name: string) {
    await page.getByRole('radio', { name: /I created this chart/ }).check();
    await page.getByLabel('Choose local chart file').setInputFiles(resolve(fixtures, name));
    await expect(page.getByRole('article').filter({ has: page.getByText(name, { exact: true }) })).toBeVisible();
}
async function display(page: Page, name: string) {
    await page
        .getByRole('article')
        .filter({ has: page.getByText(name, { exact: true }) })
        .getByRole('button', { name: 'Display', exact: true })
        .click();
    await expect(page.getByRole('status').filter({ hasText: 'Overlay displayed.' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your local charts' })).toHaveCount(0);
}
async function pixel(page: Page, lon: number, lat: number, expected: number[]) {
    await expect
        .poll(() => page.evaluate(([x, y]) => (window as FixtureWindow).__localChart142.probe(x, y), [lon, lat]), {
            timeout: 15000,
        })
        .toEqual(expected);
}
for (const width of [300, 375])
    for (const csp of ['native', 'web'] as const) {
        test(`retained local chart import, original pixels, ownership and closed reload ${width}px ${csp}`, async ({
            page,
        }, info) => {
            await page.setViewportSize({ width, height: 780 });
            const errors: string[] = [],
                wan: string[] = [],
                wasm: string[] = [],
                blockedSdk: string[] = [];
            await page.route('**/*', (route) => {
                const url = route.request().url();
                if (!/^https?:/.test(url) || new URL(url).hostname === '127.0.0.1') return route.continue();
                if (new URL(url).hostname.endsWith('.mapbox.com')) blockedSdk.push(url);
                return route.abort();
            });
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => {
                const url = request.url();
                if (/sql-wasm\.wasm/.test(url)) wasm.push(url);
                if (
                    /^https?:/.test(url) &&
                    new URL(url).hostname !== '127.0.0.1' &&
                    !new URL(url).hostname.endsWith('.mapbox.com')
                )
                    wan.push(url);
            });
            await page.route('**/e2e/fixtures/local-chart-library142.html*', async (route) => {
                const response = await route.fetch(),
                    headers = { ...response.headers() };
                let body = await response.text();
                if (csp === 'native')
                    body = body.replace(
                        '<head>',
                        `<head><meta http-equiv="Content-Security-Policy" content="${policy(csp).replace(/"/g, '&quot;')}"/>`,
                    );
                else headers['content-security-policy'] = policy(csp);
                await route.fulfill({ response, headers, body });
            });
            await page.goto('/e2e/fixtures/local-chart-library142.html');
            await page.waitForFunction(() => (window as FixtureWindow).__localChart142?.ready, { timeout: 30000 });
            await library(page);
            await expect(page.getByRole('button', { name: 'Import a chart file', exact: true })).toBeDisabled();
            expect(wasm).toEqual([]);
            await save(page, 'own-ocean.mbtiles');
            expect(wasm, 'listing retained files never loads SQLite').toEqual([]);
            await display(page, 'own-ocean.mbtiles');
            await pixel(page, -33.75, -11, [255, 0, 200, 255]);
            await pixel(page, -42, -3, [8, 36, 59, 255]);
            expect(wasm.length).toBe(1);
            await expect(page.getByTestId('obs-credits-rollup')).toBeVisible();
            expect((await page.getByTestId('obs-credits-rollup').boundingBox())?.height).toBe(44);
            await library(page);
            await save(page, 'phone.kap');
            await display(page, 'phone.kap');
            await pixel(page, 153.0125, -27.1125, originalPixel('phone.kap', 4, 4));
            await pixel(page, 152.9125, -27.1125, [8, 36, 59, 255]);
            await library(page);
            await save(page, 'phone.tif');
            await display(page, 'phone.tif');
            await pixel(page, 153.0125, -27.1125, originalPixel('phone.tif', 4, 4));
            await page.screenshot({ path: info.outputPath('actual-geotiff-chart.png') });
            await page.getByTestId('obs-credits-rollup').getByRole('button').first().click();
            await expect(page.getByText(/Private local GeoTIFF/)).toBeVisible();
            const creditPanel = page.getByRole('dialog').locator('[data-modal-sheet]');
            await expect
                .poll(() => creditPanel.evaluate((element) => Number(getComputedStyle(element).opacity)))
                .toBe(1);
            const creditGeometry = await creditPanel.evaluate((element) => ({
                rect: element.getBoundingClientRect().toJSON(),
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
                fontSize: getComputedStyle(document.documentElement).fontSize,
            }));
            expect(creditGeometry.rect.top).toBeGreaterThanOrEqual(0);
            expect(creditGeometry.rect.bottom).toBeLessThanOrEqual(780);
            expect(creditGeometry.rect.height).toBeLessThanOrEqual(
                780 - 2 * Number.parseFloat(creditGeometry.fontSize) + 1,
            );
            expect(creditGeometry.scrollWidth).toBe(width);
            expect(creditGeometry.scrollHeight).toBe(780);
            expect(Number.parseFloat(creditGeometry.fontSize)).toBeGreaterThanOrEqual(20.7);
            await page.screenshot({ path: info.outputPath('actual-chart-credits.png') });
            await page.getByRole('button', { name: 'Close', exact: true }).first().click();
            // Retire already drawn private pixels, not just an unopened list.
            await page.evaluate(() => (window as FixtureWindow).__localChart142.switchAccount('b'));
            await expect
                .poll(() => page.evaluate(() => (window as FixtureWindow).__localChart142.sourcePresent()))
                .toBe(false);
            await pixel(page, 153.0125, -27.1125, [8, 36, 59, 255]);
            await library(page);
            await expect(page.getByText('Saved charts (0/8)', { exact: true })).toBeVisible();
            await expect(page.getByText('phone.tif', { exact: true })).toHaveCount(0);
            await page.evaluate(() => (window as FixtureWindow).__localChart142.switchAccount('a'));
            await library(page);
            await expect(page.getByText('Saved charts (3/8)', { exact: true })).toBeVisible();
            expect(await page.evaluate(() => (window as FixtureWindow).__localChart142.sourcePresent())).toBe(false);
            // A real copied GeoTIFF with an unsupported original CRS must fail
            // through the actual worker, without a guessed projection or pixels.
            const unsupported = Buffer.from(readFileSync(resolve(fixtures, 'phone.tif')));
            const crsOffset = unsupported.indexOf(Buffer.from([0, 8, 0, 0, 1, 0, 230, 16]));
            expect(crsOffset).toBeGreaterThanOrEqual(0);
            unsupported.writeUInt16LE(32656, crsOffset + 6);
            await page.getByRole('radio', { name: /I created this chart/ }).check();
            await page
                .getByLabel('Choose local chart file')
                .setInputFiles({ name: 'unsupported-crs.tif', mimeType: 'image/tiff', buffer: unsupported });
            const unsupportedRow = page
                .getByRole('article')
                .filter({ has: page.getByText('unsupported-crs.tif', { exact: true }) });
            await expect(unsupportedRow).toBeVisible();
            await unsupportedRow.getByRole('button', { name: 'Display', exact: true }).click();
            await expect(page.getByRole('status')).toContainText('No datum transformation is guessed.');
            expect(await page.evaluate(() => (window as FixtureWindow).__localChart142.sourcePresent())).toBe(false);
            await unsupportedRow.getByRole('button', { name: 'Remove', exact: true }).click();
            await expect(unsupportedRow).toHaveCount(0);
            const modal = page.getByRole('dialog');
            const geometry = await modal.evaluate((element) => ({
                rect: element.getBoundingClientRect().toJSON(),
                body: document.body.scrollHeight,
                width: document.documentElement.scrollWidth,
                height: innerHeight,
                viewport: innerWidth,
                done: (element.querySelector('[data-modal-sheet-footer] button') as HTMLElement)
                    .getBoundingClientRect()
                    .toJSON(),
            }));
            expect(geometry.width).toBeLessThanOrEqual(width);
            expect(geometry.body).toBeLessThanOrEqual(780);
            expect(geometry.rect.top).toBeGreaterThanOrEqual(0);
            expect(geometry.rect.bottom).toBeLessThanOrEqual(780);
            expect(geometry.done.height).toBeGreaterThanOrEqual(44);
            expect(geometry.done.bottom).toBeLessThanOrEqual(780);
            await page.screenshot({ path: info.outputPath('actual-private-library.png') });
            await page
                .getByRole('article')
                .filter({ has: page.getByText('own-ocean.mbtiles', { exact: true }) })
                .getByRole('button', { name: 'Remove', exact: true })
                .click();
            await expect(page.getByText('own-ocean.mbtiles', { exact: true })).toHaveCount(0);
            await page.getByRole('button', { name: 'Done', exact: true }).click();
            const beforeReload = wasm.length;
            await page.reload();
            await page.waitForFunction(() => (window as FixtureWindow).__localChart142?.ready);
            await library(page);
            await expect(page.getByText('Saved charts (2/8)', { exact: true })).toBeVisible();
            expect(wasm.length, 'a closed retained catalogue after reload does not load SQLite').toBe(beforeReload);
            expect(await page.evaluate(() => (window as FixtureWindow).__localChart142.sourcePresent())).toBe(false);
            await page.evaluate(() => (window as FixtureWindow).__localChart142.switchAccount('b'));
            await library(page);
            await expect(page.getByText('Saved charts (0/8)', { exact: true })).toBeVisible();
            await expect(page.getByText('phone.tif', { exact: true })).toHaveCount(0);
            await page.evaluate(() => (window as FixtureWindow).__localChart142.switchAccount('a'));
            await library(page);
            await expect(page.getByText('Saved charts (2/8)', { exact: true })).toBeVisible();
            const final = await page.evaluate(() => {
                const s = (window as FixtureWindow).__localChart142;
                return {
                    active: s.active,
                    source: s.sourcePresent(),
                    errors: s.errors,
                    violations: s.violations,
                    credit: s.credit,
                };
            });
            await info.attach('actual-source-state', {
                body: JSON.stringify({ final, geometry, creditGeometry, wasm, errors, wan, blockedSdk }),
                contentType: 'application/json',
            });
            expect(final.active).toBe(false);
            expect(final.source).toBe(false);
            expect(final.errors).toEqual([]);
            expect(final.violations).toEqual([]);
            expect(errors).toEqual([]);
            expect(wan).toEqual([]);
        });
    }
