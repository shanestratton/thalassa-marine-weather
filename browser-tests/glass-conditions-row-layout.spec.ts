import { expect, test } from '@playwright/test';
import { DIARY_DEVICES } from '../e2e/fixtures/diary-compose-devices';

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

/**
 * Build 123, W1-09: the day card's model-agreement chip and its sun & moon
 * row fit the carousel slot each phone gives the card (e2e/fixtures/
 * glass-legibility.tsx ?w109=), in normal and wide fonts: nothing cut off;
 * the chip whole, inside the card and the top thing at its own centre (its
 * words on screen, or at the tight step the glyph alone in the corner, clear
 * of the readings); the sun & moon row drawn only where there is room for it.
 * The chip must not cost a 393 pt phone its full card, nor a 375x812 its
 * condition line (there it moves to the corner: the snug step).
 */
const W109_PHONES: { key: string; width: number; app?: string }[] = [
    { key: 'iphone-15', width: 393, app: 'full' },
    { key: 'iphone-pro-max', width: 430, app: 'roomy' },
    // 162 px: the full card fits only without the chip's own line (W1-09 review),
    // so the chip goes to the corner and the condition line stays.
    { key: 'iphone-13-mini', width: 375, app: 'snug' },
    { key: 'iphone-se', width: 375, app: 'tight' },
    { key: 'iphone-16-zoomed', width: 320, app: 'tight' },
];

for (const phone of W109_PHONES) {
    for (const wide of [false, true]) {
        test(`day card agreement chip and sun & moon row fit ${phone.key} (${phone.width} px)${wide ? ', wide fonts' : ''}`, async ({
            page,
        }) => {
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
            });
            await page.setViewportSize({ width: phone.width, height: 1400 });
            await page.goto(`/e2e/fixtures/glass-legibility.html?w109=${phone.key}${wide ? '&fonts=wide' : ''}`);
            await page.evaluate(() => document.fonts.ready);
            const frames = page.getByTestId('w109-cards').locator(':scope > [data-testid^="w109-"]');
            const count = await frames.count();
            expect(count).toBeGreaterThanOrEqual(2);
            for (let i = 0; i < count; i++) {
                const frame = frames.nth(i);
                await frame.scrollIntoViewIfNeeded();
                // Let the card settle on its density (it measures, then steps).
                await page.waitForTimeout(50);
                const report = await frame.evaluate((node) => {
                    const issues: string[] = [];
                    const box = node.getBoundingClientRect();
                    const card = node.querySelector<HTMLElement>('[role="group"]')!;
                    const density = card.dataset.density ?? '';
                    const content = node.querySelector('[data-testid="day-card-content"]')!.getBoundingClientRect();
                    if (content.bottom > box.bottom + 0.5)
                        issues.push(
                            `cut off: content ends ${(content.bottom - box.bottom).toFixed(1)} px below the card`,
                        );
                    const chip = node.querySelector<HTMLElement>('[data-placement]');
                    if (!chip) return { density, issues: [...issues, 'no chip'], placement: '' };
                    const c = chip.getBoundingClientRect();
                    if (
                        c.left < box.left - 0.5 ||
                        c.right > box.right + 0.5 ||
                        c.top < box.top - 0.5 ||
                        c.bottom > box.bottom + 0.5
                    )
                        issues.push('chip outside the card');
                    const placement = chip.dataset.placement ?? '';
                    // (The corner glyph has no words; its 44 px ::before hit box overhangs by design.)
                    if (placement === 'line' && chip.scrollWidth > chip.clientWidth + 1)
                        issues.push('chip words overflow the chip');
                    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
                    if (!hit || !(hit === chip || chip.contains(hit))) issues.push('chip covered at its centre');
                    if (placement === 'line' && !/Models (agree|split)|Some spread/.test(chip.textContent ?? ''))
                        issues.push('chip words not drawn');
                    if (placement === 'corner') {
                        // Clear of every reading and word it sits beside.
                        for (const el of Array.from(
                            node.querySelectorAll<HTMLElement>('[data-testid="day-card-content"] span'),
                        )) {
                            if (el.closest('.sr-only')) continue;
                            const r = el.getBoundingClientRect();
                            if (r.width === 0) continue;
                            if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top)
                                issues.push(`corner chip overlaps "${el.textContent}"`);
                        }
                    }
                    const sky = node.querySelector<HTMLElement>('[data-testid="day-sky"]')!;
                    if (density === 'roomy') {
                        const s = sky.getBoundingClientRect();
                        if (sky.classList.contains('sr-only')) issues.push('sky row hidden at roomy');
                        if (s.bottom > box.bottom + 0.5) issues.push('sky row cut off');
                        if (sky.scrollWidth > sky.clientWidth + 1) issues.push('sky row overflows sideways');
                    } else if (!sky.classList.contains('sr-only')) issues.push(`sky row drawn at ${density}`);
                    return { density, issues, placement };
                });
                const id = await frame.getAttribute('data-testid');
                expect(report.issues, `${id} at ${phone.key}${wide ? ', wide fonts' : ''} (${report.density})`).toEqual(
                    [],
                );
                expect(report.placement).toBe(['tight', 'snug'].includes(report.density) ? 'corner' : 'line');
                if (id === 'w109-app' && phone.app) expect(report.density, `${id} at ${phone.key}`).toBe(phone.app);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        });
    }
}

/**
 * Build 123, W1-09: the header's Sun and moon chip is a button, and the sheet
 * it opens is centred on the screen, clear of the tab bar, whole on one
 * screen with no scroll on every phone from 375x667 up and on a zoomed
 * 320x693 with either generation's insets (320x568 may scroll as a last
 * resort), nothing sideways, in normal and wide fonts.
 */
const SHEET_PHONES = [
    DIARY_DEVICES['iphone-se'],
    DIARY_DEVICES['iphone-13-mini'],
    DIARY_DEVICES['iphone-15'],
    DIARY_DEVICES['iphone-16-pro-max'],
    DIARY_DEVICES['iphone-14-zoomed'],
    DIARY_DEVICES['iphone-16-zoomed'],
    DIARY_DEVICES['iphone-se-zoomed'],
];
for (const device of SHEET_PHONES) {
    for (const wide of [false, true]) {
        test(`sun and moon sheet fits ${device.name} (${device.width}x${device.height})${wide ? ', wide fonts' : ''}`, async ({
            page,
        }) => {
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
            });
            // Deterministic (fit123; CI run 37683972847 timed out opening a context).
            // The sheet's full-screen backdrop blur is redrawn in software
            // (SwiftShader) on every frame the Glass beneath it animates: the
            // alert icon's endless pulse and the metric icons held Chromium's GPU
            // process at ~7 cores on a Mac (1-3 % once still). On the two-worker
            // CI runner these tests took 11-31 s each until one got no context in
            // 30 s. Reduced motion (the app's own rule) stills the page once it
            // has drawn. And noon on the page's clock: within half an hour of the
            // 07:43 sunrise or 19:09 sunset the chip is named 'Golden hour', not
            // 'Sunrise 07:43'.
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.clock.setFixedTime(new Date(2026, 9, 7, 12, 0));
            await page.setViewportSize({ width: device.width, height: device.height });
            await page.goto(
                `/e2e/fixtures/glass-legibility.html?sunmoon=1&top=${device.top}&bottom=${device.bottom}${wide ? '&fonts=wide' : ''}`,
            );
            await page.evaluate(() => document.fonts.ready);
            const dialog = page.getByRole('dialog', { name: 'Sun and moon' });
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole('table', { name: 'Twilight' })).toBeVisible();
            // Measured once the SHEET has stopped moving: its zoom-in scales its
            // box. Only the sheet's own finite animations (and its ancestors')
            // count: the Glass under it keeps pulsing, and WebKit on the Linux
            // runner reports ~500 running page animations even with reduced
            // motion (CI run 37703071585), so waiting for the whole document
            // never ended. An infinite animation never 'finishes', so it is
            // left out.
            await page.evaluate(async () => {
                const sheet = document.querySelector<HTMLElement>('[aria-labelledby="sun-moon-title"]');
                if (!sheet) return;
                const anims: Animation[] = [...sheet.getAnimations({ subtree: true })];
                for (let el = sheet.parentElement; el; el = el.parentElement) anims.push(...el.getAnimations());
                const finite = anims.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
                await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
            });
            const issues = await page.evaluate(
                ({ top, bottom, mustFit }) => {
                    const out: string[] = [];
                    const W = window.innerWidth;
                    const H = window.innerHeight;
                    // The root font is fluid under 768 px (index.css), as in the app.
                    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
                    const sheet = document.querySelector<HTMLElement>('[aria-labelledby="sun-moon-title"]')!;
                    const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
                    const box = sheet.getBoundingClientRect();
                    const bandTop = Math.max(rem, top);
                    const band = H - bandTop - (5 * rem + bottom);
                    if (mustFit && sheet.scrollHeight > band + 0.5)
                        out.push(`sheet needs ${sheet.scrollHeight}px, the band is ${band.toFixed(1)}px`);
                    if (mustFit && sheet.scrollHeight > sheet.clientHeight + 1)
                        out.push(`sheet scrolls (${sheet.scrollHeight} > ${sheet.clientHeight})`);
                    if (box.height > band + 0.5) out.push(`sheet taller than its band (${box.height} > ${band})`);
                    if (Math.abs(box.left - (W - box.right)) > 1)
                        out.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
                    const middle = (box.top + box.bottom) / 2;
                    if (Math.abs(middle - (bandTop + band / 2)) > 1)
                        out.push(`not centred in its band: ${middle.toFixed(1)} vs ${(bandTop + band / 2).toFixed(1)}`);
                    if (box.top < 0) out.push('sheet starts above the screen');
                    if (box.bottom > nav.top + 0.5)
                        out.push(`sheet runs under the tab bar (${box.bottom} > ${nav.top})`);
                    if (sheet.scrollWidth > sheet.clientWidth + 1) out.push('sheet overflows sideways');
                    for (const el of Array.from(
                        sheet.querySelectorAll<HTMLElement>('h2, h3, p, table, [data-testid]'),
                    )) {
                        const r = el.getBoundingClientRect();
                        if (r.left < box.left - 1 || r.right > box.right + 1)
                            out.push(`${el.tagName} "${el.textContent?.trim().slice(0, 24)}" escapes the sheet`);
                        if (el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'TABLE')
                            out.push(`${el.tagName} "${el.textContent?.trim().slice(0, 24)}" overflows`);
                        if (mustFit && (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5))
                            out.push(`${el.tagName} "${el.textContent?.trim().slice(0, 24)}" is cut off`);
                    }
                    return out;
                },
                { top: device.top, bottom: device.bottom, mustFit: device.mustFit },
            );
            expect(issues).toEqual([]);
            // The chip that opens it: a button, whole in its row, the same
            // height as the alerts pill beside it (one row of pills).
            const chip = page.getByTestId('sun-moon-chip').getByRole('button', { name: /^Sunrise 07:43/ });
            await expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
            const fits = await page.getByTestId('sun-moon-chip').evaluate((wrap) => {
                const row = wrap.firstElementChild!.getBoundingClientRect();
                const chipBox = wrap.querySelector('[aria-haspopup="dialog"]')!.getBoundingClientRect();
                const pill = wrap.querySelector('button[aria-label="No forecast alerts"]')!.getBoundingClientRect();
                return {
                    inRow: chipBox.left >= row.left - 0.5 && chipBox.right <= row.right + 0.5,
                    pillHeight: Math.abs(chipBox.height - pill.height) <= 0.5,
                };
            });
            expect(fits).toEqual({ inRow: true, pillHeight: true });
        });
    }
}
