import { expect, test, type Page } from '@playwright/test';

/**
 * The GPS antenna aft of the bow (build 126, 126-07c), measured in the real
 * page code (e2e/fixtures/anchor-antenna.tsx):
 *
 *  - The Anchor Watch page, watching, marked at the boat's GPS with no heading:
 *    "Marked at the GPS, 12 m aft of the bow: the circle allows for it." wraps
 *    inside the stats area under the radar, in at most two lines, and pushes
 *    nothing off the screen: Weigh Anchor stays whole, the line costs the radar
 *    its own height and no more, and wherever the page fitted without it, it
 *    still fits with a usable radar.
 *  - Settings → Vessel → Dimensions: "GPS antenna to bow", its unit and its
 *    note sit inside the grid with nothing running out sideways.
 *
 * Wide fonts throughout (Verdana on a Mac, DejaVu Sans on the Linux runner), so
 * a Mac run wraps text no narrower than CI does.
 */

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket(/^(?!ws:\/\/(127\.0\.0\.1|localhost))/, (socket) => socket.close());
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/anchor-antenna.html?${query}`);
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

const watchSizes = [
    { name: '320x568', width: 320, height: 568, query: '' },
    { name: '320x568 in feet', width: 320, height: 568, query: 'units=ft' },
    { name: '375x667', width: 375, height: 667, query: '' },
    { name: '390x844', width: 390, height: 844, query: '' },
];

/** The watching view's geometry: the radar card, its stats and readout, and the line if any. */
function measureWatch(page: Page) {
    return page.evaluate(() => {
        const box = (element: Element) => element.getBoundingClientRect();
        const canvas = document.querySelector('canvas')!;
        const radar = canvas.parentElement!;
        const card = radar.parentElement!;
        const stats = radar.nextElementSibling as HTMLElement;
        const readout = card.lastElementChild!;
        const nav = box(document.querySelector('nav[aria-label="Main"]')!);
        const weigh = document.querySelector<HTMLElement>('button[aria-label="Stop Watch"]')!;
        const line = [...stats.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Marked at the GPS'));
        const c = box(card);
        const w = box(weigh);
        const issues: string[] = [];
        if (line) {
            const l = box(line);
            const s = box(stats);
            if (l.left < s.left - 0.5 || l.right > s.right + 0.5) issues.push('the line runs out of the stats area');
            if (line.scrollWidth > line.clientWidth + 1) issues.push('the line overflows sideways');
        }
        if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push('page overflows sideways');
        for (const element of card.querySelectorAll<HTMLElement>('*')) {
            const b = box(element);
            if (!b.width || !b.height) continue;
            if (b.left < c.left - 1 || b.right > c.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 20)}" escapes the card`);
        }
        const lineHeight = line ? parseFloat(getComputedStyle(line).lineHeight) : 0;
        return {
            issues,
            radar: box(canvas).height,
            /** Card content hidden below its bottom edge (it does not scroll). */
            overflow: Math.max(0, card.scrollHeight - card.clientHeight),
            whole:
                card.scrollHeight <= card.clientHeight + 1 && box(readout).bottom <= Math.min(c.bottom, nav.top) + 0.5,
            weighWhole: w.top >= 0 && w.bottom <= nav.top + 0.5 && w.height >= 43.5,
            cardAboveTabBar: c.bottom <= nav.top + 0.5,
            lines: line ? Math.round(box(line).height / lineHeight) : 0,
            /** What the line takes from the card: its height and its top margin. */
            cost: line ? box(line).height + parseFloat(getComputedStyle(line).marginTop) : 0,
        };
    });
}

test.describe('Anchor Watch, marked at the GPS', () => {
    for (const size of watchSizes) {
        test(`the line fits under the radar at ${size.name}`, async ({ page }) => {
            // The same watch marked by a phone: the page as it was, to compare.
            const plainErrors = await open(page, size, `plain&${size.query}`);
            await expect(page.getByRole('button', { name: 'Stop Watch' })).toBeVisible();
            await expect(page.getByText(/^Marked at the GPS/)).toHaveCount(0);
            const plain = await measureWatch(page);

            const errors = await open(page, size, size.query);
            const feet = size.query.includes('ft');
            await expect(
                page.getByText(
                    feet
                        ? 'Marked at the GPS, 39 ft aft of the bow: the circle allows for it.'
                        : 'Marked at the GPS, 12 m aft of the bow: the circle allows for it.',
                ),
            ).toBeVisible();
            const marked = await measureWatch(page);

            expect(marked.issues).toEqual([]);
            // Weigh Anchor is above the card: nothing in it can push it off.
            expect(marked.weighWhole).toBe(true);
            expect(marked.cardAboveTabBar).toBe(true);
            // One sentence, at most two lines in wide fonts.
            expect(marked.lines).toBeLessThanOrEqual(2);
            // It costs the radar its own height and no more: nothing else reflows.
            expect(plain.radar - marked.radar + (marked.overflow - plain.overflow)).toBeLessThanOrEqual(
                marked.cost + 1,
            );
            // Wherever the page fitted without it, it still fits; and a radar of
            // 96 px or more keeps at least 48. (At 320 x 568 in wide fonts the
            // radar is already squeezed out and the readout cut off without the
            // line: a squeeze that predates it.)
            if (plain.whole) expect(marked.whole).toBe(true);
            if (plain.radar >= 96) expect(marked.radar).toBeGreaterThanOrEqual(48);
            expect([...plainErrors, ...errors]).toEqual([]);
        });
    }
});

test.describe('Settings → Vessel → Dimensions', () => {
    for (const size of [
        { name: '320x568', width: 320, height: 568, query: 'view=vessel' },
        { name: '320x568 in feet', width: 320, height: 568, query: 'view=vessel&units=ft' },
        { name: '390x844', width: 390, height: 844, query: 'view=vessel' },
    ]) {
        test(`"GPS antenna to bow" sits in the grid at ${size.name}`, async ({ page }) => {
            const errors = await open(page, size, size.query);
            const field = page.getByRole('spinbutton', { name: 'GPS antenna to bow' });
            await field.scrollIntoViewIfNeeded();
            await expect(field).toBeVisible();
            await expect(field).toHaveValue(size.query.includes('ft') ? '39.37' : '12');
            await expect(field).toHaveAccessibleDescription(/measured back from the bow/);
            const issues = await field.evaluate((input) => {
                const found: string[] = [];
                const grid = input.closest('.grid')!;
                const g = grid.getBoundingClientRect();
                const cell = input.parentElement!.parentElement!;
                const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
                for (const element of [cell, ...cell.querySelectorAll<HTMLElement>('*')]) {
                    const b = element.getBoundingClientRect();
                    if (!b.width || !b.height) continue;
                    if (b.left < g.left - 1 || b.right > g.right + 1)
                        found.push(`${element.tagName} "${element.textContent?.trim().slice(0, 20)}" escapes the grid`);
                    if (element.scrollWidth > element.clientWidth + 1 && element.tagName !== 'SELECT')
                        found.push(`${element.tagName} overflows sideways`);
                }
                const select = cell.querySelector('select')!.getBoundingClientRect();
                const field = input.getBoundingClientRect();
                if (field.height < 43.5 || select.height < 43.5) found.push('a control under 44 px');
                if (field.width < 64) found.push(`the field is only ${field.width}px wide`);
                if (field.bottom > nav.top + 0.5) found.push('the field sits under the tab bar');
                if (document.documentElement.scrollWidth > window.innerWidth + 1) found.push('page overflows sideways');
                return found;
            });
            expect(issues).toEqual([]);
            expect(errors).toEqual([]);
        });
    }
});
