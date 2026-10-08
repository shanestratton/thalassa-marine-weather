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

const sizes = [
    { name: '320x568', width: 320, height: 568, query: '', stops: 2, mayScroll: false },
    { name: '375x667', width: 375, height: 667, query: '', stops: 3, mayScroll: false },
    { name: '390x844', width: 390, height: 844, query: '', stops: 3, mayScroll: false },
    { name: '844x390 landscape', width: 844, height: 390, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '926x428 landscape', width: 926, height: 428, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '932x430 landscape', width: 932, height: 430, query: '', stops: 2, mayScroll: false, landscape: true },
    { name: '1024x768 split pane', width: 1024, height: 768, query: '&pane=true', stops: 3, mayScroll: false },
    { name: 'large text 320x568', width: 320, height: 568, query: '&largeText', stops: 2, mayScroll: true },
    { name: 'large text 390x844', width: 390, height: 844, query: '&largeText', stops: 3, mayScroll: true },
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
        if (!mayScroll)
            for (const name of card.querySelectorAll<HTMLElement>('.today-stop-name'))
                if (name.getClientRects().length && name.scrollWidth > name.clientWidth + 1)
                    issues.push(`the stop name "${name.textContent}" is cut`);
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

for (const size of [sizes[0], sizes[2]]) {
    test(`an overnight stay fits ${size.name}, and so does its stop's detail`, async ({ page }) => {
        const errors = await open(page, size, '&mode=normal');
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        await dialog.getByRole('combobox', { name: 'Stay' }).selectOption('overnight');
        await expect(dialog.locator('.today-stay')).toContainText('Overnight');
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first.locator('.today-stop-l2')).toHaveText(
            /^Leave \d\d:\d\d · there \d\d:\d\d · (about )?[\d.]+ NM$/,
        );
        expect(await layoutIssues(page, false)).toEqual([]);
        expect(await placeClockIssues(page, 'normal')).toEqual([]);

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
