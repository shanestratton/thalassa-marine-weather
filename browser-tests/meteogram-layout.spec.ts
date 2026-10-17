import { expect, test, type Page } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDevice } from '../e2e/fixtures/diary-compose-devices';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The point meteogram (131-02): 'All metrics' as one stacked seven-day
 * picture of a spot, in the real sheet with the real CSS and the app's tab
 * bar (e2e/fixtures/meteogram.tsx). House rules measured, not assumed, at the
 * roadmap's 375 x 667 in wide fonts (Verdana on a Mac, DejaVu Sans on the
 * Linux runner), down to 320 x 568 and up to a 393 pt phone: centred and
 * clear of the tab bar, nothing sideways, the title and Close always on
 * screen with the panels scrolling between them, the credit reachable at the
 * foot, no word under the app's 12 px floor (index.css --text-micro), and
 * the day names over the panels never touching, whatever hour of the place's
 * day the sheet opens at: a part day at either end crowded its neighbour at
 * 375 px, and a whole day's 'Wed 21' in a wide face was wider than its day
 * (the 131-02 review).
 *
 * env() is 0 under Playwright, so the fixture paints each device's REAL insets
 * onto the overlay and the tab bar, and every cell checks the sheet against
 * the band those insets leave: H − max(16, top) − (64 + bottom + 16).
 */

/** The place's hour the sheet opens at: midnight (seven whole days), then a part day at each end. */
const OPEN_AT = [0, 6, 10, 14, 18, 22];

const CELLS: { device: DiaryDevice; open: number; units: string }[] = [
    ...OPEN_AT.map((open) => ({ device: DIARY_DEVICES['iphone-se'], open, units: 'metric' })),
    { device: DIARY_DEVICES['iphone-se'], open: 10, units: 'imperial' },
    { device: DIARY_DEVICES['iphone-se-zoomed'], open: 10, units: 'metric' },
    { device: DIARY_DEVICES['iphone-se-zoomed'], open: 18, units: 'imperial' },
    { device: DIARY_DEVICES['iphone-15'], open: 10, units: 'metric' },
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
    await page.goto(`/e2e/fixtures/meteogram.html?${params}`);
    const dialog = page.getByRole('dialog', { name: 'All metrics, next 7 days' });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // The spread arrives from the stubbed proxy and adds the models' credit.
    await expect(dialog.getByTestId('meteogram-credit')).toContainText('Model spread via Open-Meteo');
    return { errors, dialog };
}

function layoutIssues(page: Page, device: DiaryDevice) {
    return page.evaluate(({ top, bottom }) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const sheet = document.querySelector<HTMLElement>('[data-meteogram-overlay] [role="dialog"]');
        if (!sheet) return ['no sheet'];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const box = sheet.getBoundingClientRect();
        const bandTop = Math.max(16, top);
        const band = H - bandTop - (64 + bottom + 16);

        if (box.height > band + 0.5) issues.push(`sheet is taller than its band (${box.height} > ${band})`);
        if (Math.abs(box.left - (W - box.right)) > 1)
            issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
        const middle = (box.top + box.bottom) / 2;
        if (Math.abs(middle - (bandTop + band / 2)) > 1)
            issues.push(`not centred in its band: ${middle.toFixed(1)} vs ${(bandTop + band / 2).toFixed(1)}`);
        if (box.top < 0) issues.push(`sheet starts above the screen (${box.top})`);
        if (box.bottom > nav.top + 0.5) issues.push(`sheet runs under the tab bar (${box.bottom} > ${nav.top})`);
        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        if (sheet.scrollWidth > sheet.clientWidth + 1) issues.push('sheet overflows sideways');

        // The title and both ways out stay whole on screen; the panels scroll between them.
        const fixed = [
            sheet.querySelector('h2'),
            sheet.querySelector('[aria-label="Close all metrics"]'),
            [...sheet.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close'),
        ];
        for (const element of fixed) {
            if (!element) {
                issues.push('the title or a Close is missing');
                continue;
            }
            const r = element.getBoundingClientRect();
            if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.height === 0)
                issues.push(`"${element.textContent?.trim() || element.getAttribute('aria-label')}" is cut off`);
        }

        // Nothing sideways: every heading, line and panel inside the sheet across.
        for (const element of sheet.querySelectorAll<HTMLElement>('h2, h3, p, section, [data-testid]')) {
            const r = element.getBoundingClientRect();
            if (r.left < box.left - 1 || r.right > box.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" escapes the sheet`);
        }

        // The 12 px floor, measured on every element that holds words.
        for (const element of sheet.querySelectorAll<Element>('*')) {
            const words = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
            const size = parseFloat(getComputedStyle(element).fontSize);
            if (words && size < 12)
                issues.push(`"${element.textContent?.trim().slice(0, 24)}" is ${size}px, under the 12 px floor`);
        }

        // The day names: inside their row, the whole days all named, each clear of the next.
        const row = sheet.querySelector('[data-testid="meteogram-days"]')!.getBoundingClientRect();
        const names = [...sheet.querySelectorAll('[data-day-name]')]
            .map((n) => ({ text: n.textContent ?? '', r: n.getBoundingClientRect() }))
            .sort((a, b) => a.r.left - b.r.left);
        if (names.length < 6) issues.push(`only ${names.length} day names: ${names.map((n) => n.text).join(', ')}`);
        names.forEach((n, i) => {
            if (n.r.left < row.left - 0.5 || n.r.right > row.right + 0.5)
                issues.push(`"${n.text}" spills out of the day row`);
            const prev = names[i - 1];
            if (prev && n.r.left - prev.r.right < 5.5)
                issues.push(`"${prev.text}" and "${n.text}" are ${(n.r.left - prev.r.right).toFixed(1)} px apart`);
        });
        return issues;
    }, device);
}

/** Scrolled to its foot, the credit is whole inside the scrolling body. */
function creditIssues(page: Page) {
    return page.evaluate(() => {
        const credit = document.querySelector<HTMLElement>('[data-testid="meteogram-credit"]');
        const body = credit?.closest<HTMLElement>('.overflow-y-auto');
        if (!credit || !body) return ['no credit or no scrolling body'];
        body.scrollTop = body.scrollHeight;
        const c = credit.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return c.top >= b.top - 0.5 && c.bottom <= b.bottom + 0.5
            ? []
            : [`the credit is cut off at the foot (${c.top}-${c.bottom} in ${b.top}-${b.bottom})`];
    });
}

for (const { device, open: openAt, units } of CELLS) {
    test(`the meteogram fits ${device.name} (${device.width}x${device.height}), wide fonts, opened at ${openAt}:30 in ${units}`, async ({
        page,
    }) => {
        const { errors, dialog } = await open(page, device, { open: String(openAt), units });
        const day = dialog.locator('[data-day-name]').first();
        await expect(day).toBeVisible();
        await expectWideFaceDrawn(day);
        const issues = await layoutIssues(page, device);
        // The last hour read from the keyboard: 'No forecast' under the waves, still fits.
        const slider = dialog.getByRole('slider', { name: 'Hour to read' });
        await slider.focus();
        await page.keyboard.press('End');
        await expect(slider).toHaveAttribute('aria-valuenow', '167');
        for (const issue of await layoutIssues(page, device)) issues.push(`last hour: ${issue}`);
        for (const issue of await creditIssues(page)) issues.push(issue);
        expect(issues).toEqual([]);
        expect(errors).toEqual([]);
    });
}
