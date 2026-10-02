import { expect, test } from '@playwright/test';

/**
 * The Glass's compact conditions row keeps every reading inside its own
 * fifth. Shane 2026-09-30: under 0.25 mm the rain cell read "TRACE mm", ran
 * into the HUM cell and clipped its unit to "m". Inch figures ('<0.01"',
 * '0.50"') are just as wide.
 */
for (const width of [320, 375, 390, 430]) {
    test(`conditions row readings stay inside their cells at ${width}px`, async ({ page }, info) => {
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
        });
        await page.setViewportSize({ width, height: 1100 });
        await page.goto('/e2e/fixtures/glass-legibility.html');
        await page.evaluate(() => document.fonts.ready);

        const trace = page.getByTestId('conditions-trace-mm');
        await expect(trace.getByText('Trace', { exact: true })).toBeVisible();
        await expect(trace).not.toContainText('TRACE');
        await expect(trace).not.toContainText('Trace mm');
        await expect(page.getByTestId('conditions-inch-small').getByText('<0.01"', { exact: true })).toBeVisible();
        await expect(page.getByTestId('conditions-inch').getByText('0.50"', { exact: true })).toBeVisible();

        for (const id of ['conditions-trace-mm', 'conditions-inch-small', 'conditions-inch']) {
            const spills = await page.getByTestId(id).evaluate((section) => {
                const row = section.querySelector('.grid-cols-5');
                if (!row) return ['no row'];
                const out: string[] = [];
                for (const cell of Array.from(row.children) as HTMLElement[]) {
                    const box = cell.getBoundingClientRect();
                    for (const el of Array.from(cell.querySelectorAll('span')) as HTMLElement[]) {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0) continue;
                        if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
                            out.push(
                                `"${el.textContent}" ${r.left.toFixed(1)}–${r.right.toFixed(1)} outside ${box.left.toFixed(1)}–${box.right.toFixed(1)}`,
                            );
                    }
                }
                return out;
            });
            expect(spills, `${id} at ${width}px`).toEqual([]);
        }
        if (width === 390) {
            const path = info.outputPath('conditions-rows-390.png');
            await page.locator('[data-testid^="conditions-"]').first().locator('..').screenshot({ path });
            await info.attach('conditions-rows-390', { path, contentType: 'image/png' });
        }
    });
}

/**
 * The Glass day card fits the carousel's slot on a short phone (Shane's
 * screenshot, 2026-10-02): at 375x667 the slot is 109 px and the full card
 * needs 188, so 105 px of it was cut off. It now drops to a compact, then a
 * tight layout by its own measured height, and nothing is clipped. The tide
 * times stay on screen at every height; on the tightest it is the High/Low
 * pair (the hero header above repeats it) that is spoken only.
 */
for (const width of [375, 390]) {
    test(`day card fits its slot on short and tall phones at ${width}px`, async ({ page }) => {
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
        });
        await page.setViewportSize({ width, height: 1600 });
        await page.goto('/e2e/fixtures/glass-legibility.html?daySlots=1');
        await page.evaluate(() => document.fonts.ready);

        const expected: Record<number, string> = { 109: 'tight', 156: 'compact', 197: 'full' };
        for (const slot of [109, 156, 197]) {
            const card = page.getByTestId(`day-slot-${slot}`).getByRole('group', { name: 'Forecast for Sat 3 Oct' });
            await expect(card).toHaveAttribute('data-density', expected[slot]);
            const fit = await card.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const content = node.querySelector('[data-testid="day-card-content"]')!.getBoundingClientRect();
                return { clip: Math.max(0, content.bottom - box.bottom), slot: box.height };
            });
            expect(fit.clip, `${slot} px slot at ${width}px clips the card`).toBe(0);
            // The readings row and the tide times are always drawn, whole.
            const row = card.getByTestId('day-metrics-row');
            await expect(row.getByText('12.5', { exact: true })).toBeVisible();
            await expect(row.getByText('40', { exact: true })).toBeVisible();
            const tide = card.getByText('High 08:12 · Low 14:30', { exact: true });
            // elementFromPoint only sees the viewport.
            await card.scrollIntoViewIfNeeded();
            const tideBox = await tide.evaluate((node) => {
                const r = node.getBoundingClientRect();
                const frame = node.closest('[role="group"]')!.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {
                    spokenOnly: node.closest('.sr-only') !== null,
                    hit: !!hit && (hit === node || node.contains(hit)),
                    inside: r.top >= frame.top - 0.5 && r.bottom <= frame.bottom + 0.5,
                };
            });
            expect(tideBox, `tide line on screen in the ${slot} px slot`).toEqual({
                spokenOnly: false,
                hit: true,
                inside: true,
            });
            const highLowSpokenOnly = await card
                .getByTestId('day-high-low')
                .evaluate((node) => node.closest('.sr-only') !== null);
            expect(highLowSpokenOnly, `High/Low spoken only in the ${slot} px slot`).toBe(slot === 109);
        }
    });
}
