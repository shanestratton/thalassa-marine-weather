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

/**
 * Polar day and night (build 123, W1-06): the header's sun chip says 'No sunset'
 * / 'No sunrise' where it showed '--:--' that never cleared.
 * In wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner) the words
 * stay on one line inside the chip, and the chip is no wider than the
 * two-time chip it stands in for, so the alerts pill beside it keeps its room.
 */
for (const width of [320, 375, 390]) {
    test(`polar sun chip fits where the two times did at ${width}px, wide fonts`, async ({ page }, info) => {
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
        });
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                const wide = document.createElement('style');
                wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                document.head.append(wide);
            });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/e2e/fixtures/glass-legibility.html?sun=polar');
        await page.evaluate(() => document.fonts.ready);
        await expect(page.getByTestId('sun-chip-up').getByText('No sunset', { exact: true })).toBeVisible();
        await expect(page.getByTestId('sun-chip-down').getByText('No sunrise', { exact: true })).toBeVisible();

        const measure = (id: string) =>
            page.getByTestId(id).evaluate((wrap) => {
                const row = wrap.firstElementChild!.getBoundingClientRect();
                const chip = wrap.querySelector('[role="group"]')!.getBoundingClientRect();
                const words = wrap.querySelector('[data-sun-all-day] span[aria-hidden="true"]');
                const w = words?.getBoundingClientRect();
                const font = words ? getComputedStyle(words).fontFamily : '';
                return {
                    chipWidth: chip.width,
                    chipInRow: chip.left >= row.left - 0.5 && chip.right <= row.right + 0.5,
                    wordsInChip: !w || (w.left >= chip.left - 0.5 && w.right <= chip.right + 0.5),
                    wordsLines: w ? Math.round(w.height / 16) : 1,
                    font,
                };
            });
        const pending = await measure('sun-chip-pending');
        for (const id of ['sun-chip-up', 'sun-chip-down']) {
            const m = await measure(id);
            expect(m.font, `${id}: the house wide-font rule`).toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
            expect(m.chipInRow, `${id} chip inside the header row at ${width}px`).toBe(true);
            expect(m.wordsInChip, `${id} words inside the chip at ${width}px`).toBe(true);
            expect(m.wordsLines, `${id} words on one line at ${width}px`).toBe(1);
            expect(m.chipWidth, `${id} chip no wider than the two-time chip at ${width}px`).toBeLessThanOrEqual(
                pending.chipWidth + 0.5,
            );
        }
        if (width === 320) {
            const path = info.outputPath('sun-chip-rows-320.png');
            await page.getByTestId('sun-chip-rows').screenshot({ path });
            await info.attach('sun-chip-rows-320', { path, contentType: 'image/png' });
        }
    });
}

/**
 * FIT ONLY (build 123, W1-07). SWELL 2 now reads in the skipper's own Seas
 * unit, so both the metric and the imperial readings have to sit inside
 * their third of the offshore grid; and the day card's period caption, which
 * read '{N}s swell' and ran 4 px past its fifth at 320 px in wide fonts with
 * two digits, is now just '{N}s' on screen. Both are checked on the narrowest
 * phone in wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner).
 *
 * The fixture hard-codes the readings (the widest each tile draws), so this
 * proves they fit, NOT that production draws them: the arrow, unit and
 * wording rules are pinned against the real components in
 * tests/GlassSeaTiles.test.tsx and tests/GlassSeaWording.test.tsx.
 */
for (const seas of ['m', 'ft'] as const) {
    for (const width of [320, 375, 390]) {
        test(`offshore grid and day card readings fit their cells in ${seas} at ${width}px, wide fonts`, async ({
            page,
        }) => {
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
            });
            await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => {
                    const wide = document.createElement('style');
                    wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                    document.head.append(wide);
                });
            });
            await page.setViewportSize({ width, height: 1100 });
            await page.goto(`/e2e/fixtures/glass-legibility.html${seas === 'ft' ? '?seas=ft' : ''}`);
            await page.evaluate(() => document.fonts.ready);

            const grid = page.getByTestId('secondary-metrics');
            // The fixture drew the variant asked for (so the widths below are its).
            const swell2 = grid.getByText('SWELL 2', { exact: true }).locator('xpath=../..');
            await expect(swell2.locator('span').last()).toHaveText(seas);

            const spills = await grid.evaluate((section) => {
                const out: string[] = [];
                for (const row of Array.from(section.querySelectorAll('.grid-cols-3'))) {
                    for (const cell of Array.from(row.children) as HTMLElement[]) {
                        const box = cell.getBoundingClientRect();
                        for (const el of Array.from(cell.querySelectorAll('span')) as HTMLElement[]) {
                            const r = el.getBoundingClientRect();
                            if (r.width === 0) continue;
                            if (
                                r.left < box.left - 0.5 ||
                                r.right > box.right + 0.5 ||
                                r.top < box.top - 0.5 ||
                                r.bottom > box.bottom + 0.5
                            )
                                out.push(
                                    `"${el.textContent}" ${r.left.toFixed(1)}–${r.right.toFixed(1)} × ${r.top.toFixed(1)}–${r.bottom.toFixed(1)} outside ${box.left.toFixed(1)}–${box.right.toFixed(1)} × ${box.top.toFixed(1)}–${box.bottom.toFixed(1)}`,
                                );
                        }
                    }
                }
                return out;
            });
            expect(spills, `offshore grid in ${seas} at ${width}px`).toEqual([]);

            // The day card's readings, the two-digit '14s' period among them,
            // stay inside their fifth of the row.
            const day = page.getByTestId('daily-summary');
            await expect(day.getByText('14s', { exact: true })).toBeVisible();
            const daySpills = await day.getByTestId('day-metrics-row').evaluate((row) => {
                const out: string[] = [];
                for (const cell of Array.from(row.children) as HTMLElement[]) {
                    const box = cell.getBoundingClientRect();
                    for (const el of Array.from(cell.querySelectorAll('span')) as HTMLElement[]) {
                        const r = el.getBoundingClientRect();
                        // Spoken-only words are clipped to a pixel by design.
                        if (r.width === 0 || el.closest('.sr-only')) continue;
                        if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
                            out.push(
                                `"${el.textContent}" ${r.left.toFixed(1)}–${r.right.toFixed(1)} outside ${box.left.toFixed(1)}–${box.right.toFixed(1)}`,
                            );
                    }
                }
                return out;
            });
            expect(daySpills, `day card readings in ${seas} at ${width}px`).toEqual([]);
        });
    }
}
