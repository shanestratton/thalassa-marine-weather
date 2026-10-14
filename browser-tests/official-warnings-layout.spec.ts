/**
 * Official warnings in the app (129-06), measured in a browser at 320 × 568
 * and 390 × 844 in the house wide fonts (e2e/fixtures/official-warnings.tsx):
 *  - the Glass's warnings row with the official count, alone and beside the
 *    forecast pill: one row, every chip and its glyphs inside the row, the
 *    sun chip untouched, nothing squeezed to nothing; the 163 px instrument
 *    grid below is not part of the row and is not touched;
 *  - the Warnings page leading with the official section: no sideways
 *    scroll, every card inside the screen, 44 pt link and More, and the
 *    Arabic block laid out right to left;
 *  - Settings → Alerts: the Official warnings section fits one screen
 *    under the settings header, its two switches 44 pt; and (129-07) the
 *    Looking ahead section, once the check reports the look-ahead version.
 *  - MeteoAlarm (129-05b): its card (level and type as the title, the
 *    national service as source, its times, area and impacts, the other
 *    languages behind one control) and its notice (the disclaimer, verbatim,
 *    with two www.meteoalarm.org links) fit without sideways scroll, one
 *    country and two.
 * No network: official_alerts_at and the watcher status answer from the
 * fixture's fictional data.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { METEOALARM_DISCLAIMER } from '../supabase/functions/_shared/official-alerts/meteoalarm';

const SIZES = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
];

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4199').origin;
    await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/official-warnings.html?fonts=wide&${query}`);
    await page.evaluate(() => document.fonts.ready);
}

/** Nothing on the page scrolls sideways, and no listed element is wider than its box. */
async function expectNoSidewaysOverflow(page: Page, selector: string) {
    expect(
        await page.evaluate((sel) => {
            const errors: string[] = [];
            if (document.documentElement.scrollWidth > window.innerWidth + 1) errors.push('the page scrolls sideways');
            for (const el of document.querySelectorAll(sel)) {
                const box = el.getBoundingClientRect();
                if (el.scrollWidth > el.clientWidth + 1)
                    errors.push(`"${(el.textContent ?? '').slice(0, 40)}" ${el.scrollWidth} > ${el.clientWidth}`);
                if (box.left < -0.5 || box.right > window.innerWidth + 0.5)
                    errors.push(`"${(el.textContent ?? '').slice(0, 40)}" off screen ${box.left}..${box.right}`);
            }
            return errors;
        }, selector),
    ).toEqual([]);
}

async function expectTarget(control: Locator, label: string) {
    const box = (await control.boundingBox())!;
    expect(box.height, `${label} is a 44 pt target`).toBeGreaterThanOrEqual(43.5);
}

test.describe('the Glass counts official warnings apart', () => {
    for (const size of SIZES) {
        for (const forecast of [true, false]) {
            test(`${size.width}x${size.height}, ${forecast ? 'beside forecast alerts' : 'alone'}, wide fonts`, async ({
                page,
            }, info) => {
                await open(page, size, `view=glass&state=inforce${forecast ? '&forecast=1' : ''}`);
                const chip = page.getByRole('button', { name: '2 official warnings in force' });
                await expect(chip).toBeVisible();
                await expectWideFaceDrawn(chip);
                if (forecast)
                    await expect(page.getByRole('button', { name: '2 active forecast alerts' })).toBeVisible();
                else await expect(page.getByRole('button', { name: 'No forecast alerts' })).toHaveCount(0);

                const m = await page.getByTestId('glass-row').evaluate((wrap) => {
                    const row = wrap.firstElementChild as HTMLElement;
                    const r = row.getBoundingClientRect();
                    const buttons = [...row.querySelectorAll('button')].map((b) => {
                        const box = b.getBoundingClientRect();
                        const parts = [...b.querySelectorAll('svg, span, div')]
                            .filter((p) => getComputedStyle(p).display !== 'none' && !p.classList.contains('sr-only'))
                            .map((p) => {
                                const q = p.getBoundingClientRect();
                                return {
                                    tag: p.tagName,
                                    text: p.textContent,
                                    left: q.left,
                                    right: q.right,
                                    width: q.width,
                                };
                            });
                        return {
                            name: b.getAttribute('aria-label'),
                            top: box.top,
                            height: box.height,
                            left: box.left,
                            right: box.right,
                            width: box.width,
                            parts,
                        };
                    });
                    return { row: { top: r.top, height: r.height, left: r.left, right: r.right }, buttons };
                });
                const [first] = m.buttons;
                for (const b of m.buttons) {
                    // One row: every chip on the same line and the same height.
                    expect(b.top, b.name ?? 'sun').toBeCloseTo(first.top, 0);
                    expect(b.height, b.name ?? 'sun').toBeCloseTo(first.height, 0);
                    expect(b.left).toBeGreaterThanOrEqual(m.row.left - 0.5);
                    expect(b.right).toBeLessThanOrEqual(m.row.right + 0.5);
                    for (const p of b.parts) {
                        // Every glyph and word inside its chip, none squeezed to nothing.
                        expect(p.width, `${b.name}: ${p.tag} ${p.text}`).toBeGreaterThan(0);
                        expect(p.left, `${b.name}: ${p.tag} ${p.text}`).toBeGreaterThanOrEqual(b.left - 0.5);
                        expect(p.right, `${b.name}: ${p.tag} ${p.text}`).toBeLessThanOrEqual(b.right + 0.5);
                    }
                }
                expect(m.row.height).toBeCloseTo(first.height, 0);
                const official = m.buttons.find((b) => b.name === '2 official warnings in force')!;
                expect(official.width).toBeGreaterThanOrEqual(43.5);
                expect(official.parts.some((p) => p.text === '2')).toBe(true);
                expect(await chip.getAttribute('class')).toContain('hit-target-44');
                await expectNoSidewaysOverflow(page, '[data-testid="glass-row"] button');

                const path = info.outputPath(
                    `glass-official-${forecast ? 'beside' : 'alone'}-${size.width}x${size.height}.png`,
                );
                await page.screenshot({
                    path,
                    animations: 'disabled',
                    clip: { x: 0, y: 0, width: size.width, height: 80 },
                });
                await info.attach(`glass-official-${forecast ? 'beside' : 'alone'}-${size.width}`, {
                    path,
                    contentType: 'image/png',
                });
            });
        }
    }
});

test.describe('the Warnings page leads with the official warnings', () => {
    for (const size of SIZES) {
        for (const state of ['inforce', 'partial', 'none', 'rtl', 'nearby', 'pinned']) {
            test(`${state} at ${size.width}x${size.height}, wide fonts`, async ({ page }, info) => {
                const query =
                    state === 'pinned'
                        ? 'state=clear&pin=1'
                        : `state=${state}${state === 'inforce' ? '&forecast=1' : ''}`;
                await open(page, size, `view=page&${query}`);
                const section = page.getByRole('region', { name: 'Official warnings in force here' });
                await expect(section).toBeVisible();
                await expect(page.getByRole('heading', { level: 1, name: 'Warnings' })).toBeVisible();
                await expectWideFaceDrawn(section.getByRole('heading', { level: 2 }));
                await expectNoSidewaysOverflow(page, 'article, [data-alert-style="forecast"]');

                const link = section.getByRole('link', { name: /^Open .* warnings/ });
                if (state === 'inforce' || state === 'rtl' || state === 'nearby' || state === 'pinned')
                    await expect(link).toHaveCount(0);
                else await expectTarget(link, 'the issuer link');
                if (state === 'nearby') {
                    await expect(section.getByText('For the waters within 3 NM of here')).toBeVisible();
                }
                if (state === 'pinned') {
                    // The tapped push leads, above the place's own answer, with its issuer's link.
                    const pin = page.getByTestId('official-push-pin');
                    await expect(pin.getByText('Sent for your home port')).toBeVisible();
                    const pinBox = (await pin.boundingBox())!;
                    expect(pinBox.y).toBeLessThan((await section.boundingBox())!.y);
                    await expectTarget(pin.getByRole('link', { name: /^Open NWS warnings/ }), 'the pin’s issuer link');
                }
                for (const more of await section.getByRole('button', { name: 'More' }).all()) {
                    await expectTarget(more, 'More');
                }
                if (state === 'rtl') {
                    // dir="auto" on each block: the Arabic headline lays out right to left, and the
                    // issuer's name, Latin first, left to right, as each was sent.
                    const cards = section.getByRole('article');
                    const arabic = cards.first().getByText('تحذير من رياح قوية في خليج زز (نص وهمي)');
                    expect(await arabic.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
                    const issuer = cards.first().getByText('Fictional Met Service (مصلحة الأرصاد الوهمية)');
                    expect(await issuer.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
                    const greek = cards.nth(3).getByRole('heading', { level: 3 });
                    expect(await greek.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
                }
                if (state === 'inforce') {
                    const more = section.getByRole('button', { name: 'More' }).first();
                    await more.click();
                    await expect(section.getByRole('button', { name: 'Less' }).first()).toHaveAttribute(
                        'aria-expanded',
                        'true',
                    );
                    await expectNoSidewaysOverflow(page, 'article');
                }
                const path = info.outputPath(`warnings-${state}-${size.width}x${size.height}.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(`warnings-${state}-${size.width}`, { path, contentType: 'image/png' });
            });
        }
    }
});

test.describe('MeteoAlarm under its own terms', () => {
    for (const size of SIZES) {
        for (const state of ['meteoalarm', 'meteoalarm-border']) {
            test(`${state} at ${size.width}x${size.height}, wide fonts`, async ({ page }, info) => {
                await open(page, size, `view=page&state=${state}`);
                const section = page.getByRole('region', { name: 'Official warnings in force here' });
                await expect(section).toBeVisible();
                const card = section.getByRole('article').first();
                await expect(card.getByText(/^Source: /)).toBeVisible();
                await expect(card.getByText(/^In effect from .+ until .+$/)).toBeVisible();
                await expectWideFaceDrawn(card.getByRole('heading', { level: 3 }));
                const notice = section.getByTestId('meteoalarm-notice');
                const disclaimer = notice.getByTestId('meteoalarm-disclaimer');
                await expect(disclaimer).toBeVisible();
                expect(await disclaimer.textContent()).toBe(METEOALARM_DISCLAIMER);
                await expect(disclaimer.getByRole('link', { name: 'www.meteoalarm.org' })).toHaveCount(2);
                if (state === 'meteoalarm-border') await expect(notice.getByText(/^Source: EUMETNET/)).toBeVisible();
                await expectNoSidewaysOverflow(page, 'article, article p, [data-testid="meteoalarm-notice"] p');
                // Every other language behind one control, opened: still inside the screen.
                const other = card.getByText(/^Also issued in /);
                await other.click();
                await expect(card.locator('details[open]')).toHaveCount(1);
                await expectNoSidewaysOverflow(page, 'article, article p, article li');
                const path = info.outputPath(`warnings-${state}-${size.width}x${size.height}.png`);
                await page.screenshot({ path, animations: 'disabled', fullPage: true });
                await info.attach(`warnings-${state}-${size.width}`, { path, contentType: 'image/png' });
            });
        }
    }
});

test.describe('Settings → Alerts: Official warnings', () => {
    for (const size of SIZES) {
        test(`fits one screen at ${size.width}x${size.height} under the settings header, wide fonts`, async ({
            page,
        }, info) => {
            await open(page, size, 'view=alerts');
            const marine = page.getByRole('switch', { name: 'Official marine warnings at the boat' });
            await expect(marine).toBeVisible();
            await expect(page.getByRole('switch', { name: 'Cyclone warnings near the boat' })).toBeVisible();
            const heading = page.getByRole('heading', { level: 2, name: 'Official warnings' });
            await heading.scrollIntoViewIfNeeded();
            await expectWideFaceDrawn(heading);
            const section = heading.locator('xpath=..');
            const fit = await section.evaluate((el) => {
                const scroll = document.querySelector('[data-testid="settings-scroll"]')!.getBoundingClientRect();
                const nav = document.querySelector('nav')!.getBoundingClientRect();
                return {
                    height: el.getBoundingClientRect().height,
                    room: Math.min(scroll.bottom, nav.top) - scroll.top,
                };
            });
            // One screen: the whole section can stand between the header and the tab bar.
            expect(fit.height, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room);
            // The settings switch (SettingsPrimitives Toggle) is 2.75rem tall: 44 px at a 16 px root,
            // 35.75 at 320 pt where index.css's fluid root is 13 px. That is every Settings switch, the
            // cyclone one beside these included (reported in 129-06, not changed here); these match it.
            const cyclone = (await page.getByRole('switch', { name: 'Cyclone warnings near the boat' }).boundingBox())!;
            for (const [control, label] of [
                [marine, 'the marine warnings switch'],
                [page.getByRole('switch', { name: 'Small craft advisories' }), 'the small craft switch'],
            ] as const) {
                const box = (await control.boundingBox())!;
                expect(box.height, label).toBeCloseTo(cyclone.height, 1);
                expect(box.x + box.width, label).toBeLessThanOrEqual(size.width + 0.5);
            }
            await expectNoSidewaysOverflow(page, '[data-testid="settings-scroll"] p');
            await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
            const path = info.outputPath(`alerts-official-${size.width}x${size.height}.png`);
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach(`alerts-official-${size.width}`, { path, contentType: 'image/png' });
        });
    }
});

// 129-07: once the deployed check reports the look-ahead version (weather_alert_status,
// fictional answer with &ahead=1), Settings → Alerts shows "Looking ahead": the 6, 12 and
// 24 h choice, "Good window opens" and the status lines. Without it the section is absent.
test.describe('Settings → Alerts: Looking ahead', () => {
    for (const size of SIZES) {
        test(`fits one screen at ${size.width}x${size.height} under the settings header, wide fonts`, async ({
            page,
        }, info) => {
            await open(page, size, 'view=alerts&ahead=1');
            const heading = page.getByRole('heading', { level: 2, name: 'Looking ahead' });
            await expect(heading).toBeVisible();
            await expect(page.getByText('Only with app open')).toHaveCount(0);
            await heading.scrollIntoViewIfNeeded();
            await expectWideFaceDrawn(heading);
            const section = heading.locator('xpath=..');
            const fit = await section.evaluate((el) => {
                const scroll = document.querySelector('[data-testid="settings-scroll"]')!.getBoundingClientRect();
                const nav = document.querySelector('nav')!.getBoundingClientRect();
                return {
                    height: el.getBoundingClientRect().height,
                    room: Math.min(scroll.bottom, nav.top) - scroll.top,
                };
            });
            expect(fit.height, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room);
            // The choices are as tall as every Settings switch (35.75 at 320 pt's 13 px root, 44 at 16 px).
            const toggle = (await page.getByRole('switch', { name: 'Good window opens' }).boundingBox())!;
            const group = page.getByRole('group', { name: 'Look ahead' });
            for (const name of ['6 h', '12 h', '24 h']) {
                const box = (await group.getByRole('button', { name }).boundingBox())!;
                expect(box.height, name).toBeGreaterThanOrEqual(toggle.height - 0.5);
                expect(box.x + box.width, name).toBeLessThanOrEqual(size.width + 0.5);
            }
            await expect(page.getByText('Seas: no wave model here.')).toBeVisible();
            await expectNoSidewaysOverflow(
                page,
                '[data-testid="settings-scroll"] p, [data-testid="settings-scroll"] button',
            );
            await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
            const path = info.outputPath(`alerts-ahead-${size.width}x${size.height}.png`);
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach(`alerts-ahead-${size.width}`, { path, contentType: 'image/png' });
        });
    }

    test('is absent until the function reports the look-ahead version', async ({ page }) => {
        await open(page, { width: 320, height: 568 }, 'view=alerts');
        await expect(page.getByRole('switch', { name: 'Official marine warnings at the boat' })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: 'Looking ahead' })).toHaveCount(0);
        await expect(page.getByText('Only with app open')).toHaveCount(2);
    });
});
