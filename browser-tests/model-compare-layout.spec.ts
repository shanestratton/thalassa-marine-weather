import { expect, test, type Page } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDevice } from '../e2e/fixtures/diary-compose-devices';

/**
 * The ten-day model comparison (W1-08): seven models, hourly to ten
 * days, a member strip and a credit per model, in the real sheet with the
 * real CSS and the app's tab bar (e2e/fixtures/model-compare.tsx). House rules
 * measured, not assumed: centred and clear of the tab bar, the whole sheet on
 * one screen with no scroll on every phone from 375x667 up and on a zoomed
 * 320x693 with either generation's insets (320x568 may scroll as a last
 * resort), nothing sideways, on EVERY tab: BARO and TEMP carry four-character
 * values, and the fixture's numbers are realistic so their ticks are too.
 *
 * env() is 0 under Playwright, so the fixture paints each device's REAL insets
 * (DIARY_DEVICES) onto the overlay and the tab bar, and every cell checks the
 * sheet's natural height against the band those insets leave:
 * H − max(16, top) − (64 + bottom + 16).
 */

const DEVICES: DiaryDevice[] = [
    DIARY_DEVICES['iphone-se'],
    DIARY_DEVICES['iphone-13-mini'],
    DIARY_DEVICES['iphone-15'],
    DIARY_DEVICES['iphone-16-pro-max'],
    DIARY_DEVICES['iphone-14-zoomed'],
    DIARY_DEVICES['iphone-16-zoomed'],
    DIARY_DEVICES['iphone-se-zoomed'],
];

/** Every tab, measured in turn: BARO and TEMP carry four-character values and
 *  ticks, so they wrap where WIND does not. */
const TABS = ['WIND', 'DIR', 'GUST', 'WAVE', 'PER.', 'BARO', 'TEMP', 'HUM', 'RAIN', 'VIS', 'UV'];

async function open(page: Page, device: DiaryDevice, wide: boolean) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.setViewportSize({ width: device.width, height: device.height });
    const query = new URLSearchParams({ tab: 'wind', top: String(device.top), bottom: String(device.bottom) });
    if (wide) query.set('fonts', 'wide');
    await page.goto(`/e2e/fixtures/model-compare.html?${query}`);
    const dialog = page.getByRole('dialog', { name: 'Model Convergence' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('path[data-model]')).toHaveCount(7);
    await expect(page.getByTestId('matrix-credit')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { errors, dialog };
}

function layoutIssues(page: Page, device: DiaryDevice) {
    return page.evaluate(({ top, bottom, mustFit }) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const sheet = document.querySelector<HTMLElement>('[aria-labelledby="model-comparison-title"]');
        if (!sheet) return ['no sheet'];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const box = sheet.getBoundingClientRect();
        const band = H - Math.max(16, top) - (64 + bottom + 16);

        if (mustFit && sheet.scrollHeight > band + 0.5)
            issues.push(`sheet needs ${sheet.scrollHeight}px, the band is ${band.toFixed(1)}px`);
        if (mustFit && sheet.scrollHeight > sheet.clientHeight + 1)
            issues.push(`sheet scrolls (${sheet.scrollHeight} > ${sheet.clientHeight})`);
        if (box.height > band + 0.5) issues.push(`sheet is taller than its band (${box.height} > ${band})`);
        if (Math.abs(box.left - (W - box.right)) > 1)
            issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
        const bandTop = Math.max(16, top);
        const middle = (box.top + box.bottom) / 2;
        if (Math.abs(middle - (bandTop + bandTop + band) / 2) > 1)
            issues.push(`not centred in its band: ${middle.toFixed(1)} vs ${(bandTop + band / 2).toFixed(1)}`);
        if (box.top < 0) issues.push(`sheet starts above the screen (${box.top})`);
        if (box.bottom > nav.top + 0.5) issues.push(`sheet runs under the tab bar (${box.bottom} > ${nav.top})`);
        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        // Four legend chips a row: a name too wide for its chip would spill into the next.
        for (const chip of sheet.querySelectorAll<HTMLElement>('[data-model-chip]'))
            if (chip.scrollWidth > chip.clientWidth + 1)
                issues.push(
                    `legend chip ${chip.dataset.modelChip} overflows (${chip.scrollWidth} > ${chip.clientWidth})`,
                );
        if (sheet.scrollWidth > sheet.clientWidth + 1) issues.push('sheet overflows sideways');
        for (const element of sheet.querySelectorAll<HTMLElement | SVGElement>(
            'h2, p, svg[role="img"], [data-testid]',
        )) {
            const rect = element.getBoundingClientRect();
            if (rect.left < box.left - 1 || rect.right > box.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" escapes the sheet`);
            if (mustFit && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5))
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" is cut off`);
        }
        return issues;
    }, device);
}

for (const device of DEVICES) {
    for (const wide of [false, true]) {
        test(`ten-day comparison fits ${device.name} (${device.width}x${device.height})${wide ? ', wide fonts' : ''}, every tab`, async ({
            page,
        }) => {
            const { errors, dialog } = await open(page, device, wide);
            // The member strip is on screen and says the count drops.
            await expect(
                dialog.getByRole('img', { name: /^Models with data: 7 from the start, .*5 from / }),
            ).toBeVisible();
            const issues: string[] = [];
            for (const tab of TABS) {
                await dialog.getByRole('button', { name: tab, exact: true }).click();
                await expect(dialog.getByRole('button', { name: tab, exact: true })).toHaveAttribute(
                    'aria-pressed',
                    'true',
                );
                for (const issue of await layoutIssues(page, device)) issues.push(`${tab}: ${issue}`);
            }
            expect(issues).toEqual([]);
            expect(errors).toEqual([]);
        });
    }
}

test('the offline state keeps the sheet whole and says why', async ({ page }) => {
    const device = DIARY_DEVICES['iphone-se'];
    await page.setViewportSize({ width: device.width, height: device.height });
    await page.goto(`/e2e/fixtures/model-compare.html?state=failed&top=${device.top}&bottom=${device.bottom}`);
    const dialog = page.getByRole('dialog', { name: 'Model Convergence' });
    await expect(dialog).toContainText('Model data unavailable');
    expect(await layoutIssues(page, device)).toEqual([]);
});
