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
 */

const sizes = [
    { name: '320x568', width: 320, height: 568, query: '', stops: 2, mayScroll: false },
    { name: '375x667', width: 375, height: 667, query: '', stops: 3, mayScroll: false },
    { name: '390x844', width: 390, height: 844, query: '', stops: 3, mayScroll: false },
    { name: '844x390 landscape', width: 844, height: 390, query: '', stops: 2, mayScroll: false },
    { name: '1024x768 split pane', width: 1024, height: 768, query: '&pane=true', stops: 3, mayScroll: false },
    { name: 'large text 320x568', width: 320, height: 568, query: '&largeText', stops: 2, mayScroll: true },
    { name: 'large text 390x844', width: 390, height: 844, query: '&largeText', stops: 3, mayScroll: true },
];
const modes = ['normal', 'default-boat', 'over', 'offline', 'no-position', 'noumea'] as const;

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
                await expect(dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first()).toBeVisible();
                await expect.poll(() => visibleStops(page)).toBe(size.stops);
                await expect(dialog.getByTestId('day-plan-credit')).toContainText('Not a clearance');
            }
            if (mode === 'default-boat')
                await expect(
                    dialog.getByRole('button', { name: 'Typical 6 kn boat: set yours in Vessel ›' }),
                ).toBeVisible();
            if (mode === 'offline')
                await expect(dialog.getByText('Offline: light and cached tides only')).toBeVisible();
            if (mode === 'over') await expect(dialog.getByTestId('day-plan-headline')).toContainText('Stay put today');
            if (size.width === 844)
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

for (const size of sizes.filter((s) => !s.mayScroll && s.width < 844)) {
    test(`the nested screens are centred and clear of the tab bar at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `&mode=default-boat${size.query}`);
        const dialog = page.getByRole('dialog', { name: 'Plan Your Day', exact: true });
        const first = dialog.getByRole('list', { name: 'Stops' }).getByRole('button').first();
        await expect(first).toBeVisible();

        // The stop's detail fits outright at ordinary text, with its leave chips and both buttons.
        await first.click();
        const detail = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Plot on chart' }) });
        await expect(detail.getByRole('list', { name: 'How the day goes' })).toBeVisible();
        await expect(detail.getByRole('group', { name: 'Leave at' })).toBeVisible();
        expect(await layoutIssues(page, false)).toEqual([]);
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
