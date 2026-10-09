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
 * only the body between the header and the footer may. On a tall room (past
 * an SE's 576 px) a day with more to say than the room holds scrolls only its
 * stops, in their own area under a fade (126-17b). Two stops under 640 px
 * tall, three above; two columns in phone landscape. Every control is a 44 pt
 * target and nothing overflows sideways. Tall narrow windows (375 x 1100,
 * 320 x 1000) are measured too: the type the room allows, held to what one
 * line of their width holds.
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
 * A stop's times once its route forecasts are in, short so they can be big
 * (126-17c; Shane, offered "07:00 → 10:28 · back 15:57": "your pick"):
 * leave → arrive · back home, or an overnight's "· about 22 NM". VoiceOver
 * hears them in words, "Leave 07:00, arrive 10:28, back home 15:57".
 */
const TIMES = /^\d\d:\d\d → \d\d:\d\d · /;

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
const AS_DRAWN: Record<'se' | 'se2' | 'mid' | 'shane' | 'slim' | 'slimmer', Size> = {
    se: { name: '320x568 as drawn', width: 320, height: 561, query: '&root=app', stops: 2, mayScroll: false },
    se2: { name: '375x667 as drawn', width: 375, height: 662, query: '&root=app', stops: 3, mayScroll: false },
    // A 390 x 844 phone: 47 pt above (31.4 over its 15.6 px 1rem) and 34 below; the sheet gets 685 px.
    mid: { name: '390x844 as drawn', width: 390, height: 779, query: '&root=app', stops: 3, mayScroll: false },
    shane: { name: '430x932 as drawn', width: 430, height: 856, query: '&root=app', stops: 3, mayScroll: false },
    // Tall, narrow windows (iPad Slide Over, a resizable window): a big phone's room at an SE's width (126-17b).
    slim: { name: '375x1100 as drawn', width: 375, height: 1100, query: '&root=app', stops: 3, mayScroll: false },
    slimmer: { name: '320x1000 as drawn', width: 320, height: 1000, query: '&root=app', stops: 3, mayScroll: false },
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
    // Tall and narrow: the type the room allows, held to what one line of the width holds (126-17b).
    AS_DRAWN.slim,
    AS_DRAWN.slimmer,
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
 * stop row may leave (its first time), now + 30 min rounded up to the hour the
 * sweep runs on. Opened at 06:30 at Airlie Beach (AEST), 07:30 at Nouméa
 * (UTC+11), 08:00 at Tromsø (CEST); too late opens on tomorrow, from first light.
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
                    mode === 'offline' ? /weather not checked$/ : /^\d\d:\d\d → \d\d:\d\d · back \d\d:\d\d$/,
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

// The nested screens at every phone size; the tall narrow windows are screen 1's width guards'
// (126-17b), and a nested list that fills their room sits its 1rem (13-15 px there) over the tab bar.
const nestedSizes = sizes.filter((s) => !s.mayScroll && s !== AS_DRAWN.slim && s !== AS_DRAWN.slimmer);
for (const size of nestedSizes) {
    test(`the nested screens are centred and clear of the tab bar at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=default-boat${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first.locator('.today-stop-l2')).toHaveText(TIMES);

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
        await expect(first.locator('.today-stop-l2')).toHaveText(TIMES);
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
        await expect(first.locator('.today-stop-l2')).toHaveText(/^\d\d:\d\d → \d\d:\d\d · (about )?[\d.]+ NM$/);
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

/**
 * Build 126's first pass (126-17), measured on 545a94df in both engines in wide
 * fonts, rounded UP to the hundredth (gaps to the tenth) so that 126-17's own
 * sizes fail "greater than": 126-17b must pass every one at 390 x 844 and
 * 430 x 932 as drawn.
 */
const BUILD_126_17 = {
    mid: {
        gaps: {
            'header → day': 11.1,
            'day → tiles': 11.1,
            'tiles → headline': 11.1,
            'headline → light': 7.4,
            'light → stops': 8.7,
            'stop → stop': 8.7,
            'stops → footer': 10,
        } as Record<string, number>,
        // 15.619, 14.666, 12.486, 12.18, 11.381, 12.486, 13.441, 11.546, 18.753 as drawn.
        type: {
            headline: 15.62,
            stopName: 14.67,
            details: 12.49,
            light: 12.19,
            credit: 11.39,
            tileWord: 12.49,
            tileWind: 13.45,
            tileLabel: 11.55,
            icon: 18.76,
        } as Record<string, number>,
        more: { place: 14.37, chip: 13.45, link: 13.45 } as Record<string, number>,
        targets: 46.52,
        row: 52.94,
    },
    shane: {
        gaps: {
            'header → day': 16,
            'day → tiles': 16,
            'tiles → headline': 16,
            'headline → light': 10,
            'light → stops': 12,
            'stop → stop': 12,
            'stops → footer': 16,
        } as Record<string, number>,
        type: {
            headline: 18,
            stopName: 17,
            details: 14.5,
            light: 14,
            credit: 12.75,
            tileWord: 14.5,
            tileWind: 15,
            tileLabel: 13,
            icon: 20,
        } as Record<string, number>,
        more: { place: 16, chip: 15, link: 15 } as Record<string, number>,
        targets: 48,
        row: 63.83,
    },
    // The tall narrow windows, rounded DOWN (they are floors here): the sizes that are not held
    // by width. Light and stop name sat at their 126-17 most (14/17 px) where the times are
    // width-bound at 12.44 and 10.29 px.
    slim: {
        gaps: {
            'header → day': 16,
            'day → tiles': 16,
            'tiles → headline': 16,
            'headline → light': 10,
            'light → stops': 12,
            'stop → stop': 12,
            'stops → footer': 16,
        } as Record<string, number>,
        type: { headline: 18, stopName: 17, details: 12.44, light: 14, credit: 11.25, icon: 20 } as Record<
            string,
            number
        >,
        more: { place: 15.95, chip: 15, link: 15 } as Record<string, number>,
        targets: 48,
        row: 60,
    },
    slimmer: {
        gaps: {
            'header → day': 16,
            'day → tiles': 16,
            'tiles → headline': 16,
            'headline → light': 10,
            'light → stops': 12,
            'stop → stop': 12,
            'stops → footer': 16,
        } as Record<string, number>,
        type: { headline: 17.6, stopName: 16.85, details: 10.29, light: 13.53, credit: 9.75, icon: 18.43 } as Record<
            string,
            number
        >,
        more: { place: 13.62, chip: 12.98, link: 12.98 } as Record<string, number>,
        targets: 48,
        row: 57,
    },
};

/**
 * 126-17b's times on the phone most people have, measured on bd9c9ed4 in both
 * engines in wide fonts and rounded UP to the hundredth, so that 126-17b's own
 * size fails "greater than": the short times line (126-17c) must pass it.
 */
const BUILD_126_17B = { mid: { details: 13.38 } };

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
            // To the first stop row, not the list's box: on a tall room the list is its own
            // scroller, a few px of room above its first row for the row's focus ring (126-17b).
            'light → stops': between(box('.today-facts'), rows[0]),
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
            // The rest of what she reads on screen 1 (126-17b): the place, the day chips, the footer links.
            more: {
                place: px(card.querySelector('.today-place'), 'font-size'),
                chip: px(card.querySelector('.today-chip'), 'font-size'),
                link: px(card.querySelector('.today-link'), 'font-size'),
            },
            rowHeights: rows.map((r) => Math.round(r.height * 10) / 10),
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
                // The room the overlay gives it: between the status bar and the tab bar's 1rem.
                room: Math.round(
                    card.parentElement!.clientHeight -
                        px(card.parentElement, 'padding-top') -
                        px(card.parentElement, 'padding-bottom'),
                ),
            },
            // Nothing scrolls on an ordinary day: not the page, not the body, not the stops.
            scrolls: {
                page: document.documentElement.scrollHeight > innerHeight + 0.5,
                stops: (() => {
                    const list = card.querySelector<HTMLElement>('.today-col-b .today-stops')!;
                    return list.scrollHeight - list.clientHeight > 1;
                })(),
            },
        };
    });
}

/**
 * Screen 1 in a mode too tall for its room at the bigger type (126-17b): only
 * the stops scroll, inside their own area, under a fade. Measures the list,
 * then scrolls it to its end and measures again: the last stop must sit whole
 * above the fade, and nothing outside the list may have moved. Returns what
 * broke, whether the list scrolls, and which fade it has: where a scroll
 * timeline runs (both engines here, iOS 26) the card's colour laid over the
 * list's foot (its ::after) while a stop is still below; elsewhere (iOS 17-18,
 * or this spec with the timeline rule taken out) a mask over the list's own
 * foot room.
 */
function stopsScrollIssues(page: Page) {
    return page.evaluate(async () => {
        const issues: string[] = [];
        const card = document.querySelector<HTMLElement>('.today-main')!;
        const list = card.querySelector<HTMLElement>('.today-col-b .today-stops')!;
        const body = card.querySelector<HTMLElement>('.today-body')!;
        const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        // The fade runs on the list's scroll timeline: let it start before reading it (a list that
        // does not scroll leaves its timeline inactive and the animation pending, so not for ever).
        await Promise.race([
            Promise.all(list.getAnimations({ subtree: true }).map((animation) => animation.ready)),
            new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
        await frame();
        const fixed = [
            '.today-head',
            '.today-controls',
            '.today-verdict',
            '.today-headline',
            '.today-facts',
            '.today-foot',
        ];
        const where = () =>
            fixed.map((selector) => {
                const r = card.querySelector(selector)!.getBoundingClientRect();
                return [selector, Math.round(r.top * 10) / 10, Math.round(r.bottom * 10) / 10] as const;
            });
        if (document.documentElement.scrollHeight > innerHeight + 0.5) issues.push('the page scrolls');
        if (document.documentElement.scrollWidth > innerWidth) issues.push('the page scrolls sideways');
        if (body.scrollHeight - body.clientHeight > 1)
            issues.push(`the body scrolls by ${body.scrollHeight - body.clientHeight}px`);
        const box = card.getBoundingClientRect();
        for (const [selector, top, bottom] of where())
            if (top < box.top - 0.5 || bottom > box.bottom + 0.5) issues.push(`${selector} is cut`);
        const scrolls = list.scrollHeight - list.clientHeight > 1;
        const style = getComputedStyle(list);
        const overlay = getComputedStyle(list, '::after');
        const timeline = !['none', 'normal'].includes(overlay.content) && /gradient/.test(overlay.backgroundImage);
        const mask = style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
        // The fade over the list's foot now: how tall, and how strong (the overlay's opacity; a mask is whole).
        const fadeNow = () =>
            timeline
                ? { height: parseFloat(overlay.height), strength: parseFloat(overlay.opacity) }
                : { height: parseFloat(style.paddingBottom), strength: /gradient/.test(mask) ? 1 : 0 };
        const items = [...list.querySelectorAll<HTMLElement>(':scope > li')].filter(
            (li) => getComputedStyle(li).display !== 'none',
        );
        const words = (li: HTMLElement) => li.querySelector('.today-stop-text')!.getBoundingClientRect();
        if (scrolls) {
            if (!timeline && !/gradient/.test(mask)) issues.push(`the stops scroll with no fade (${mask})`);
            const first = items[0].getBoundingClientRect();
            if (list.clientHeight < first.height * 1.25) issues.push(`only ${list.clientHeight}px of stops show`);
            // A cue that there is more, wherever the list's foot falls: the first stop not wholly
            // in view shows some of its words, and they fade under the foot. A list that hides
            // only its foot room or a stop's padding hides no words and needs none.
            const view = list.getBoundingClientRect();
            const fade = fadeNow();
            const next = items.find((li) => words(li).bottom > view.bottom + 2);
            if (next) {
                const peek = view.bottom - words(next).top;
                const under =
                    Math.min(words(next).bottom, view.bottom) - Math.max(words(next).top, view.bottom - fade.height);
                if (peek < 4) issues.push(`the next stop is hidden with none of its words in view (${peek}px)`);
                if (fade.height < 10 || fade.strength < 0.25 || under < 4)
                    issues.push(
                        `the next stop's words (${under}px) do not fade under the list's ${fade.height}px foot at ${fade.strength}`,
                    );
            }
        }
        const before = JSON.stringify(where());
        list.scrollTop = list.scrollHeight;
        await frame();
        if (JSON.stringify(where()) !== before)
            issues.push(`scrolling the stops moved the sheet: ${before} → ${JSON.stringify(where())}`);
        // The last stop, whole, inside the list and above whatever fade is left at the end
        // (none where a scroll timeline runs; the static fade lies over the foot room).
        const view = list.getBoundingClientRect();
        const end = fadeNow();
        if (timeline && end.strength > 0.01) issues.push(`the fade is still there at the end (${end.strength})`);
        const fade = end.strength > 0.01 ? end.height : 0;
        const last = items[items.length - 1].getBoundingClientRect();
        if (last.top < view.top - 0.5 || last.bottom > view.bottom - fade + 0.5)
            issues.push(
                `the last stop (${last.top}–${last.bottom}) is not whole in ${view.top}–${view.bottom} above a ${fade}px fade`,
            );
        list.scrollTop = 0;
        await frame();
        // Every target she presses, the stop rows too, stays 44 pt.
        for (const control of card.querySelectorAll<HTMLElement>('button, select')) {
            const r = control.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (r.width < 44 - 0.5 || r.height < 44 - 0.5)
                issues.push(
                    `${control.getAttribute('aria-label') ?? control.textContent?.trim()} is ${r.width}×${r.height}`,
                );
        }
        return { issues, scrolls, timeline };
    });
}

/** How much light the words in a screenshot give off: the sum over its pixels of their luminance above the card's. */
function ink(page: Page, png: Buffer) {
    return page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, image.width, image.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4)
            sum += Math.max(0, 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] - 30);
        return sum;
    }, png.toString('base64'));
}

/**
 * The stops' fade as PAINTED, not as computed (126-17b's review: WebKit, the
 * iPhone's engine, computed a mask that a scroll timeline moved and never
 * painted it, so a stop was cut off at full brightness). Screenshots the list's
 * foot, as tall as the fade, with the fade and without it, at rest and scrolled
 * to the end: at rest it must dim the words there, at the end it must be gone.
 */
async function paintedFade(page: Page) {
    const list = page.locator('.today-main .today-col-b > .today-stops');
    const settle = () =>
        page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const foot = async () => {
        const clip = await list.evaluate((el) => {
            const view = el.getBoundingClientRect();
            const overlay = getComputedStyle(el, '::after');
            const height = ['none', 'normal'].includes(overlay.content)
                ? parseFloat(getComputedStyle(el).paddingBottom)
                : parseFloat(overlay.height);
            return { x: view.x, y: view.bottom - height, width: view.width, height };
        });
        const faded = await page.screenshot({ clip });
        const plain = await page.addStyleTag({
            content:
                '.today-main .today-col-b > .today-stops { -webkit-mask-image: none !important; mask-image: none !important; }' +
                ' .today-main .today-col-b > .today-stops::after { visibility: hidden !important; }',
        });
        await settle();
        const unfaded = await page.screenshot({ clip });
        await plain.evaluate((node) => (node as HTMLStyleElement).remove());
        await settle();
        return { faded: await ink(page, faded), plain: await ink(page, unfaded) };
    };
    await list.evaluate((el) => (el.scrollTop = 0));
    await settle();
    const rest = await foot();
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await settle();
    const end = await foot();
    await list.evaluate((el) => (el.scrollTop = 0));
    await settle();
    return { rest, end };
}

/** iOS 17-18 on the fixture: the scroll-timeline rules taken out, so the static fade is what draws. */
function withoutScrollTimelines(page: Page) {
    return page.evaluate(() => {
        let removed = 0;
        const walk = (rules: CSSStyleSheet | CSSGroupingRule) => {
            for (let i = rules.cssRules.length - 1; i >= 0; i--) {
                const rule = rules.cssRules[i];
                if (rule instanceof CSSSupportsRule && rule.conditionText.includes('animation-timeline')) {
                    rules.deleteRule(i);
                    removed++;
                } else if (rule instanceof CSSGroupingRule) walk(rule);
            }
        };
        for (const sheet of document.styleSheets) {
            try {
                walk(sheet);
            } catch {
                // A sheet from another origin: not ours.
            }
        }
        return removed;
    });
}

/**
 * The widest words the engine can put in a tile and a stop row (126-17b), put
 * there and measured, then put back: "≈ NW 18–22" (compass8 writes two letters
 * at most, two-digit knots; the widest of the ✓ ≈ ✕ readings in the wide face,
 * 7.08 px per px of type), "No forecast", "Afternoon", and a stop row's widest
 * line: an overnight stay's times ("… · about 22 NM", wider than "… · back
 * 15:57"), and since the times are short (126-17c) a stop whose weather is not
 * checked, "About 22 NM · weather not checked" (offline; 18.05 px per px of
 * type in the wide face, the times 15.19). Each keeps one line and is whole;
 * the stop's name is whole and its shelter word gives way first. Returns what
 * broke.
 */
function widestIssues(page: Page) {
    return page.evaluate(() => {
        const issues: string[] = [];
        const card = document.querySelector<HTMLElement>('.today-main')!;
        const widest: [string, string][] = [
            ['.today-cell-label', 'Afternoon'],
            ['.today-cell-wind', '≈ NW 18–22'],
            ['.today-cell-wind', '✕ NW 88–88'],
            ['.today-cell-word', 'No forecast'],
            ['.today-stop-l2', '07:00 → 10:28 · about 22 NM'],
            ['.today-stop-l2', 'About 22 NM · weather not checked'],
        ];
        const oneLine = (el: HTMLElement) =>
            el.getClientRects().length === 1 &&
            el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 1.5;
        const whole = (el: HTMLElement) => {
            const text = document.createRange();
            text.selectNodeContents(el);
            const r = text.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        };
        for (const [selector, words] of widest)
            for (const el of card.querySelectorAll<HTMLElement>(selector)) {
                if (!el.getClientRects().length) continue;
                const keep = [...el.childNodes];
                el.textContent = words;
                // The tile's words inside its padding; a stop's times inside the row's text column.
                const room = el.parentElement!.getBoundingClientRect();
                const text = document.createRange();
                text.selectNodeContents(el);
                const r = text.getBoundingClientRect();
                if (!oneLine(el)) issues.push(`"${words}" wraps in ${selector}`);
                else if (!whole(el) || r.right > room.right + 0.5) issues.push(`"${words}" is cut in ${selector}`);
                el.replaceChildren(...keep);
            }
        for (const name of card.querySelectorAll<HTMLElement>('.today-stop-name')) {
            if (!name.getClientRects().length) continue;
            const text = document.createRange();
            text.selectNodeContents(name);
            if (text.getBoundingClientRect().width > name.getBoundingClientRect().width + 0.02)
                issues.push(`the stop name "${name.textContent}" is cut`);
            if (!oneLine(name.parentElement!)) issues.push(`"${name.parentElement!.textContent}" wraps`);
        }
        return issues;
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
        await expect(stops.first().locator('.today-stop-l2')).toHaveText(TIMES);
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
            // The order kept: headline > stop name > times ≥ light > credit (126-17b: the light
            // no longer passes the times, as it did at 390 x 844 on the fixture's root in 126-17).
            expect(m.type.headline).toBeGreaterThan(m.type.stopName);
            expect(m.type.stopName).toBeGreaterThan(m.type.details);
            expect(m.type.details).toBeGreaterThanOrEqual(m.type.light);
            expect(m.type.light).toBeGreaterThan(m.type.credit);
            // The tile's wind, its one number, stands clear above the grey label over it, as in builds 124 and 125.
            expect(m.type.tileWind - m.type.tileLabel).toBeGreaterThanOrEqual(1.75);
            // Changed on purpose in build 126 (126-17): it was "≤ the root and < 17 px"; 126-17b
            // ("ok, make plan your day even bigger!!"): at most 21 px, was 18.
            expect(m.type.headline).toBeLessThanOrEqual(21);
            // The targets grow with the room, to 52 pt at the most (126-17b; 48 in 126-17).
            for (const [key, height] of Object.entries(m.targets)) {
                expect(height, key).toBeGreaterThan(BUILD_124.targets);
                expect(height, key).toBeLessThanOrEqual(52);
            }
            // On an ordinary day nothing scrolls: not the page, not the body, not the stops.
            expect(m.scrolls).toEqual({ page: false, stops: false });
            if (size.name === AS_DRAWN.mid.name) {
                // The phone most people have moves part way: past build 125 in every gap and every
                // size, and past 126-17 in every gap, size, target and stop row.
                const was = BUILD_126_17.mid;
                for (const [key, gap] of Object.entries(m.gaps)) {
                    expect(gap, `${key} past build 125`).toBeGreaterThan(BUILD_125_MID.gaps[key]);
                    expect(gap, `${key} past 126-17`).toBeGreaterThan(was.gaps[key]);
                }
                for (const [key, value] of Object.entries(m.type)) {
                    expect(value, `${key} past build 124`).toBeGreaterThan(type124[key as keyof typeof type124]);
                    expect(value, `${key} past build 125`).toBeGreaterThan(BUILD_125_MID.type[key]);
                    expect(value, `${key} past 126-17`).toBeGreaterThan(was.type[key]);
                }
                for (const [key, value] of Object.entries(m.more))
                    expect(value, `${key} past 126-17`).toBeGreaterThan(was.more[key]);
                for (const [key, height] of Object.entries(m.targets))
                    expect(height, `${key} past 126-17`).toBeGreaterThan(was.targets);
                for (const height of m.rowHeights) expect(height, 'stop row past 126-17').toBeGreaterThan(was.row);
                // The times past 126-17b's, now that they are short (126-17c).
                expect(m.type.details, 'times past 126-17b').toBeGreaterThan(BUILD_126_17B.mid.details);
            }
            if (size.name === AS_DRAWN.shane.name) {
                // His phone filled (126-17b, "ok, make plan your day even bigger!!"): the card is at
                // least 700 px of his 754 px room, centred in it (above counts the overlay's own
                // 1rem), every word bigger than 126-17's, every target 52 pt, the stop rows 70 px
                // and more, the blocks he reads down the sheet by 16.5 px and more apart.
                const was = BUILD_126_17.shane;
                expect(m.card.room).toBeGreaterThanOrEqual(750);
                expect(m.card.height).toBeGreaterThanOrEqual(700);
                expect(m.card.above).toBeGreaterThanOrEqual(17);
                expect(m.card.above).toBeLessThanOrEqual(17 + (m.card.room - 700) / 2 + 1);
                for (const [key, value] of Object.entries(m.type))
                    expect(value, `${key} past 126-17`).toBeGreaterThan(was.type[key]);
                for (const [key, value] of Object.entries(m.more))
                    expect(value, `${key} past 126-17`).toBeGreaterThan(was.more[key]);
                for (const [key, gap] of Object.entries(m.gaps))
                    expect(gap, `${key} past 126-17`).toBeGreaterThan(was.gaps[key]);
                expect(m.type.headline).toBeGreaterThanOrEqual(20);
                expect(m.type.stopName).toBeGreaterThanOrEqual(18.5);
                // The tile's words are as big as one line holds, in the widest face (widestIssues):
                // ~15.1 px across his 430 pt, not the plan's 18. The times, short since 126-17c
                // ("07:00 → 10:28 · back 15:57"), reach the plan's ~16.5 px; the light keeps 126-17b's.
                expect(m.type.details).toBeGreaterThanOrEqual(16);
                expect(m.type.light).toBeGreaterThanOrEqual(15.1);
                expect(m.type.tileWord).toBeGreaterThanOrEqual(15.05);
                expect(m.type.tileWind).toBeGreaterThanOrEqual(15.05);
                expect(m.type.credit).toBeGreaterThanOrEqual(12.9);
                expect(m.type.icon).toBeGreaterThanOrEqual(21.5);
                expect(m.more.place).toBeGreaterThanOrEqual(17.5);
                expect(m.more.chip).toBeGreaterThanOrEqual(16.5);
                expect(m.more.link).toBeGreaterThanOrEqual(16.5);
                for (const [key, height] of Object.entries(m.targets)) expect(height, key).toBeGreaterThanOrEqual(51.5);
                for (const height of m.rowHeights) expect(height, 'stop row').toBeGreaterThanOrEqual(70);
                for (const key of ['header → day', 'day → tiles', 'tiles → headline', 'stops → footer'])
                    expect(m.gaps[key], key).toBeGreaterThanOrEqual(16.5);
                expect(m.gaps['stop → stop']).toBeGreaterThanOrEqual(12.5);
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

/**
 * Bigger still (build 126, 126-17b). Shane 2026-10-09, after the 126-17
 * before/after at his phone size: "ok, make plan your day even bigger!!".
 * Screen 1 now fills a big phone's room (at least 700 of his 754 px) with
 * 21 px headlines, 19 px stop names and 52 pt targets. A day with one line
 * more under the light (a notice: default-boat, which every skipper without a
 * boat set sees, offline; Tromsø's dated map line) takes 126-17's rhythm on his
 * room and keeps all three stops in view, unscrolled, here as on the phone most
 * people have. A day with still more to say than his room holds at that type
 * (a thunder afternoon's three-line headline over the default-boat notice, in
 * wide fonts) no longer forces every size down: only the stops scroll, inside
 * their own area, with a fade at its foot that is painted, not only computed
 * (WebKit, the iPhone's engine, never painted 126-17b's first fade); the
 * header, the day chips, the tiles, the headline, the light and the footer stay
 * put, and the last stop scrolls whole into view. Never the page, never the
 * body, never a stop hidden with no cue. An SE, phone landscape and large text
 * keep the body as the only scroller, as before.
 */
for (const size of [AS_DRAWN.shane, AS_DRAWN.mid])
    for (const mode of ['thunder', 'default-boat', 'offline', 'tromso'] as const)
        test(`only the stops scroll, and only on a day too long for the room, at ${size.name}: ${mode}`, async ({
            page,
        }) => {
            const errors = await open(page, size, `&mode=${mode}${size.query}`);
            const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
            const stops = dialog.getByRole('list', { name: 'Stops' }).getByRole('button');
            await expect(stops.first().locator('.today-stop-l2')).toHaveText(
                mode === 'offline' ? /weather not checked$/ : TIMES,
            );
            await expect.poll(() => visibleStops(page)).toBe(3);
            const { issues, scrolls, timeline } = await stopsScrollIssues(page);
            expect(issues).toEqual([]);
            // Both engines here run scroll timelines (as iOS 26 does): the fade is the card's colour laid over the foot.
            expect(timeline).toBe(true);
            // Only the tallest day, on his phone in wide fonts, takes the scroll path; a notice or a
            // dated map line keeps all three stops in view, unscrolled (126-17b's review: those
            // scrolled at 430 in the first pass, in SF too, the third stop under the fade).
            expect(scrolls).toBe(mode === 'thunder' && size === AS_DRAWN.shane);
            if (scrolls) {
                const painted = await paintedFade(page);
                expect(painted.rest.plain, 'words at the foot').toBeGreaterThan(0);
                expect(painted.rest.faded, 'the fade dims them').toBeLessThan(painted.rest.plain * 0.8);
                expect(Math.abs(painted.end.faded - painted.end.plain), 'no fade at the end').toBeLessThanOrEqual(
                    painted.end.plain * 0.02 + 1,
                );
            }
            // A notice day's rows, at 126-17's rhythm on his room, are still taller than 126-17's.
            if (mode !== 'thunder' && size === AS_DRAWN.shane)
                for (const height of (await breathing(page)).rowHeights)
                    expect(height, 'stop row past 126-17').toBeGreaterThan(BUILD_126_17.shane.row);
            expect(await layoutIssues(page, false)).toEqual([]);
            expect(errors).toEqual([]);
        });

// The fade is a scroll timeline, not motion: with Reduce Motion on (index.css shortens every
// animation to 0.01ms) it still shows, painted, while a stop is below and is gone at the end.
test('only the stops scroll on a day too long for the room, with Reduce Motion on', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await open(page, AS_DRAWN.shane, `&mode=thunder${AS_DRAWN.shane.query}`);
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await expect(
        dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().locator('.today-stop-l2'),
    ).toHaveText(TIMES);
    await expect.poll(() => visibleStops(page)).toBe(3);
    const { issues, scrolls } = await stopsScrollIssues(page);
    expect(issues).toEqual([]);
    expect(scrolls).toBe(true);
    const painted = await paintedFade(page);
    expect(painted.rest.faded).toBeLessThan(painted.rest.plain * 0.8);
    expect(Math.abs(painted.end.faded - painted.end.plain)).toBeLessThanOrEqual(painted.end.plain * 0.02 + 1);
    expect(errors).toEqual([]);
});

// A list that hides only a few px past its foot room hides none of the last stop's words, and
// its fade barely shows (126-17b's review: the first pass laid a 40 px fade over most of the
// last stop, its times included, whenever any of the list was below, even 3-8 px of it).
test('a list that hides only a few px barely dims its last stop', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.shane, `&mode=normal${AS_DRAWN.shane.query}`);
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await expect(
        dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().locator('.today-stop-l2'),
    ).toHaveText(TIMES);
    await expect.poll(() => visibleStops(page)).toBe(3);
    // The stops pushed down by the card's spare room, the list's foot room and 4 px.
    const push = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.today-main')!;
        const overlay = getComputedStyle(card.parentElement!);
        const room =
            card.parentElement!.clientHeight - parseFloat(overlay.paddingTop) - parseFloat(overlay.paddingBottom);
        const list = card.querySelector<HTMLElement>('.today-col-b > .today-stops')!;
        return room - card.getBoundingClientRect().height + parseFloat(getComputedStyle(list).paddingBottom) + 4;
    });
    await page.addStyleTag({ content: `.today-main .today-headline { padding-bottom: ${push}px; }` });
    const m = await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const list = document.querySelector<HTMLElement>('.today-main .today-col-b > .today-stops')!;
        const items = [...list.querySelectorAll<HTMLElement>(':scope > li')];
        const words = items[items.length - 1].querySelector('.today-stop-text')!.getBoundingClientRect();
        return {
            hidden: list.scrollHeight - list.clientHeight - parseFloat(getComputedStyle(list).paddingBottom),
            fade: parseFloat(getComputedStyle(list, '::after').opacity),
            wordsInView: words.bottom <= list.getBoundingClientRect().bottom + 0.5,
        };
    });
    expect(m.hidden).toBeGreaterThan(3);
    expect(m.hidden).toBeLessThan(5);
    expect(m.wordsInView).toBe(true);
    expect(m.fade).toBeLessThanOrEqual(0.2);
    expect((await stopsScrollIssues(page)).issues).toEqual([]);
    expect(errors).toEqual([]);
});

// The iPhones the app still runs on without scroll timelines (iOS 17-18; the deployment target
// is 17.0): the fade is a mask over the list's own foot room, the footer's gap moved into the
// list. The next stop still shows some words under it at rest, and the last scrolls whole into
// view above it (126-17b's review: this path was never run, and it hid the third stop).
test('only the stops scroll where no scroll timeline runs (iOS 17-18), with a fade', async ({ page }) => {
    const errors = await open(page, AS_DRAWN.shane, `&mode=thunder${AS_DRAWN.shane.query}`);
    const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
    await expect(
        dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().locator('.today-stop-l2'),
    ).toHaveText(TIMES);
    await expect.poll(() => visibleStops(page)).toBe(3);
    expect(await withoutScrollTimelines(page)).toBeGreaterThan(0);
    const { issues, scrolls, timeline } = await stopsScrollIssues(page);
    expect(issues).toEqual([]);
    expect({ scrolls, timeline }).toEqual({ scrolls: true, timeline: false });
    const painted = await paintedFade(page);
    expect(painted.rest.faded).toBeLessThan(painted.rest.plain * 0.8);
    expect(Math.abs(painted.end.faded - painted.end.plain)).toBeLessThanOrEqual(painted.end.plain * 0.02 + 1);
    expect(errors).toEqual([]);
});

for (const size of [AS_DRAWN.shane, AS_DRAWN.mid, AS_DRAWN.slim, sizes[3], sizes[0], AS_DRAWN.se2, sizes[4], sizes[8]])
    test(`the stops are their own scroller only on a tall room, at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=normal${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        await expect(dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first()).toBeVisible();
        const list = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('.today-main .today-col-b .today-stops')!;
            const style = getComputedStyle(el);
            const mask = style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
            const after = getComputedStyle(el, '::after');
            const overlay = el.closest<HTMLElement>('.today-overlay')!;
            const pad = getComputedStyle(overlay);
            const room = overlay.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
            const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
            return {
                overflowY: style.overflowY,
                // A mask over the foot (no scroll timeline), or the card's colour laid over it (one runs).
                fades:
                    /gradient/.test(mask) ||
                    (!['none', 'normal'].includes(after.content) && /gradient/.test(after.backgroundImage)),
                tall: room > Math.max(576, 33.5 * root),
            };
        });
        // Past 576 px of room (an SE's most; 33.5rem at large text) the list scrolls inside itself
        // under a fade; an SE, phone landscape and large text keep build 124's: the body scrolls.
        expect(list.tall).toBe(
            size === AS_DRAWN.shane || size === AS_DRAWN.mid || size === AS_DRAWN.slim || size === sizes[3],
        );
        expect(list).toEqual(
            list.tall
                ? { overflowY: 'auto', fades: true, tall: true }
                : { overflowY: 'visible', fades: false, tall: false },
        );
        expect(errors).toEqual([]);
    });

// A tall narrow window (iPad Slide Over, a resizable window) never reads smaller than 126-17
// drew it where its width is not what holds the type (126-17b's review: the light and the
// stop's name had dropped to the times there). The tile's words are the exception, held to
// what one line of the tile holds: 126-17's 13-15 px wrapped the widest wind and "No forecast"
// in these windows ("the widest words keep their one line", below).
for (const [size, was] of [
    [AS_DRAWN.slim, BUILD_126_17.slim],
    [AS_DRAWN.slimmer, BUILD_126_17.slimmer],
] as const)
    test(`a tall narrow window keeps 126-17's sizes where its width allows, at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=normal${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        await expect(
            dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().locator('.today-stop-l2'),
        ).toHaveText(TIMES);
        const m = await breathing(page);
        for (const [key, value] of Object.entries(was.type))
            expect(m.type[key as keyof typeof m.type], key).toBeGreaterThanOrEqual(value);
        for (const [key, value] of Object.entries(was.more))
            expect(m.more[key as keyof typeof m.more], key).toBeGreaterThanOrEqual(value);
        for (const [key, gap] of Object.entries(was.gaps)) expect(m.gaps[key], key).toBeGreaterThanOrEqual(gap);
        for (const [key, height] of Object.entries(m.targets)) expect(height, key).toBeGreaterThanOrEqual(was.targets);
        for (const height of m.rowHeights) expect(height, 'stop row').toBeGreaterThanOrEqual(was.row);
        expect(errors).toEqual([]);
    });

// Where the sheet grows (the room past 576 px). An SE and phone landscape keep build 124's
// sizes to the pixel; at their 13 px floor "≈ NW 18–22" takes two lines in the wide face, as
// it always has there (their tiles are 81-97 px; it needs 7.08 px per px of type).
const growing = [sizes[2], sizes[3], sizes[7], AS_DRAWN.shane, AS_DRAWN.mid, AS_DRAWN.slim, AS_DRAWN.slimmer];
for (const size of growing)
    test(`the widest words keep their one line at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=normal${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        await expect(
            dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first().locator('.today-stop-l2'),
        ).toHaveText(TIMES);
        await expect.poll(() => visibleStops(page)).toBe(size.stops);
        expect(await widestIssues(page)).toEqual([]);
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(errors).toEqual([]);
    });

/**
 * The short times line (126-17c). Shane, offered "07:00 → 10:28 · back 15:57"
 * so the times can grow: "your pick". The row shows the arrow; VoiceOver reads
 * the row's own words for the same times, "Leave 07:00, arrive 10:28, back home
 * 15:57", never "right arrow". Tromsø too: a place's 24 h clock, not the phone's.
 */
for (const [size, mode] of [
    [AS_DRAWN.shane, 'normal'],
    [AS_DRAWN.mid, 'tromso'],
] as const)
    test(`a stop row shows its times short and reads them in words, at ${size.name}: ${mode}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=${mode}${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const stops = dialog.getByRole('list', { name: 'Stops' }).getByRole('button');
        await expect(stops.first().locator('.today-stop-l2')).toHaveText(/^\d\d:\d\d → \d\d:\d\d · back \d\d:\d\d$/);
        await expect.poll(() => visibleStops(page)).toBe(3);
        for (const stop of await stops.all()) {
            const line = (await stop.locator('.today-stop-l2').textContent()) ?? '';
            const [leave, arrive, home] = line.match(/\d\d:\d\d/g) ?? [];
            expect(line).toBe(`${leave} → ${arrive} · back ${home}`);
            await expect(stop).toHaveAccessibleName(
                new RegExp(`\\. Leave ${leave}, arrive ${arrive}, back home ${home}\\. `),
            );
            expect(await stop.getAttribute('aria-label')).not.toMatch(/→/);
        }
        await dialog.getByRole('combobox', { name: 'Stay' }).selectOption('overnight');
        await expect(stops.first().locator('.today-stop-l2')).toHaveText(
            /^\d\d:\d\d → \d\d:\d\d · (about )?[\d.]+ NM$/,
        );
        await expect(stops.first()).toHaveAccessibleName(
            /\. Leave \d\d:\d\d, arrive \d\d:\d\d, (about )?[\d.]+ nautical miles\. /,
        );
        expect(errors).toEqual([]);
    });
