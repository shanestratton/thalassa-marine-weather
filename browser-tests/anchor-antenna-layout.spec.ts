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

/**
 * The watching view settles once the Pi probe has said why there is no Pi
 * offer ("Pi watch unavailable", a line above the card): measured before it,
 * the card is a line taller, and a busy machine (WebKit, 2026-10-10) measured
 * one page before it and the other after.
 */
async function settled(page: Page) {
    await expect(page.getByText('Pi watch unavailable')).toBeVisible();
}

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
            await settled(page);
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
            await settled(page);
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

/**
 * Build 126 (126-07d): the anchor is down inside a charted area where
 * anchoring is a problem. The page is armed the way a skipper arms it, the real
 * check reads a synthetic chart cell on the fixture page (FICTIONAL areas off
 * Lyttelton), and an amber note says which area, what it is, where that comes
 * from, and that the watch is on. Under the radar in reading order, drawn over
 * the stats and the readout, never over the radar or its Move anchor chip: the
 * radar keeps every pixel (it is already squeezed out at 320 x 568, in
 * landscape and at large text before any note), nothing reflows, the status
 * badge stays clear, Weigh Anchor and the tab bar are untouched, every control
 * in the note is 44 px and reachable (a long list scrolls inside it). Once read
 * (ten seconds, the page's clock run forward) it folds to a chip on the radar
 * opposite Move anchor and the live Distance readout is uncovered again; the
 * chip opens it, and Dismiss gives the card back. &area=none arms the same
 * watch with no chart cell there: a quiet "No chart areas loaded here…" line,
 * then, dismissed, the card to compare against (126-07d review).
 */
const areaSizes = [
    { name: '320x568', width: 320, height: 568, query: '' },
    { name: '375x667', width: 375, height: 667, query: '' },
    { name: '844x390 landscape', width: 844, height: 390, query: '' },
    { name: 'large text 390x844', width: 390, height: 844, query: 'largeText' },
];

async function armHere(page: Page) {
    await page.getByRole('button', { name: 'Drop anchor and arm Anchor Watch' }).press('Enter');
    await page.getByRole('button', { name: 'Play test alarm' }).click();
    await page.getByRole('button', { name: 'Stop test alarm' }).click();
    await page.getByRole('button', { name: 'Confirm alarm was audible' }).click();
    await page.getByRole('button', { name: 'Confirm selection' }).click();
    await expect(page.getByRole('button', { name: 'Stop Watch' })).toBeVisible();
}

/** The watching view, with the note if any: the radar, the card, its badge, Weigh Anchor and the note. */
function measureNote(page: Page) {
    return page.evaluate(() => {
        const box = (element: Element) => element.getBoundingClientRect();
        const canvas = document.querySelector('canvas')!;
        const radar = canvas.parentElement!;
        const card = radar.parentElement!;
        const badge = card.firstElementChild!;
        const nav = box(document.querySelector('nav[aria-label="Main"]')!);
        const weigh = document.querySelector<HTMLElement>('button[aria-label="Stop Watch"]')!;
        const note = document.querySelector<HTMLElement>('[data-testid="anchor-area-note"]');
        const chip = document.querySelector<HTMLElement>('[data-testid="anchor-area-chip"]');
        const moveChip = [...radar.querySelectorAll<HTMLElement>('button')].find(
            (button) => button.textContent?.trim() === 'Move anchor',
        );
        /** The live Distance reading: is it on top where it is drawn (not under a note)? */
        const distanceLabel = [...card.querySelectorAll<HTMLElement>('div')].find(
            (element) => element.children.length === 0 && /^(Last-Known )?Distance$/i.test(element.textContent ?? ''),
        );
        const distance = distanceLabel?.nextElementSibling as HTMLElement | undefined;
        const onTop = (element: HTMLElement | undefined) => {
            if (!element) return false;
            const b = box(element);
            const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
            return hit === element || element.contains(hit);
        };
        const c = box(card);
        const w = box(weigh);
        const issues: string[] = [];
        if (document.documentElement.scrollWidth > window.innerWidth + 1) issues.push('page overflows sideways');
        for (const element of card.querySelectorAll<HTMLElement>('*')) {
            const b = box(element);
            if (!b.width || !b.height) continue;
            if (b.left < c.left - 1 || b.right > c.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 20)}" escapes the card`);
        }
        if (note) {
            const n = box(note);
            if (n.top < box(badge).bottom - 0.5) issues.push('the note covers the status badge');
            if (n.top < c.top - 0.5 || n.bottom > Math.min(c.bottom, nav.top) + 0.5)
                issues.push('the note is not inside the card, above the tab bar');
            if (note.scrollWidth > note.clientWidth + 1) issues.push('the note overflows sideways');
            const scrolledTo = note.scrollTop;
            for (const button of note.querySelectorAll<HTMLElement>('button')) {
                // A long list scrolls inside the note: each control is scrolled to, as a finger would.
                button.scrollIntoView({ block: 'nearest' });
                const b = box(button);
                const name = button.getAttribute('aria-label') || button.textContent?.trim();
                if (b.height < 43.5) issues.push(`${name}: ${b.height}px tall`);
                if (name === 'Dismiss the chart area note' && b.width < 43.5) issues.push(`${name}: ${b.width}px wide`);
                if (b.top < box(note).top - 0.5 || b.bottom > box(note).bottom + 0.5) issues.push(`${name} is cut off`);
                const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
                if (!(hit === button || button.contains(hit))) issues.push(`${name} is covered by ${hit?.tagName}`);
            }
            note.scrollTop = scrolledTo;
        }
        if (chip && chip.getClientRects().length > 0) {
            const k = box(chip);
            const r = box(radar);
            if (k.height < 43.5) issues.push(`the chip is ${k.height}px tall`);
            if (k.width < 43.5) issues.push(`the chip is ${k.width}px wide`);
            if (k.left < r.left - 0.5 || k.right > r.right + 0.5) issues.push('the chip runs out of the radar');
            if (k.top < r.top - 0.5 || k.bottom > r.bottom + 0.5) issues.push('the chip is not inside the radar');
            if (k.top < box(badge).bottom - 0.5) issues.push('the chip covers the status badge');
            if (chip.scrollWidth > chip.clientWidth + 1) issues.push('the chip overflows sideways');
            if (!onTop(chip)) issues.push('the chip is covered');
            if (moveChip) {
                const m = box(moveChip);
                if (k.left < m.right && m.left < k.right && k.top < m.bottom && m.top < k.bottom)
                    issues.push('the chip overlaps Move anchor');
            }
        }
        return {
            issues,
            radar: box(canvas).height,
            cardHeight: c.height,
            cardOverflow: Math.max(0, card.scrollHeight - card.clientHeight),
            weighWhole: w.top >= 0 && w.bottom <= nav.top + 0.5 && w.height >= 43.5,
            cardAboveTabBar: c.bottom <= nav.top + 0.5,
            noteScrolls: note ? note.scrollHeight > note.clientHeight + 1 : false,
            /** The live distance is drawn and nothing lies over it. */
            distanceOnTop: onTop(distance),
            /** Move anchor can be tapped where it is drawn. */
            moveOnTop: onTop(moveChip),
            /** Room on the radar for its chips: 3.5 rem (the page's container query). */
            radarRoom: box(radar).height >= 3.5 * parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
    });
}

test.describe('Anchor Watch, inside a charted area (126-07d)', () => {
    for (const size of areaSizes) {
        for (const area of ['cable', 'many'] as const) {
            test(`the ${area} note fits at ${size.name}, folds to a chip once read, and the radar keeps its height`, async ({
                page,
            }, info) => {
                const query = (charted: string) => ['plain', `area=${charted}`, size.query].filter(Boolean).join('&');
                const noneErrors = await open(page, size, query('none'));
                await armHere(page);
                // No chart cell there: said quietly, never a silence that reads as clear.
                const note = page.getByTestId('anchor-area-note');
                await expect(note).toHaveText('No chart areas loaded here to check the anchor against.');
                await expect(page.getByText('Your anchor watch is on.')).toHaveCount(0);
                await settled(page);
                const quiet = await measureNote(page);
                expect(quiet.issues).toEqual([]);
                await note.getByRole('button', { name: 'Dismiss the chart area note' }).click();
                await expect(note).toHaveCount(0);
                const none = await measureNote(page);

                // The page's own clock, so a read can be run forward instead of waited out.
                await page.clock.install();
                const errors = await open(page, size, query(area));
                await armHere(page);
                await expect(note).toBeVisible();
                if (area === 'cable') {
                    await expect(note).toContainText(
                        'Inside a submarine cable area (official chart). Anchoring here can damage the cable and your anchor.',
                    );
                } else {
                    // The most serious first: closed to entry, then the cable; the pipeline waits behind "+1 more".
                    await expect(note).toContainText(
                        'Inside Fixture Exclusion Zone, a restricted area: entry prohibited (official chart).',
                    );
                    await expect(note).toContainText('Inside a submarine cable area (official chart).');
                    await expect(note).not.toContainText('pipeline');
                }
                await expect(note).toContainText('Your anchor watch is on.');
                await settled(page);
                const label = `anchor-area-${area}-${size.name.replace(/ /g, '-')}`;
                const path = info.outputPath(`${label}.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(label, { path, contentType: 'image/png' });
                const noted = await measureNote(page);

                expect(noted.issues).toEqual([]);
                expect(noted.weighWhole).toBe(true);
                expect(noted.cardAboveTabBar).toBe(true);
                // The note never lies over Move anchor (wherever Move anchor can be tapped at all).
                expect(noted.moveOnTop).toBe(none.moveOnTop);
                // Drawn over the stats and the readout: the radar keeps every pixel, and nothing reflows.
                expect(Math.abs(noted.radar - none.radar)).toBeLessThanOrEqual(0.5);
                expect(Math.abs(noted.cardHeight - none.cardHeight)).toBeLessThanOrEqual(0.5);
                expect(Math.abs(noted.cardOverflow - none.cardOverflow)).toBeLessThanOrEqual(0.5);

                if (area === 'many') {
                    // "+1 more" shows the rest in place; the note scrolls inside itself if it must.
                    await note.getByRole('button', { name: '+1 more' }).click();
                    await expect(note).toContainText('Inside a pipeline area (official chart).');
                    const expanded = await measureNote(page);
                    expect(expanded.issues).toEqual([]);
                    expect(Math.abs(expanded.radar - none.radar)).toBeLessThanOrEqual(0.5);
                }

                // Read: folded to a chip on the radar, and the live distance is uncovered again.
                // Where the radar is squeezed out it has no room for the chip, which
                // would lie over the status badge: there the read note leaves none.
                await page.clock.fastForward(10_000);
                await expect(note).toHaveCount(0);
                const chip = page.getByTestId('anchor-area-chip');
                await expect(chip).toBeAttached();
                if (!none.radarRoom) {
                    await expect(chip).toBeHidden();
                    const squeezed = await measureNote(page);
                    expect(squeezed.issues).toEqual([]);
                    expect(squeezed.distanceOnTop).toBe(none.distanceOnTop);
                    expect(squeezed.moveOnTop).toBe(none.moveOnTop);
                    expect([...noneErrors, ...errors]).toEqual([]);
                    return;
                }
                await expect(chip).toBeVisible();
                await expect(chip).toHaveAccessibleName(
                    area === 'cable'
                        ? 'Chart area note: a submarine cable area'
                        : 'Chart area note: Fixture Exclusion Zone, a restricted area: entry prohibited',
                );
                const foldedPath = info.outputPath(`${label}-folded.png`);
                await page.screenshot({ path: foldedPath, animations: 'disabled' });
                await info.attach(`${label}-folded`, { path: foldedPath, contentType: 'image/png' });
                const folded = await measureNote(page);
                expect(folded.issues).toEqual([]);
                expect(folded.moveOnTop).toBe(none.moveOnTop);
                expect(Math.abs(folded.radar - none.radar)).toBeLessThanOrEqual(0.5);
                expect(Math.abs(folded.cardHeight - none.cardHeight)).toBeLessThanOrEqual(0.5);
                expect(folded.distanceOnTop).toBe(none.distanceOnTop);

                // The chip opens the note again; Dismiss: gone, chip and all, and the card is as it was.
                await chip.click();
                await expect(note).toBeVisible();
                await expect(chip).toHaveCount(0);
                await note.getByRole('button', { name: 'Dismiss the chart area note' }).click();
                await expect(note).toHaveCount(0);
                await expect(chip).toHaveCount(0);
                const dismissed = await measureNote(page);
                expect(Math.abs(dismissed.radar - none.radar)).toBeLessThanOrEqual(0.5);
                expect(dismissed.distanceOnTop).toBe(none.distanceOnTop);
                expect([...noneErrors, ...errors]).toEqual([]);
            });
        }
    }
});
