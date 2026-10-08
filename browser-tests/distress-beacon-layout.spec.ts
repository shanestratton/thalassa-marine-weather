import { expect, test, type Page } from '@playwright/test';

/**
 * Distress beacons (build 125, package 125-02), rendered for real in Chromium
 * and WebKit with wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner):
 *
 *  - the card stack (a sounding AIS-SART, a man-overboard beacon with no
 *    position yet, an internet-relayed EPIRB-AIS, a caution, and a collision
 *    card under them) fits 320x568 and 375x667: centred, clear of the tab bar,
 *    nothing cut off or sideways, every button a whole 44 pt target;
 *  - Go to it, on the Man Overboard page: the bearing, range, her own MOB
 *    button (Back to your MOB, or MOB, mark position) and Stop fit one screen
 *    above the tab bar;
 *  - the IEC 62288 symbol, a red circle with a cross, drawn by the real
 *    canvas code and placed by the real Mapbox engine with the chart's own
 *    icon expression: red on the ring and at the centre, clear between the
 *    arms; a test beacon the same shape in green.
 *
 * e2e/fixtures/distress-beacon.tsx. Fictional MMSIs only.
 */

const SIZES = [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
];

async function openFixture(page: Page, size: { width: number; height: number }, view = '') {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        // WebKit routes the map engine's own blob: worker through here too.
        const local =
            url.protocol === 'blob:' ||
            (['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET');
        // The map view may reach Mapbox for its own glyph and style resources only.
        const mapbox = view === 'map' && /(^|\.)mapbox\.com$/.test(url.hostname);
        return local || mapbox ? route.continue() : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/distress-beacon.html?fonts=wide${view ? `&view=${view}` : ''}`);
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

function controlIssues(page: Page, containerSelector: string) {
    return page.evaluate((selector) => {
        const issues: string[] = [];
        const container = document.querySelector<HTMLElement>(selector);
        if (!container) return [`no ${selector}`];
        const box = container.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        for (const button of container.querySelectorAll<HTMLElement>('button')) {
            const r = button.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const name = button.getAttribute('aria-label') || button.textContent?.trim();
            if (r.height < 43.5 || r.width < 43.5) issues.push(`${name}: ${r.width}x${r.height}`);
            if (r.bottom > Math.min(box.bottom, nav.top) + 0.5 || r.top < box.top - 0.5) continue; // scrolled out
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5) issues.push(`${name} escapes sideways`);
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(hit === button || button.contains(hit))) issues.push(`${name} is covered`);
        }
        return issues;
    }, containerSelector);
}

for (const size of SIZES) {
    test(`the distress cards fit ${size.width}x${size.height} with wide fonts, above the collision card`, async ({
        page,
    }, info) => {
        const errors = await openFixture(page, size);
        const cards = page.getByRole('alert');
        await expect(cards).toHaveCount(5);
        await page.evaluate(() =>
            Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
        );
        await expect(cards.nth(0)).toContainText('DISTRESS: AIS-SART ACTIVE');
        await expect(cards.nth(0)).toContainText('Heard by your radio');
        await expect(cards.nth(1)).toContainText('Position not yet received');
        await expect(cards.nth(2)).toContainText('Relayed via internet, not heard by your radio, 6 min old');
        await expect(cards.nth(3)).toContainText('NOT ACTIVE OR TEST');
        await expect(cards.nth(4)).toContainText('COLLISION RISK');

        const geometry = await page.evaluate(() => {
            const stack = document.querySelector<HTMLElement>('[data-testid="ais-guard-stack"]')!;
            const box = stack.getBoundingClientRect();
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            const sideways = [...stack.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
                .filter((card) => card.scrollWidth > card.clientWidth + 1)
                .map((card) => card.textContent?.slice(0, 30));
            return {
                left: box.left,
                right: window.innerWidth - box.right,
                top: box.top,
                bottom: box.bottom,
                navTop: nav.top,
                sideways,
                pageSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
                zIndex: Number(getComputedStyle(stack).zIndex),
            };
        });
        expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
        expect(geometry.sideways).toEqual([]);
        expect(geometry.pageSideways).toBe(false);
        expect(geometry.zIndex).toBeGreaterThan(9000);
        expect(geometry.zIndex).toBeLessThan(2147483000);
        expect(await controlIssues(page, '[data-testid="ais-guard-stack"]')).toEqual([]);
        expect(errors).toEqual([]);

        if (size.width === 320) {
            const path = info.outputPath(`distress-cards-${info.project.name}-320x568.png`);
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('distress-cards-320x568', { path, contentType: 'image/png' });
        }
    });

    for (const fix of ['fix', 'none'] as const) {
        test(`Go to it (${fix === 'fix' ? 'with' : 'without'} a fix of ours) fits ${size.width}x${size.height} with wide fonts, Stop above the tab bar`, async ({
            page,
        }, info) => {
            // With a fix, her own MOB is marked too (Back to your MOB); without, it is not.
            const errors = await openFixture(page, size, `goto&fix=${fix}${fix === 'fix' ? '' : '&mob=off'}`);
            await expect(page.getByText('Bearing to beacon')).toBeVisible();
            await expect(page.getByTestId('beacon-bearing')).toHaveText(fix === 'fix' ? /^\d{3}°$/ : '—');
            await expect(page.getByRole('status')).toHaveText(/^Heard by your radio, \d+ s ago$/);
            const stop = page.getByRole('button', { name: 'Stop going to it' });
            await expect(stop).toBeInViewport({ ratio: 1 });
            // The beacon still sounds: its Silence sits beside Stop, a whole 44 pt target.
            const silence = page.getByRole('button', { name: 'Silence the distress alarm for FICTIONAL CREW BEACON' });
            await expect(silence).toBeInViewport({ ratio: 1 });
            expect((await silence.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
            const box = (await stop.boundingBox())!;
            const navTop = await page.evaluate(
                () => document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().top,
            );
            expect(box.y + box.height, 'Stop clear of the tab bar').toBeLessThanOrEqual(navTop + 0.5);
            expect(box.height).toBeGreaterThanOrEqual(43.5);
            // Her own MOB is never out of reach from here: a whole target, one line, clear of the tab bar.
            const ownMob = page.getByRole('button', {
                name: fix === 'fix' ? 'Back to your MOB' : 'MOB, mark position',
                exact: true,
            });
            await expect(ownMob).toBeInViewport({ ratio: 1 });
            const mobBox = (await ownMob.boundingBox())!;
            expect(mobBox.height).toBeGreaterThanOrEqual(43.5);
            expect(mobBox.height, 'one line').toBeLessThan(60);
            expect(mobBox.y + mobBox.height).toBeLessThanOrEqual(navTop + 0.5);
            expect(await controlIssues(page, '[data-testid="beacon-goto"]')).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
            // One screen: the page does not scroll to reach any of it.
            expect(
                await page.evaluate(() => {
                    const view = document.querySelector<HTMLElement>('[data-testid="beacon-goto"]')!;
                    return view.scrollHeight <= view.clientHeight + 1;
                }),
            ).toBe(true);
            expect(errors).toEqual([]);
            if (size.width === 320) {
                const path = info.outputPath(`distress-goto-${fix}-${info.project.name}-320x568.png`);
                await page.screenshot({ path, animations: 'disabled' });
                await info.attach(`distress-goto-${fix}-320x568`, { path, contentType: 'image/png' });
            }
        });
    }
}

test('the IEC 62288 symbol: a red circle with a cross, drawn and placed for real', async ({ page }, info) => {
    const errors = await openFixture(page, { width: 390, height: 700 }, 'map');
    await page.waitForFunction(
        () => 'read' in ((window as unknown as { __distress?: object }).__distress ?? {}),
        null,
        {
            timeout: 30_000,
        },
    );
    const result = await page.evaluate(() =>
        (
            window as unknown as {
                __distress: {
                    read: () => Promise<{
                        placed: { mmsi: number; iconKind: string }[];
                        hasImage: boolean;
                        painted: boolean;
                        map: Record<string, [number, number, number, number]>;
                        canvas: Record<string, [number, number, number, number]>;
                    }>;
                };
            }
        ).__distress.read(),
    );
    const red = ([r, g, b, a]: number[]) => a > 200 && r > 200 && g < 90 && b < 90;
    const green = ([r, g, , a]: number[]) => a > 200 && g > 150 && r < 120;
    const clear = ([, , , a]: number[]) => a < 40;

    // Drawn: the image the chart registers, painted on a plain canvas in this engine.
    expect(red(result.canvas.centre), `centre ${result.canvas.centre}`).toBe(true);
    expect(red(result.canvas.ringTop), `ring ${result.canvas.ringTop}`).toBe(true);
    expect(red(result.canvas.armNe), `arm ${result.canvas.armNe}`).toBe(true);
    expect(clear(result.canvas.betweenArms), `between ${result.canvas.betweenArms}`).toBe(true);
    expect(clear(result.canvas.outside), `outside ${result.canvas.outside}`).toBe(true);

    // Placed: Mapbox draws all three beacons with the beacon image, never a boat or a dot.
    expect(result.hasImage).toBe(true);
    expect(result.placed.map((p) => p.mmsi).sort()).toEqual([970_000_601, 970_000_602, 972_000_603]);
    expect(result.placed.every((p) => p.iconKind === 'sart')).toBe(true);

    // Painted where the engine paints (an authenticated map): red ring and centre, clear between the arms.
    if (result.painted) {
        expect(red(result.map.centre), `map centre ${result.map.centre}`).toBe(true);
        expect(red(result.map.ringTop), `map ring ${result.map.ringTop}`).toBe(true);
        expect(red(result.map.betweenArms), `map between ${result.map.betweenArms}`).toBe(false);
        expect(green(result.map.testCentre), `test beacon ${result.map.testCentre}`).toBe(true);
    }
    expect(errors).toEqual([]);
    const path = info.outputPath(`distress-symbol-${info.project.name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach('distress-symbol', { path, contentType: 'image/png' });
});
