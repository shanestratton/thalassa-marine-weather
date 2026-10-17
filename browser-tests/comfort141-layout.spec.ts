import { expect, test, type Locator, type Page } from '@playwright/test';
import { decode } from 'fast-png';
const privateStub = `
const zero=()=>({schema:1,profile:{type:'sail',length:40,revision:1},adjustments:{size:0,steepness:0,pitching:0,cross:0},qualified:Object.fromEntries(['size','steepness','pitching','cross'].map(k=>[k,{reports:0,voyages:0}]))});
let state={boatId:'fictional',context:'fixture',epoch:'fixture',revision:1,profile:zero().profile,reports:[],preference:zero()},pending=[];const listeners=new Set();
export const subscribePrivateComfort=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
export const privateComfortSnapshot=()=>state;export const personalComfortPreference=()=>state.preference;
export const loadPrivateComfort=async()=>state;export const privateComfortViewKey=()=> 'fixture';
export const pendingPrivateComfort=async()=>({key:'fixture',rows:pending});
export const reportPrivateComfort=async level=>{pending=[{operation:'fictional-capture',level,at:Date.now()}];return 'Saved privately on this device. Fictional layout response; no upload.'};
export const deletePrivateComfort=async op=>{pending=pending.filter(v=>v.operation!==op)};
export const resetPrivateComfort=async()=>{pending=[];state={...state,reports:[],preference:zero()};listeners.forEach(fn=>fn())};`;
async function prepare(page: Page) {
    const stubs: Record<string, string> = {
        '/services/comfort/privateComfort.ts': privateStub,
        '/stores/settingsStore.ts': `const state={settings:{vessel:{type:'sail',length:40,maxWaveHeight:10},units:{waveHeight:'m'},weatherModel:'best_match',offshoreModel:'auto'}};export const useSettingsStore=Object.assign(selector=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});`,
        '/services/native/barometer.ts': `export const startLogging=async()=>{};`,
        '/services/voice/helmVoice.ts': `export const registerBarometerModule=()=>{};`,
        '/services/SmartPolarStore.ts': `export const SmartPolarStore={exportToPolarData:()=>null};`,
    };
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
        return stubs[url.pathname]
            ? route.fulfill({ contentType: 'text/javascript', body: stubs[url.pathname] })
            : route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
}
async function target(locator: Locator) {
    await locator.scrollIntoViewIfNeeded();
    const result = await locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        let left = r.left,
            right = r.right,
            top = r.top,
            bottom = r.bottom;
        for (let p = element.parentElement; p; p = p.parentElement) {
            const c = getComputedStyle(p),
                b = p.getBoundingClientRect();
            if (/(hidden|auto|scroll|clip)/.test(c.overflowX)) {
                left = Math.max(left, b.left);
                right = Math.min(right, b.right);
            }
            if (/(hidden|auto|scroll|clip)/.test(c.overflowY)) {
                top = Math.max(top, b.top);
                bottom = Math.min(bottom, b.bottom);
            }
        }
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return { width: right - left, height: bottom - top, hit: !!hit && (hit === element || element.contains(hit)) };
    });
    expect(result.width).toBeGreaterThanOrEqual(44);
    expect(result.height).toBeGreaterThanOrEqual(44);
    expect(result.hit).toBe(true);
}
async function settled(dialog: Locator) {
    await dialog.evaluate(async (element) => {
        await Promise.all(
            element
                .getAnimations({ subtree: true })
                .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                .map((a) => a.finished),
        );
    });
}
function noOpaqueTile(pixels: ReturnType<typeof decode>, cssWidth: number) {
    let longest = 0;
    for (let y = 0; y < pixels.height; y++) {
        let run = 0;
        for (let x = 0; x < pixels.width; x++) {
            const i = (y * pixels.width + x) * pixels.channels;
            run = pixels.data[i] === 0 && pixels.data[i + 1] === 0 && pixels.data[i + 2] === 0 ? run + 1 : 0;
            longest = Math.max(longest, run);
        }
    }
    // The reproduced tile was55CSS px wide. Small black glyph details may
    // exist; a contiguous16px opaque run does not belong in this fixture.
    expect(longest / (pixels.width / cssWidth)).toBeLessThan(16);
}
async function paintedPartitions(page: Page, dialog: Locator) {
    const chart = dialog.getByRole('img', { name: /Wave partitions in metres/ });
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    const pixels = decode(await page.screenshot(), { checkCrc: true });
    noOpaqueTile(pixels, page.viewportSize()!.width);
    const scale = pixels.width / page.viewportSize()!.width;
    let color = 0;
    for (let y = Math.max(0, Math.ceil(box.y * scale)); y < Math.min(pixels.height, (box.y + box.height) * scale); y++)
        for (
            let x = Math.max(0, Math.ceil(box.x * scale));
            x < Math.min(pixels.width, (box.x + box.width) * scale);
            x++
        ) {
            const i = (y * pixels.width + x) * pixels.channels;
            if (pixels.data[i] > 50 && pixels.data[i + 1] > 150 && pixels.data[i + 2] > 180) color++;
        }
    expect(color).toBeGreaterThan(100);
}
for (const width of [300, 375])
    for (const large of [false, true])
        test(`private comfort and sea partitions at ${width}px ${large ? '130%' : 'normal'}`, async ({
            page,
        }, info) => {
            await page.setViewportSize({ width, height: 667 });
            await prepare(page);
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`/e2e/fixtures/comfort141.html?large=${large ? 1 : 0}`);
            const grid = page.locator('[data-glass-fixture] [role=region]').first();
            await expect(grid).toBeVisible();
            const after = await grid.boundingBox();
            // Exact pre-change f832 source measured163px in the retained
            // separate before/after control run. This fixed guard also
            // runs in ordinary CI without a Git-history virtual module.
            expect(after!.height).toBe(163);
            expect(after!.x).toBeGreaterThanOrEqual(0);
            expect(after!.x + after!.width).toBeLessThanOrEqual(width);
            const caption = page.getByTestId('glass-sea-comfort');
            await expect(caption).toHaveText('Uncomfortable β');
            const captionRect = await caption.boundingBox();
            expect(captionRect!.x).toBeGreaterThanOrEqual(after!.x);
            expect(captionRect!.x + captionRect!.width).toBeLessThanOrEqual(after!.x + after!.width);
            const overlap = await page.getByLabel(/^Wave height/).evaluate((element) => {
                const cell = element.getBoundingClientRect(),
                    caption = document.querySelector('[data-testid="glass-sea-comfort"]')!.getBoundingClientRect();
                const readings = [...element.querySelectorAll('span')]
                    .filter((n) => n.className.includes('font-mono'))
                    .map((n) => n.getBoundingClientRect());
                return {
                    cellHeight: cell.height,
                    maxReadingBottom: Math.max(...readings.map((r) => r.bottom)),
                    captionTop: caption.top,
                };
            });
            expect(overlap.maxReadingBottom).toBeLessThanOrEqual(overlap.captionTop);
            await page.screenshot({ path: info.outputPath('glass-comfort.png') });
            await page.getByLabel(/^Wave height/).click();
            const seaDialog = page.getByRole('dialog');
            await expect(seaDialog).toBeVisible();
            await settled(seaDialog);
            const panel = seaDialog.locator('[data-modal-sheet]');
            const partitionBounds = await panel.boundingBox();
            const pixels = decode(await page.screenshot(), { checkCrc: true });
            noOpaqueTile(pixels, width);
            const scale = pixels.width / width;
            // This interior header patch was covered by the reproduced opaque
            // black compositor tile; DOM hit tests alone did not detect it.
            for (let dy = 0; dy < 4; dy++)
                for (let dx = 0; dx < 4; dx++) {
                    const x = Math.floor((partitionBounds!.x + 12 + dx) * scale);
                    const y = Math.floor((partitionBounds!.y + 40 + dy) * scale);
                    const index = (y * pixels.width + x) * pixels.channels;
                    expect(
                        Math.max(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]),
                    ).toBeGreaterThan(10);
                }
            const chart = seaDialog.getByRole('img', { name: /Wave partitions in metres/ });
            await chart.scrollIntoViewIfNeeded();
            await expect(
                seaDialog.getByRole('img', { name: /Forecast partition timeline/ }).locator('path'),
            ).toHaveCount(4);
            await expect(chart.locator('rect')).toHaveCount(4);
            await expect(seaDialog.getByText(/uncalibrated beta/)).toBeVisible();
            await expect(chart).toContainText('FROM 90° true');
            await expect(chart).toContainText('FROM 0° true');
            await expect(chart).toContainText('FROM 180° true');
            await paintedPartitions(page, seaDialog);
            await page.screenshot({ path: info.outputPath('partition-plot.png') });
            const credit = seaDialog.getByRole('link', { name: /^Marine:/ });
            await target(credit);
            await expect(credit).toContainText('© Mercator Ocean');
            await page.screenshot({ path: info.outputPath('sea-partitions.png') });
            const summary = seaDialog.getByRole('button', { name: 'Show forecast summary', exact: true });
            await target(summary);
            await summary.focus();
            await page.keyboard.press('Space');
            await expect(seaDialog.getByRole('img', { name: /Wave partitions in metres/ })).toHaveCount(0);
            await expect(seaDialog.getByText('Now', { exact: true }).first()).toBeVisible();
            await seaDialog.getByText('5-day range', { exact: true }).scrollIntoViewIfNeeded();
            await expect(seaDialog.getByText('5-day range', { exact: true })).toBeVisible();
            const back = seaDialog.getByRole('button', { name: 'Show sea partitions', exact: true });
            await target(back);
            expect(await panel.boundingBox()).toEqual(partitionBounds);
            noOpaqueTile(
                decode(await page.screenshot({ path: info.outputPath('forecast-summary.png') }), { checkCrc: true }),
                width,
            );
            await back.focus();
            await page.keyboard.press('Enter');
            await expect(seaDialog.getByRole('img', { name: /Wave partitions in metres/ })).toBeVisible();
            await paintedPartitions(page, seaDialog);
            await summary.click();
            await page.evaluate(async () => {
                const modulePath = '/services/authIdentityScope.ts';
                const { setAuthIdentityScope } = await import(modulePath);
                setAuthIdentityScope('11111111-1111-4111-8111-111111111111');
            });
            await expect(summary).toBeVisible();
            await expect(seaDialog.getByRole('img', { name: /Wave partitions in metres/ })).toBeVisible();
            await paintedPartitions(page, seaDialog);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await page.getByLabel(/^Wave height/).click();
            await expect(summary).toBeVisible();
            await paintedPartitions(page, seaDialog);
            await seaDialog.getByRole('button', { name: 'Close', exact: true }).click();
            const opener = page.getByRole('button', { name: 'Private passage comfort', exact: true });
            await target(opener);
            await opener.click();
            const dialog = page.getByRole('dialog', { name: 'Private passage comfort', exact: true });
            await expect(dialog).toBeVisible();
            await settled(dialog);
            for (const word of ['Comfortable', 'Lively', 'Uncomfortable', 'Hard going'])
                await target(dialog.getByRole('button', { name: word, exact: true }));
            await dialog.getByRole('button', { name: 'Lively', exact: true }).click();
            await expect(dialog.getByRole('status')).toContainText('Saved privately');
            const pending = dialog.getByRole('list', { name: 'Pending private comfort reports' });
            await expect(pending).toContainText('Lively');
            const remove = pending.getByRole('button', {
                name: 'Delete pending comfort report fictional-capture',
                exact: true,
            });
            await target(remove);
            await remove.click();
            await expect(pending).toHaveCount(0);
            const reset = dialog.getByRole('button', { name: 'Reset this boat’s private reports', exact: true });
            await target(reset);
            await reset.click();
            await expect(dialog.getByRole('status')).toContainText('uncalibrated again');
            await target(dialog.getByRole('button', { name: 'Done', exact: true }));
            await page.screenshot({ path: info.outputPath('private-comfort.png') });
            await dialog.getByRole('button', { name: 'Done', exact: true }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            expect(
                await page.evaluate(() => ({
                    w: document.documentElement.scrollWidth,
                    h: document.documentElement.scrollHeight,
                })),
            ).toEqual({ w: width, h: 667 });
            expect(errors).toEqual([]);
        });
test('missing marine data keeps the actual partition chart and word unknown', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 667 });
    await prepare(page);
    await page.goto('/e2e/fixtures/comfort141.html?unknown=1&large=1');
    await expect(page.getByTestId('glass-sea-comfort')).toHaveText('Comfort unknown');
    await page.getByLabel(/^Wave height/).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(
        await dialog
            .getByRole('img', { name: /Wave partitions in metres/ })
            .locator('rect')
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('width'))),
    ).toEqual(['0', '0', '0', '0']);
    await expect(dialog.getByText('Comfort unknown · uncalibrated beta')).toBeVisible();
});
