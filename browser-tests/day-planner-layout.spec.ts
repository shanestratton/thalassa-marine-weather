import { expect, test, type Page } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Plan Your Day, "Today on the water" (build 124): the sheet opens straight
 * onto today, and every screen of it fits the house rules, measured on the
 * real sheet, engine and loader fed by synthetic sources
 * (e2e/fixtures/day-planner.tsx), under the app's tab bar.
 *
 * Wide fonts throughout (Verdana on a Mac, DejaVu Sans on the Linux runner),
 * so a Mac run wraps text no narrower than CI does. Screen 1 is a centred
 * card clear of the tab bar; at ordinary text nothing scrolls, at large text
 * only the body between the header and the footer may. Two stops under 640 px
 * tall, three above; two columns in phone landscape. Every control is a 44 pt
 * target and nothing overflows sideways.
 *
 * Every mode the fixture has is measured at every size: an ordinary day at
 * Airlie Beach, a day the models split, a day over her limits, offline, no
 * position, the default boat, too late for today (opened at 16:00), Nouméa
 * (worldwide, no Queensland atlas), Tromsø under the midnight sun, and a
 * thunder afternoon (the window headline at its longest over the default-boat
 * notice; the thunder sits in its verdict cells). Phone landscape includes
 * the Plus and Pro Max phones (926 x 428, 932 x 430), two columns too. The
 * phone's own clock is set to London, half a world from Airlie and Nouméa and
 * an hour behind Tromsø, and every time a stop row shows must sit inside the
 * light on the PLACE's clock, from the earliest she can leave there.
 */

// The phone's clock, deliberately not the place's.
test.use({ timezoneId: 'Europe/London' });

/**
 * Phones as the app draws them. The fixture's root is a fixed 16 px; the app's
 * is fluid on a phone (index.css: clamp(13px, 4vw, 17px), so 13 px on a 320
 * SE, 15 on a 375, 17 on a Pro Max), and a browser draws the status bar and
 * home bar as 0. So each height here has taken off what the phone's own insets
 * add to the overlay's padding (the house approach, sign-in-layout.spec.ts): a
 * 320 x 568 SE's 20 pt status bar adds 7 over its 1rem, a 375 x 667 SE's adds
 * 5, and Shane's 430 x 932 adds 42 above and 34 below. Each sheet then gets the
 * room it gets on the phone: 483, 572 and 754 px.
 */
type Size = {
    name: string;
    width: number;
    height: number;
    query: string;
    stops: number;
    mayScroll: boolean;
    landscape?: boolean;
};
const AS_DRAWN: Record<'se' | 'se2' | 'mid' | 'shane', Size> = {
    se: { name: '320x568 as drawn', width: 320, height: 561, query: '&root=app', stops: 2, mayScroll: false },
    se2: { name: '375x667 as drawn', width: 375, height: 662, query: '&root=app', stops: 3, mayScroll: false },
    // A 390 x 844 phone: 47 pt above (31.4 over its 15.6 px 1rem) and 34 below; the sheet gets 685 px.
    mid: { name: '390x844 as drawn', width: 390, height: 779, query: '&root=app', stops: 3, mayScroll: false },
    shane: { name: '430x932 as drawn', width: 430, height: 856, query: '&root=app', stops: 3, mayScroll: false },
};

const sizes: Size[] = [
    { name: '320x568', width: 320, height: 568, query: '', stops: 2, mayScroll: false },
    { name: '375x667', width: 375, height: 667, query: '', stops: 3, mayScroll: false },
    { name: '390x844', width: 390, height: 844, query: '', stops: 3, mayScroll: false },
    // Shane's own phone (2026-10-09, Port of Airlie Marina): the sheet's spacing at its most.
    { name: '430x932', width: 430, height: 932, query: '', stops: 3, mayScroll: false },
    { name: '844x390 landscape', width: 844, height: 390, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '926x428 landscape', width: 926, height: 428, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '932x430 landscape', width: 932, height: 430, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '1024x768 split pane', width: 1024, height: 768, query: '&pane=true', stops: 3, mayScroll: false },
    { name: 'large text 320x568', width: 320, height: 568, query: '&largeText', stops: 2, mayScroll: true },
    { name: 'large text 390x844', width: 390, height: 844, query: '&largeText', stops: 3, mayScroll: true },
    // His phone again, as the app draws it: its bigger root type and its spacing at the most, in less room.
    AS_DRAWN.shane,
    // The phone most people have, as the app draws it: part way to his (build 126, 126-17).
    AS_DRAWN.mid,
];
const modes = [
    'normal',
    'split',
    'over',
    'offline',
    'no-position',
    'default-boat',
    'too-late',
    'noumea',
    'tromso',
    'thunder',
] as const;
type Mode = (typeof modes)[number];

/**
 * Each place's own clock: the facts line's light (first and last light, or
 * Tromsø's 06:00–20:00 planning day under the midnight sun) and the earliest a
 * stop row may say "Leave", now + 30 min rounded up to the hour the sweep runs
 * on. Opened at 06:30 at Airlie Beach (AEST), 07:30 at Nouméa (UTC+11), 08:00
 * at Tromsø (CEST); too late opens on tomorrow, from first light.
 */
const AIRLIE = { facts: /^☀ (05:\d\d)–(18:\d\d) · /, leaveFrom: '07:00' };
const PLACE_CLOCK: Record<
    Exclude<Mode, 'no-position'>,
    { facts: RegExp; leaveFrom: string | null; light?: string[] }
> = {
    normal: AIRLIE,
    split: AIRLIE,
    over: AIRLIE,
    offline: AIRLIE,
    'default-boat': AIRLIE,
    thunder: AIRLIE,
    'too-late': { facts: AIRLIE.facts, leaveFrom: null },
    noumea: { facts: /^☀ (05:\d\d)–(18:\d\d) · /, leaveFrom: '08:00' },
    tromso: {
        facts: /^☀ Light all day: plan capped at 14 h · No tide prediction here$/,
        leaveFrom: '09:00',
        light: ['06:00', '20:00'],
    },
};

/**
 * The visible stop rows against the place's light: each leaves between the
 * earliest she can and last light, and a row that is not over her limits is
 * home by last light (an over row may say "home 19:14": that is its reason).
 * Returns what is off the place's clock.
 */
async function placeClockIssues(page: Page, mode: Exclude<Mode, 'no-position'>): Promise<string[]> {
    const clock = PLACE_CLOCK[mode];
    const facts = (await page.getByTestId('day-plan-facts').textContent())?.trim() ?? '';
    const match = clock.facts.exec(facts);
    if (!match) return [`facts "${facts}" are not on the place's clock`];
    const [first, last] = clock.light ?? [match[1], match[2]];
    const from = clock.leaveFrom && clock.leaveFrom > first ? clock.leaveFrom : first;
    const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.today-main .today-stops > li')]
            .filter((li) => getComputedStyle(li).display !== 'none')
            .map((li) => ({
                glyph: li.querySelector('.today-stop-glyph')?.textContent?.trim() ?? '',
                line: li.querySelector('.today-stop-l2')?.textContent ?? '',
            })),
    );
    const issues: string[] = [];
    for (const { glyph, line } of rows) {
        const [leave, ...rest] = line.match(/\b\d\d:\d\d\b/g) ?? [];
        if (leave && (leave < from || leave > last)) issues.push(`"${line}": leaves ${leave}, outside ${from}–${last}`);
        if (glyph !== '✕')
            for (const time of rest) if (time > last) issues.push(`"${line}" (${glyph}): ${time} is after ${last}`);
    }
    return issues;
}

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/day-planner.html?${query.replace(/^&/, '')}`);
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectWideFaceDrawn(dialog.getByRole('heading', { name: 'Plan Your Day' }));
    return errors;
}

/** Every geometric house rule for the top card, measured in the page. Returns what broke. */
function layoutIssues(page: Page, mayScroll: boolean) {
    return page.evaluate((mayScroll) => {
        const issues: string[] = [];
        const cards = [...document.querySelectorAll<HTMLElement>('.today-card')];
        const card = cards[cards.length - 1];
        const overlay = card?.parentElement;
        if (!card || !overlay) return ['no card'];
        const box = card.getBoundingClientRect();
        const lay = overlay.getBoundingClientRect();
        const pad = getComputedStyle(overlay);
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        // Centred in what the overlay leaves it (top inset; tab bar + 1rem below).
        const left = box.left - (lay.left + parseFloat(pad.paddingLeft));
        const right = lay.right - parseFloat(pad.paddingRight) - box.right;
        const above = box.top - (lay.top + parseFloat(pad.paddingTop));
        const below = lay.bottom - parseFloat(pad.paddingBottom) - box.bottom;
        if (Math.abs(left - right) > 2) issues.push(`not centred across: ${left} vs ${right}`);
        if (Math.abs(above - below) > 2) issues.push(`not centred down: ${above} vs ${below}`);
        // 16 px clear of the tab bar's 4rem row (its 1 px top border is part of the bar).
        if (box.bottom > nav.top + 1 - 16 + 0.5)
            issues.push(`card bottom ${box.bottom} within 16 px of the tab bar ${nav.top}`);
        if (box.top < 0 || box.left < 0 || box.right > innerWidth + 0.5) issues.push('card off screen');
        const body = card.querySelector<HTMLElement>('.today-body');
        if (body && !mayScroll && body.scrollHeight - body.clientHeight > 1)
            issues.push(`body scrolls by ${body.scrollHeight - body.clientHeight}px at ordinary text`);
        for (const selector of ['.today-head', '.today-foot-row', '.today-credit', '.today-actions']) {
            const el = card.querySelector(selector);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) issues.push(`${selector} is clipped`);
        }
        for (const control of card.querySelectorAll<HTMLElement>('button, select, input')) {
            const r = control.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue; // a third stop row hidden by its tier
            // Scrolled out of the body at large text is fine; it must be whole once there.
            if (r.width < 44 - 0.5 || r.height < 44 - 0.5)
                issues.push(
                    `${control.getAttribute('aria-label') ?? control.textContent?.trim()} is ${r.width}×${r.height}`,
                );
        }
        // A link that wraps never leaves its › or ↗ alone on a line ("All places (3)" / "›").
        // (A stop row's chevron is its own centred column, not the end of a line.)
        for (const control of card.querySelectorAll<HTMLElement>('button:not(.today-stop)')) {
            if (!control.getClientRects().length) continue;
            const chars: [Text, number][] = [];
            const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null)
                for (let i = 0; i < node.data.length; i++) if (node.data[i].trim()) chars.push([node, i]);
            const last = chars[chars.length - 1];
            const before = chars[chars.length - 2];
            if (!last || !before || !/[›↗]/.test(last[0].data[last[1]])) continue;
            const bottom = ([node, i]: [Text, number]) => {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                return range.getBoundingClientRect().bottom;
            };
            if (Math.abs(bottom(last) - bottom(before)) > 4)
                issues.push(`"${control.textContent?.trim()}" leaves its ${last[0].data[last[1]]} alone on a line`);
        }
        // The stop's name is what she is looking for: the shelter word gives way, never the name.
        // Measured to the fraction of a pixel: a name 0.05 px short already draws its ellipsis,
        // and scrollWidth rounds that away.
        if (!mayScroll)
            for (const name of card.querySelectorAll<HTMLElement>('.today-stop-name')) {
                if (!name.getClientRects().length) continue;
                const text = document.createRange();
                text.selectNodeContents(name);
                if (text.getBoundingClientRect().width > name.getBoundingClientRect().width + 0.02)
                    issues.push(`the stop name "${name.textContent}" is cut`);
            }
        if (document.documentElement.scrollWidth > innerWidth) issues.push('the page scrolls sideways');
        if (card.scrollWidth > card.clientWidth + 1) issues.push('the card overflows sideways');
        return issues;
    }, mayScroll);
}

const visibleStops = (page: Page) =>
    page.evaluate(
        () =>
            [...document.querySelectorAll('.today-main .today-col-b .today-stops > li')].filter(
                (li) => getComputedStyle(li).display !== 'none',
            ).length,
    );

for (const size of sizes) {
    for (const mode of modes) {
        test(`screen 1 fits ${size.name}: ${mode}`, async ({ page }) => {
            const errors = await open(page, size, `&mode=${mode}${size.query}`);
            const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
            if (mode === 'no-position') {
                await expect(dialog.getByTestId('day-plan-headline')).toHaveText('Where are you planning from?');
                for (const name of ['This phone', 'Saved place', 'Type a place'])
                    await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
            } else {
                await expect(dialog.getByRole('list', { name: 'The day' }).getByRole('listitem')).toHaveCount(3);
                const stops = dialog.getByRole('list', { name: 'Stops' }).getByRole('button');
                await expect(stops.first()).toBeVisible();
                await expect.poll(() => visibleStops(page)).toBe(size.stops);
                // Measured once the route forecasts are in: the rows at their longest.
                await expect(stops.first().locator('.today-stop-l2')).toHaveText(
                    mode === 'offline'
                        ? /weather not checked$/
                        : /^Leave \d\d:\d\d · there \d\d:\d\d · home \d\d:\d\d$/,
                );
                await expect(dialog.getByTestId('day-plan-credit')).toContainText('Not a clearance');
            }
            if (mode === 'default-boat' || mode === 'thunder')
                await expect(
                    dialog.getByRole('button', { name: 'Typical 6 kn boat: set yours in Vessel ›' }),
                ).toBeVisible();
            if (mode === 'offline')
                await expect(dialog.getByText('Offline: light and cached tides only')).toBeVisible();
            // Tromsø's OpenStreetMap cells are three days old: used, and dated.
            if (mode === 'tromso')
                await expect(dialog.getByText('Map data from 18 Jun', { exact: true })).toBeVisible();
            if (mode === 'over') await expect(dialog.getByTestId('day-plan-headline')).toContainText('Stay put today');
            if (mode === 'thunder') {
                // In the cells it falls in; the headline keeps its own budget.
                await expect(dialog.locator('.today-cell-word', { hasText: 'Thunder' })).toHaveCount(2);
                await expect(dialog.getByTestId('day-plan-headline')).toHaveText(
                    /^Morning's your window: inside your wind limits until about 12:00\. Afternoon gets near your limits\.$/,
                );
            }
            if (mode === 'split') {
                await expect(dialog.getByTestId('day-plan-headline')).toHaveText(/^Models split /);
                // A split hour caps the part at Near: never Inside.
                await expect(dialog.locator('.today-cell[data-level="inside"]')).toHaveCount(0);
            }
            if (mode === 'too-late') {
                await expect(dialog.getByTestId('day-plan-headline')).toHaveText(
                    /^Too late for a day out: last light 18:\d\d\. Showing tomorrow\.$/,
                );
                await expect(
                    dialog.getByRole('group', { name: 'Day' }).getByRole('button', { pressed: true }),
                ).toHaveText(/Fri$/);
            }
            if (mode !== 'no-position') {
                await expect(dialog.getByTestId('day-plan-facts')).toHaveText(PLACE_CLOCK[mode].facts);
                expect(await placeClockIssues(page, mode)).toEqual([]);
            }
            if (size.landscape)
                // Two columns: the day on the left, the stops on the right.
                expect(
                    await page.evaluate(() => {
                        const a = document.querySelector('.today-main .today-col-a')?.getBoundingClientRect();
                        const b = document.querySelector('.today-main .today-col-b')?.getBoundingClientRect();
                        return !a || !b || b.left >= a.right;
                    }),
                ).toBe(true);
            expect(await layoutIssues(page, size.mayScroll)).toEqual([]);
            expect(errors).toEqual([]);
        });
    }
}

for (const size of sizes.filter((s) => !s.mayScroll)) {
    test(`the nested screens are centred and clear of the tab bar at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=default-boat${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first.locator('.today-stop-l2')).toHaveText(/^Leave /);

        // The stop's detail fits outright at ordinary text from 375 x 667 up, with
        // its leave chips, a reviewed stop's own Parks notes and both buttons; in
        // phone landscape it may scroll inside itself, buttons whole. At 320 x 568
        // the Parks notes (Maureen's Cove: northerlies, reef markers) push the
        // later rows into a scroll, the first note in view as it opens. Its times
        // are Airlie Beach's, not the phone's.
        await first.click();
        const detail = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Plot on chart' }) });
        await expect(detail.getByRole('list', { name: 'How the day goes' })).toBeVisible();
        await expect(detail.getByRole('group', { name: 'Leave at' })).toBeVisible();
        await expect(detail.locator('.today-sub')).toHaveText(/ · times in AEST$/);
        const parks = detail.locator('.today-rows li[data-parks]');
        expect(await parks.count()).toBeGreaterThan(0);
        expect(await layoutIssues(page, size.height < 640)).toEqual([]);
        expect(
            await parks.first().evaluate((note) => {
                const body = note.closest('.today-body')!.getBoundingClientRect();
                const r = note.getBoundingClientRect();
                return r.top >= body.top - 0.5 && r.bottom <= body.bottom + 0.5;
            }),
        ).toBe(true);
        await detail.getByRole('button', { name: 'Back', exact: true }).click();

        for (const [opener, name] of [
            [/^Plan from: /, 'Plan from'],
            [/^All places/, /^Places near /],
            ['Sources and limits', 'Sources and limits'],
        ] as const) {
            await dialog.getByRole('button', { name: opener }).click();
            const nested = page.getByRole('dialog', { name });
            await expect(nested).toBeVisible();
            expect(await layoutIssues(page, true)).toEqual([]);
            await nested.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(nested).toHaveCount(0);
        }
        expect(errors).toEqual([]);
    });
}

for (const size of sizes.filter((s) => !s.mayScroll)) {
    test(`a stop with no Parks notes has a detail that fits outright at ${size.name} (Nouméa)`, async ({ page }) => {
        const errors = await open(page, size, `&mode=noumea${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first.locator('.today-stop-l2')).toHaveText(/^Leave /);
        await first.click();
        const detail = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Plot on chart' }) });
        await expect(detail.getByRole('group', { name: 'Leave at' })).toBeVisible();
        await expect(detail.locator('.today-rows li[data-parks]')).toHaveCount(0);
        expect(await layoutIssues(page, size.height < 568)).toEqual([]);
        expect(errors).toEqual([]);
    });
}

for (const size of [sizes[0], sizes[2], sizes[3], AS_DRAWN.mid, AS_DRAWN.shane]) {
    test(`an overnight stay fits ${size.name}, and so does its stop's detail`, async ({ page }) => {
        const errors = await open(page, size, `&mode=normal${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        await dialog.getByRole('combobox', { name: 'Stay' }).selectOption('overnight');
        await expect(dialog.locator('.today-stay')).toContainText('Overnight');
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first.locator('.today-stop-l2')).toHaveText(
            /^Leave \d\d:\d\d · there \d\d:\d\d · (about )?[\d.]+ NM$/,
        );
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(await placeClockIssues(page, 'normal')).toEqual([]);
        // "Overnight ▾" is Stay's longest word: the day chips keep one row, whole, at their biggest type.
        expect((await breathing(page)).chips).toEqual({ oneRow: true, overlapping: false, cut: [] });

        await first.click();
        const detail = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Plot on chart' }) });
        await expect(detail.getByRole('list', { name: 'How the day goes' })).toContainText(
            /At anchor \d\d:\d\d → 09:00 tomorrow/,
        );
        // A reviewed stop's Parks notes may push it into a scroll under 640 px tall.
        expect(await layoutIssues(page, size.height < 640)).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test('Plot on chart hands the chart straight pins there and back, and closes the planner', async ({ page }) => {
    await open(page, sizes[2], '&mode=normal');
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Plot on chart' }).click();
    await expect(dialog).toHaveCount(0);
    const plotted = await page.evaluate(
        () =>
            (window as unknown as { __dayPlannerFixture: { plotted: { kind: string; points: unknown[] }[] } })
                .__dayPlannerFixture.plotted,
    );
    expect(plotted).toHaveLength(1);
    expect(plotted[0].kind).toBe('plot-day');
    expect(plotted[0].points).toHaveLength(3);
});

/**
 * Room to breathe (build 125, 125-16). Shane 2026-10-09, sending Plan Your Day
 * on his 430 x 932 phone at a marina: "can we tidy up the Plan you day layout
 * as well. it is a bit cramped for no reason". Build 124 packed screen 1 at
 * 3-4 px so it fits an SE, and every bigger phone kept the SE's spacing. The
 * spacing now grows with the room the sheet is given (its overlay, between the
 * status bar and the tab bar): an SE and phone landscape keep build 124's to
 * the pixel, on the fixture's root and on the app's own (AS_DRAWN); a tall
 * phone gets 10 px and more between the day chips, the tiles, the headline and
 * the stop rows, Shane's own as drawn too. Same content, same order, nothing
 * scrolls that did not, every target 44 pt, the card clear of the status bar
 * and the tab bar, and the type steps up a little with its order kept:
 * headline, stop name, details, credit.
 *
 * Use the screen (build 126, 126-17). Shane 2026-10-09, after the first pass:
 * "the plan your day is still a bit cramped for no reason. can we make that
 * better." Build 125's spacing and type reached their most at his phone's room
 * and stopped there, ~190 px of his 754 idle, the stop's times still the
 * smallest words on it. Screen 1 now fills most of his room (the card ~85% of
 * it as he sees it, ~55 px each side) with the type he reads up to 14-18 px
 * and 48 pt targets, and his tallest day (a thunder afternoon's three-line
 * headline over the default-boat notice, in wide fonts) still fits without a
 * scroll; a 390 x 844 phone moves part way; an SE, phone landscape and large
 * text keep build 124's to the pixel, targets 44 pt. The headline may now pass
 * the root's size, deliberately: at most 18 px (the menus' row titles are
 * 17-19 px on a Pro Max, 125-14), always bigger than the stop's name.
 */
const BUILD_124 = {
    gaps: {
        'header → day': 3,
        'day → tiles': 3,
        'tiles → headline': 3,
        'headline → light': 3,
        'light → stops': 3,
        'stop → stop': 3,
        'stops → footer': 0,
    } as Record<string, number>,
    // A 320 pt phone's card is 6 px in from its edges (the 359 px rule); every other phone's 8.
    cardPad: (width: number) => (width < 360 ? 6 : 8),
    tilePad: [2, 6],
    tileFromRule: 6,
    stopPad: [3, 6],
    // At the fixture's 16 px root; the type is in rem, so it scales with the app's root.
    type: {
        headline: 14,
        stopName: 13,
        details: 11,
        light: 11,
        credit: 11,
        tileWord: 11,
        tileWind: 13,
        // The grey label over the tile's wind, and the ⓘ and ✕ glyphs (1.125rem).
        tileLabel: 11,
        icon: 18,
    },
    // The place button, ⓘ, ✕, the day chips and Stay, and both footer links: 44 pt tall.
    targets: 44,
};

/**
 * Build 125 at 390 x 844 as drawn (R ≈ 109 px past 576, its 15.6 px root),
 * measured on 558666f0 in both engines: build 126 must pass every one.
 */
const BUILD_125_MID = {
    gaps: {
        'header → day': 8.5,
        'day → tiles': 8.5,
        'tiles → headline': 8.5,
        'headline → light': 6.1,
        'light → stops': 8.5,
        'stop → stop': 7.4,
        'stops → footer': 7.3,
    } as Record<string, number>,
    // Rounded UP to the hundredth (build 125 draws 14.853, 13.583, 11.338, 10.725, 13.288, 17.55),
    // so that build 125's own sizes fail "greater than".
    type: {
        headline: 14.86,
        stopName: 13.59,
        details: 11.34,
        light: 11.34,
        credit: 10.73,
        tileWord: 11.34,
        tileWind: 13.29,
        tileLabel: 11.34,
        icon: 17.56,
    } as Record<string, number>,
};

/** The gaps between screen 1's blocks and the sizes that set them, measured in the page. */
function breathing(page: Page) {
    return page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.today-main')!;
        const box = (selector: string) => card.querySelector(selector)!.getBoundingClientRect();
        const rows = [...card.querySelectorAll<HTMLElement>('.today-stops > li')]
            .filter((li) => getComputedStyle(li).display !== 'none')
            .map((li) => li.getBoundingClientRect());
        const between = (a: DOMRect, b: DOMRect) => Math.round((b.top - a.bottom) * 10) / 10;
        // Phone landscape puts the light and the stops in the right-hand column.
        const portrait = box('.today-col-b').top >= box('.today-col-a').bottom - 0.5;
        const gaps: Record<string, number> = {
            'header → day': between(box('.today-head'), box('.today-controls')),
            'day → tiles': between(box('.today-controls'), box('.today-verdict')),
            'tiles → headline': between(box('.today-verdict'), box('.today-headline')),
            'light → stops': between(box('.today-facts'), box('.today-stops')),
            'stop → stop': between(rows[0], rows[1]),
        };
        if (portrait) {
            gaps['headline → light'] = between(box('.today-headline'), box('.today-facts'));
            gaps['stops → footer'] = between(rows[rows.length - 1], box('.today-foot'));
        }
        const px = (el: Element | null, property: string) =>
            el ? parseFloat(getComputedStyle(el).getPropertyValue(property)) : NaN;
        const cell = card.querySelector('.today-cell')!;
        const stop = card.querySelector('.today-stop')!;
        const label = card.querySelector('.today-cell-label')!.getBoundingClientRect();
        const cellBox = cell.getBoundingClientRect();
        // The header row: the place button, ⓘ and ✕, measured as drawn.
        const place = box('.today-place');
        const [info, close] = [...card.querySelectorAll('.today-head > .today-icon')].map((b) =>
            b.getBoundingClientRect(),
        );
        const centre = (r: DOMRect) => r.top + r.height / 2;
        // The day chips and Stay: one row, none cut, none overlapping.
        const chips = [...card.querySelectorAll<HTMLElement>('.today-controls .today-chip')];
        const chipBoxes = chips.map((c) => c.getBoundingClientRect());
        return {
            root: px(document.documentElement, 'font-size'),
            portrait,
            gaps,
            cardPad: [px(card, 'padding-left'), px(card, 'padding-right'), px(card, 'padding-bottom')],
            tilePad: [px(cell, 'padding-top'), px(cell, 'padding-left')],
            tileFromRule: Math.round((label.left - cellBox.left - px(cell, 'border-left-width')) * 10) / 10,
            stopPad: [px(stop, 'padding-top'), px(stop, 'padding-left')],
            type: {
                headline: px(card.querySelector('.today-headline'), 'font-size'),
                stopName: px(card.querySelector('.today-stop-name'), 'font-size'),
                details: px(card.querySelector('.today-stop-l2'), 'font-size'),
                light: px(card.querySelector('.today-facts'), 'font-size'),
                credit: px(card.querySelector('.today-credit'), 'font-size'),
                tileWord: px(card.querySelector('.today-cell-word'), 'font-size'),
                tileWind: px(card.querySelector('.today-cell-wind'), 'font-size'),
                tileLabel: px(card.querySelector('.today-cell-label'), 'font-size'),
                icon: px(card.querySelector('.today-head > .today-icon'), 'font-size'),
            },
            // Every target she presses on screen 1 bar the stop rows (48 px tall since build 124), as drawn:
            // the place button, ⓘ and ✕, the day chips and Stay, and the footer's two links.
            targets: Object.fromEntries(
                [
                    ...card.querySelectorAll<HTMLElement>(
                        '.today-place, .today-head > .today-icon, .today-controls .today-chip, .today-foot .today-link',
                    ),
                ].map((el) => [
                    el.classList.contains('today-place')
                        ? 'place'
                        : (el.getAttribute('aria-label')?.split(',')[0] ??
                          [...el.childNodes]
                              .filter((n) => n.nodeName !== 'SELECT')
                              .map((n) => n.textContent)
                              .join('')
                              .trim()),
                    Math.round(el.getBoundingClientRect().height * 10) / 10,
                ]),
            ) as Record<string, number>,
            header: {
                infoOffCentre: Math.abs(centre(info) - centre(place)),
                closeOffCentre: Math.abs(centre(close) - centre(place)),
                placeToInfo: Math.round((info.left - place.right) * 10) / 10,
                infoToClose: Math.round((close.left - info.right) * 10) / 10,
                cardToClose: Math.round((card.getBoundingClientRect().right - close.right) * 10) / 10,
                // ⓘ and ✕ grow as squares: their focus rings stay square.
                iconsNotSquare: [info, close].some((r) => Math.abs(r.width - r.height) > 0.5),
            },
            chips: {
                oneRow: chipBoxes.every((r) => Math.abs(r.top - chipBoxes[0].top) < 1),
                overlapping: chipBoxes.some((r, i) => i > 0 && r.left < chipBoxes[i - 1].right - 0.5),
                // Its words, not the invisible Stay menu laid over it, inside the chip's border.
                cut: chips
                    .filter((c) => {
                        const words = [...c.childNodes].filter((n) => n.nodeName !== 'SELECT');
                        const range = document.createRange();
                        range.setStartBefore(words[0]);
                        range.setEndAfter(words[words.length - 1]);
                        const text = range.getBoundingClientRect();
                        const chip = c.getBoundingClientRect();
                        return text.left < chip.left + 0.5 || text.right > chip.right - 0.5;
                    })
                    .map((c) => c.textContent),
            },
            // The stop's details keep their one line: leave, there, home.
            detailsWrapped: [...card.querySelectorAll<HTMLElement>('.today-stop-l2')]
                .filter((l) => l.getClientRects().length)
                .some(
                    (l) =>
                        l.getClientRects().length > 1 || l.getBoundingClientRect().height > px(l, 'line-height') * 1.5,
                ),
            card: {
                above: Math.round(card.getBoundingClientRect().top - card.parentElement!.getBoundingClientRect().top),
                height: Math.round(card.getBoundingClientRect().height),
            },
        };
    });
}

const roomSizes = [
    { ...sizes[0], room: 'an SE' },
    { ...sizes[2], room: 'a tall phone' },
    { ...sizes[3], room: 'the tallest phone' },
    { ...sizes[4], room: 'phone landscape' },
    { ...AS_DRAWN.se, room: 'an SE' },
    { ...AS_DRAWN.se2, room: 'an SE' },
    { ...AS_DRAWN.mid, room: 'a tall phone' },
    { ...AS_DRAWN.shane, room: 'the tallest phone' },
] as const;

for (const size of roomSizes) {
    test(`room to breathe at ${size.name} (${size.room})`, async ({ page }) => {
        const errors = await open(page, size, `&mode=normal${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const stops = dialog.getByRole('list', { name: 'Stops' }).getByRole('button');
        await expect(stops.first().locator('.today-stop-l2')).toHaveText(/^Leave /);
        await expect.poll(() => visibleStops(page)).toBe(size.stops);
        const m = await breathing(page);
        // Build 124's type on this root (16 px in the fixture, 13-17 px as the app draws it).
        const type124 = Object.fromEntries(
            Object.entries(BUILD_124.type).map(([key, value]) => [key, (value * m.root) / 16]),
        ) as typeof BUILD_124.type;
        const grows = size.room === 'a tall phone' || size.room === 'the tallest phone';
        if (!grows) {
            // An SE and phone landscape: build 124's spacing and type, to the pixel.
            const today = Object.fromEntries(Object.keys(m.gaps).map((key) => [key, BUILD_124.gaps[key]]));
            expect(m.gaps).toEqual(today);
            const pad = BUILD_124.cardPad(size.width);
            expect(m.cardPad).toEqual([pad, pad, pad]);
            expect(m.tilePad).toEqual(BUILD_124.tilePad);
            expect(m.tileFromRule).toBe(BUILD_124.tileFromRule);
            expect(m.stopPad).toEqual(BUILD_124.stopPad);
            expect(m.type).toEqual(type124);
            expect(m.targets).toEqual(
                Object.fromEntries(Object.keys(m.targets).map((key) => [key, BUILD_124.targets])),
            );
        } else {
            // Every gap grows; the ones she reads down the sheet by are 10 px and more on his phone.
            for (const [key, gap] of Object.entries(m.gaps))
                expect(gap, `${key} grows`).toBeGreaterThan(BUILD_124.gaps[key]);
            if (size.room === 'the tallest phone')
                for (const key of ['day → tiles', 'tiles → headline', 'stop → stop', 'header → day'])
                    expect(m.gaps[key], key).toBeGreaterThanOrEqual(10);
            expect(m.cardPad[0]).toBeGreaterThan(BUILD_124.cardPad(size.width));
            // The tile's words stand clear of its coloured rule; the stop rows open up.
            expect(m.tilePad[0]).toBeGreaterThan(BUILD_124.tilePad[0]);
            expect(m.tileFromRule).toBeGreaterThanOrEqual(8);
            expect(m.stopPad[0]).toBeGreaterThanOrEqual(6);
            // Type steps up a little, never below build 124's, the order kept, and
            // under the menus' row titles (17-19 px on a Pro Max, 125-14).
            for (const [key, value] of Object.entries(m.type))
                expect(value, key).toBeGreaterThanOrEqual(type124[key as keyof typeof BUILD_124.type]);
            expect(m.type.headline).toBeGreaterThan(m.type.stopName);
            expect(m.type.stopName).toBeGreaterThan(m.type.details);
            expect(m.type.details).toBeGreaterThanOrEqual(m.type.credit);
            // The tile's wind, its one number, stands clear above the grey label over it, as in builds 124 and 125.
            expect(m.type.tileWind - m.type.tileLabel).toBeGreaterThanOrEqual(1.75);
            // The headline stays under the menus' row titles (17-19 px on a Pro Max, 125-14).
            // Changed on purpose in build 126 (126-17): it was "≤ the root and < 17 px".
            expect(m.type.headline).toBeLessThanOrEqual(18);
            // The targets grow with the room, to 48 pt at the most.
            for (const [key, height] of Object.entries(m.targets)) {
                expect(height, key).toBeGreaterThan(BUILD_124.targets);
                expect(height, key).toBeLessThanOrEqual(48);
            }
            if (size.name === AS_DRAWN.mid.name) {
                // The phone most people have moves part way: past build 125 in every gap and every size.
                for (const [key, gap] of Object.entries(m.gaps))
                    expect(gap, `${key} past build 125`).toBeGreaterThan(BUILD_125_MID.gaps[key]);
                for (const [key, value] of Object.entries(m.type)) {
                    expect(value, `${key} past build 124`).toBeGreaterThan(type124[key as keyof typeof type124]);
                    expect(value, `${key} past build 125`).toBeGreaterThan(BUILD_125_MID.type[key]);
                }
            }
            if (size.name === AS_DRAWN.shane.name) {
                // His phone uses its screen: the card fills most of his room and stays centred in it
                // (above counts the overlay's own 1rem), the words he acts on read bigger, every
                // target is 48 pt, and the blocks he reads down the sheet by stand 15 px and more apart.
                expect(m.card.height).toBeGreaterThanOrEqual(630);
                expect(m.card.above).toBeGreaterThanOrEqual(32);
                expect(m.card.above).toBeLessThanOrEqual(70);
                expect(m.type.headline).toBeGreaterThanOrEqual(17.5);
                expect(m.type.stopName).toBeGreaterThanOrEqual(16.5);
                expect(m.type.details).toBeGreaterThanOrEqual(14);
                expect(m.type.tileWord).toBeGreaterThanOrEqual(14);
                expect(m.type.tileWind).toBeGreaterThanOrEqual(14.9);
                expect(m.type.icon).toBeGreaterThanOrEqual(19.75);
                expect(m.type.light).toBeGreaterThanOrEqual(13.5);
                expect(m.type.credit).toBeGreaterThanOrEqual(12);
                for (const [key, height] of Object.entries(m.targets)) expect(height, key).toBeGreaterThanOrEqual(47.5);
                for (const key of ['day → tiles', 'tiles → headline', 'stops → footer'])
                    expect(m.gaps[key], key).toBeGreaterThanOrEqual(15);
                expect(m.gaps['stop → stop']).toBeGreaterThanOrEqual(11.5);
            }
        }
        // ⓘ and ✕ sit on the place button's centre line, evenly spaced, and ✕ is
        // never hard against the card's edge.
        expect(m.header.infoOffCentre).toBeLessThanOrEqual(1);
        expect(m.header.closeOffCentre).toBeLessThanOrEqual(1);
        expect(Math.abs(m.header.placeToInfo - m.header.infoToClose)).toBeLessThanOrEqual(1);
        expect(m.header.cardToClose).toBeGreaterThanOrEqual(BUILD_124.cardPad(size.width) + 1);
        expect(m.header.iconsNotSquare).toBe(false);
        // Stay never squeezes the day chips: one row, whole, apart.
        expect(m.chips).toEqual({ oneRow: true, overlapping: false, cut: [] });
        expect(m.detailsWrapped).toBe(false);
        // Clear of the status bar (the overlay's top inset) and, in layoutIssues, the tab bar.
        expect(m.card.above).toBeGreaterThanOrEqual(16);
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(errors).toEqual([]);
    });
}
