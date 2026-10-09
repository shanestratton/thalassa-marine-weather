import { expect, test, type Page } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDevice } from '../e2e/fixtures/diary-compose-devices';

/**
 * The Sounding sheet (build 125, SND): a skew-T of ECMWF's upper air with an
 * hour picker, six plain-words readings, the honesty line and the credit, in
 * the real sheet with the real CSS and the app's tab bar
 * (e2e/fixtures/sounding-sheet.tsx). House rules measured, not assumed:
 * centred and clear of the tab bar, the whole sheet on one screen with no
 * scroll on every phone down to 320 x 568, nothing sideways, the diagram
 * scaling to its slot rather than scrolling, every label inside it, and no
 * word anywhere in the sheet (the diagram's labels too) under the app's
 * 12 px floor (index.css --text-micro).
 *
 * Wide fonts throughout (Verdana on a Mac, DejaVu Sans on the Linux runner).
 * The longest wording is off California in °F, feet and mph: a strong
 * inversion ("14.4 °F warmer at 925 hPa"), no jet, five-digit heights.
 *
 * env() is 0 under Playwright, so the fixture paints each device's REAL insets
 * onto the overlay and the tab bar, and every cell checks the sheet against
 * the band those insets leave: H − max(16, top) − (64 + bottom + 16).
 */

const DEVICES: DiaryDevice[] = [
    DIARY_DEVICES['iphone-se-zoomed'],
    DIARY_DEVICES['iphone-se'],
    DIARY_DEVICES['iphone-13-mini'],
    DIARY_DEVICES['iphone-15'],
    DIARY_DEVICES['iphone-16-pro-max'],
    DIARY_DEVICES['iphone-14-zoomed'],
];

const SCENARIOS = [
    { scenario: 'inversion', units: 'imperial' },
    { scenario: 'trades', units: 'metric' },
    { scenario: 'gale', units: 'kmh' },
    // A saturated southern-hemisphere front: the long "moist through the column" headline.
    { scenario: 'front', units: 'metric' },
];

async function open(page: Page, device: DiaryDevice, query: Record<string, string>) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.setViewportSize({ width: device.width, height: device.height });
    const params = new URLSearchParams({
        fonts: 'wide',
        top: String(device.top),
        bottom: String(device.bottom),
        ...query,
    });
    await page.goto(`/e2e/fixtures/sounding-sheet.html?${params}`);
    const dialog = page.getByRole('dialog', { name: 'Sounding' });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return { errors, dialog };
}

function layoutIssues(page: Page, device: DiaryDevice) {
    return page.evaluate(({ top, bottom }) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const sheet = document.querySelector<HTMLElement>('[aria-labelledby="sounding-title"]');
        if (!sheet) return ['no sheet'];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const box = sheet.getBoundingClientRect();
        const band = H - Math.max(16, top) - (64 + bottom + 16);

        if (sheet.scrollHeight > band + 0.5) issues.push(`sheet needs ${sheet.scrollHeight}px, the band is ${band}px`);
        if (sheet.scrollHeight > sheet.clientHeight + 1)
            issues.push(`sheet scrolls (${sheet.scrollHeight} > ${sheet.clientHeight})`);
        if (box.height > band + 0.5) issues.push(`sheet is taller than its band (${box.height} > ${band})`);
        if (Math.abs(box.left - (W - box.right)) > 1)
            issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
        const bandTop = Math.max(16, top);
        const middle = (box.top + box.bottom) / 2;
        if (Math.abs(middle - (bandTop + band / 2)) > 1)
            issues.push(`not centred in its band: ${middle.toFixed(1)} vs ${(bandTop + band / 2).toFixed(1)}`);
        if (box.top < 0) issues.push(`sheet starts above the screen (${box.top})`);
        if (box.bottom > nav.top + 0.5) issues.push(`sheet runs under the tab bar (${box.bottom} > ${nav.top})`);
        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        if (sheet.scrollWidth > sheet.clientWidth + 1) issues.push('sheet overflows sideways');

        const chart = sheet.querySelector<SVGSVGElement>('svg[role="img"]');
        if (chart) {
            const c = chart.getBoundingClientRect();
            if (c.height < 120) issues.push(`the diagram is squeezed to ${c.height.toFixed(0)}px`);
            if (c.left < box.left - 0.5 || c.right > box.right + 0.5) issues.push('the diagram escapes the sheet');
            // Every label, tick and barb inside the diagram's own box.
            for (const mark of chart.querySelectorAll<SVGGraphicsElement>('text, [data-barb]')) {
                const r = mark.getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1)
                    issues.push(
                        `"${mark.textContent?.trim() || mark.getAttribute('data-barb')}" spills out of the diagram`,
                    );
            }
        }
        // The 12 px floor, measured on every element that holds words (an SVG <title> is never drawn).
        for (const element of sheet.querySelectorAll<Element>('*')) {
            if (element.closest('title')) continue;
            const words = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
            const size = parseFloat(getComputedStyle(element).fontSize);
            if (words && size < 12)
                issues.push(`"${element.textContent?.trim().slice(0, 24)}" is ${size}px, under the 12 px floor`);
        }
        for (const element of sheet.querySelectorAll<HTMLElement>('h2, p, dt, dd, [data-testid]')) {
            const rect = element.getBoundingClientRect();
            if (rect.left < box.left - 1 || rect.right > box.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" escapes the sheet`);
            if (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" is cut off`);
            if (element.scrollWidth > element.clientWidth + 1 && element.tagName !== 'DIV')
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" overflows its box`);
        }
        return issues;
    }, device);
}

for (const device of DEVICES) {
    for (const { scenario, units } of SCENARIOS) {
        test(`the sounding fits ${device.name} (${device.width}x${device.height}), wide fonts, ${scenario} in ${units}`, async ({
            page,
        }) => {
            const { errors, dialog } = await open(page, device, { scenario, units });
            await expect(dialog.getByTestId('sounding-headline')).toBeVisible();
            await expect(dialog.getByTestId('sounding-credit')).toContainText('Forecast data: ECMWF');
            await expect(dialog.getByRole('img', { name: /skew-t/i })).toBeVisible();
            const issues = await layoutIssues(page, device);
            // The last hour on the picker, scrolled to and chosen, still fits.
            const chips = dialog.locator('[data-hour-chip]');
            await chips.last().scrollIntoViewIfNeeded();
            await chips.last().click();
            await expect(chips.last()).toHaveAttribute('aria-pressed', 'true');
            for (const issue of await layoutIssues(page, device)) issues.push(`last hour: ${issue}`);
            expect(issues).toEqual([]);
            expect(errors).toEqual([]);
        });
    }
}

for (const palette of ['day', 'night']) {
    test(`the ${palette} palette fits 320x568 in wide fonts and keeps every line visible`, async ({ page }) => {
        const device = DIARY_DEVICES['iphone-se-zoomed'];
        const { errors, dialog } = await open(page, device, { scenario: 'gale', units: 'kmh', palette });
        await expect(dialog.getByRole('img', { name: /skew-t/i })).toBeVisible();
        expect(await layoutIssues(page, device)).toEqual([]);
        // Each line is drawn with a visible stroke, not the page background.
        const strokes = await dialog.evaluate((el) =>
            ['temperature', 'dewpoint', 'parcel'].map((line) => {
                const path = el.querySelector(`[data-line="${line}"]`);
                return path ? getComputedStyle(path).stroke : 'missing';
            }),
        );
        for (const stroke of strokes) expect(stroke).toMatch(/^rgb/);
        expect(new Set(strokes).size).toBeGreaterThanOrEqual(palette === 'night' ? 1 : 3);
        expect(errors).toEqual([]);
    });
}

for (const state of ['unavailable', 'needs-update', 'error']) {
    test(`the ${state} state keeps the sheet whole and says why`, async ({ page }) => {
        const device = DIARY_DEVICES['iphone-se-zoomed'];
        const { dialog } = await open(page, device, { state });
        await expect(dialog.getByRole('status')).toBeVisible();
        expect(await layoutIssues(page, device)).toEqual([]);
    });
}
