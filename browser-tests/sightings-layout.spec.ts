/**
 * Sightings fits and reads at sea: the real page, quick log, species list,
 * detail, Scuttlebutt card and Log page pill (e2e/fixtures/sightings.tsx),
 * fictional data only, no network.
 *
 * Checked on every screen: nothing scrolls sideways; every button is a 44 pt
 * target; a dialog is centred and ends above the tab bar (Shane's standing
 * rule), or inside its pane in split view; its Done/close never leaves the
 * screen. Dark, light and night (dark plus the red scrim) at 390x844, the
 * 320x568 SE, and the iPad split pane.
 *
 * Set SIGHTINGS_SHOTS_DIR to also save a screenshot of each state.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.env.SIGHTINGS_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

type Mode = 'dark' | 'light' | 'night';

async function open(page: Page, query: string, size = { width: 390, height: 844 }) {
    await page.setViewportSize(size);
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1)/, (socket) => socket.close());
    await page.goto(`/e2e/fixtures/sightings.html?${query}`);
    await page.waitForFunction(
        () => (window as unknown as { __sightingsFixtureReady?: boolean }).__sightingsFixtureReady,
    );
}

async function shot(page: Page, name: string) {
    if (!SHOTS) return;
    // Let fonts, the sheet's fade-in and lazy chunks settle.
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, `ui_${name}.png`) });
}

/** Show a dialog from its top, as it opens (the taps above scrolled it). */
async function toTop(dialog: Locator) {
    await dialog
        .locator('.overflow-y-auto')
        .first()
        .evaluate((el) => {
            el.scrollTop = 0;
        });
}

async function noSidewaysScroll(page: Page) {
    const overflow = await page.evaluate(() => {
        const doc = document.documentElement.scrollWidth - window.innerWidth;
        const scrollers = [...document.querySelectorAll<HTMLElement>('*')]
            .filter((el) => {
                const s = getComputedStyle(el);
                return (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.clientWidth > 0;
            })
            // Chip rows scroll sideways on purpose.
            .filter((el) => !el.matches('[role="group"], [aria-label="Show a group"]'))
            .map((el) => el.scrollWidth - el.clientWidth);
        return Math.max(doc, 0, ...scrollers);
    });
    expect(overflow, 'sideways overflow (px)').toBeLessThanOrEqual(1);
}

/** Every visible button inside `scope` is at least 44 x 44. */
async function targets(scope: Locator) {
    const small = await scope.evaluate((root) =>
        [...root.querySelectorAll<HTMLElement>('button')]
            .filter((b) => {
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
            })
            .map((b) => {
                const r = b.getBoundingClientRect();
                return { name: b.getAttribute('aria-label') || b.textContent?.trim(), w: r.width, h: r.height };
            })
            .filter((b) => b.w < 43.5 || b.h < 43.5),
    );
    expect(small, 'buttons under 44 pt').toEqual([]);
}

/** A dialog is centred, inside the screen (or pane), above the tab bar, with its foot visible. */
async function dialogFits(page: Page, dialog: Locator, foot?: Locator) {
    await expect(dialog).toBeVisible();
    // Measure the settled card, not its 95 % zoom-in frame.
    await dialog.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
    );
    const g = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const nav = document.querySelector('[data-testid="app-bottom-nav"]')!.getBoundingClientRect();
        const pane = document.querySelector('[data-split-pane]');
        const frame = pane ? pane.getBoundingClientRect() : null;
        return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            navTop: nav.top,
            frame: frame && { top: frame.top, bottom: frame.bottom, left: frame.left, right: frame.right },
            vw: window.innerWidth,
        };
    });
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.navTop);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.right).toBeLessThanOrEqual(g.vw);
    if (g.frame) {
        expect(g.top).toBeGreaterThanOrEqual(g.frame.top);
        expect(g.bottom).toBeLessThanOrEqual(g.frame.bottom);
        expect(g.left).toBeGreaterThanOrEqual(g.frame.left);
        expect(g.right).toBeLessThanOrEqual(g.frame.right);
        // Centred in the pane, not the window.
        expect(Math.abs((g.left + g.right) / 2 - (g.frame.left + g.frame.right) / 2)).toBeLessThan(2);
    } else {
        expect(Math.abs((g.left + g.right) / 2 - g.vw / 2)).toBeLessThan(2);
    }
    if (foot) {
        const f = await foot.boundingBox();
        expect(f).not.toBeNull();
        expect(f!.y + f!.height).toBeLessThanOrEqual(g.bottom + 0.5);
        expect(f!.height).toBeGreaterThanOrEqual(44);
    }
    await targets(dialog);
}

async function logWhale(page: Page) {
    await page.getByRole('button', { name: 'Log whale' }).click();
    const dialog = page.getByRole('dialog', { name: 'Whale logged' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Humpback whale' }).click();
    const named = page.getByRole('dialog', { name: 'Humpback whale logged' });
    await named.getByRole('button', { name: 'One more' }).click();
    await named.getByRole('button', { name: 'Calf with them' }).click();
    await expect(named.getByRole('group', { name: 'How many?' })).toContainText('2');
    return named;
}

for (const mode of ['dark', 'light', 'night'] as Mode[]) {
    test.describe(`Sightings · 390x844 · ${mode}`, () => {
        test('the crew feed, live', async ({ page }) => {
            await open(page, `mode=${mode}&tab=crew`);
            await expect(page.getByText('Live from the crew')).toBeVisible();
            await expect(page.getByText('Green turtle')).toBeVisible();
            await expect(page.getByRole('tab', { name: /Crew/ })).toHaveAttribute('aria-selected', 'true');
            await noSidewaysScroll(page);
            await targets(page.getByTestId('sightings-page'));
            await shot(page, `page_crew_${mode}`);
        });

        test('quick log: one tap, then keep your distance', async ({ page }) => {
            await open(page, `mode=${mode}&screen=quick`);
            const pick = page.getByRole('dialog', { name: 'What did you see?' });
            await expect(pick.getByText('Boat GPS (via Pi)')).toBeVisible();
            await dialogFits(page, pick);
            const tiles = pick.getByRole('group', { name: 'Log a group' }).getByRole('button');
            await expect(tiles).toHaveCount(8);
            for (const box of await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
                expect(box).toBeGreaterThanOrEqual(56);
            }
            await shot(page, `quick_pick_${mode}`);

            const logged = await logWhale(page);
            await expect(logged.getByTestId('distance-card')).toContainText('Keep your distance');
            await dialogFits(page, logged, logged.getByRole('button', { name: 'Done' }));
            // The corner saves; Undo sits in the footer beside Done, both on screen.
            await expect(logged.locator('header').getByRole('button')).toHaveAccessibleName('Save and close');
            await dialogFits(page, logged, logged.getByRole('button', { name: 'Undo' }));
            await noSidewaysScroll(page);
            await toTop(logged);
            await shot(page, `quick_logged_${mode}`);

            await logged.getByRole('button', { name: 'More…' }).click();
            const picker = page.getByRole('dialog', { name: 'Which species?' });
            await expect(
                picker.getByRole('button', { name: /^Humpback whale, Megaptera novaeangliae/ }).first(),
            ).toHaveAttribute('aria-pressed', 'true');
            await dialogFits(page, picker, picker.getByRole('button', { name: /Not sure: keep it as Whale/ }));
            await shot(page, `picker_${mode}`);
        });

        test('a sighting in detail', async ({ page }) => {
            await open(page, `mode=${mode}&tab=crew`);
            await page.getByRole('button', { name: /^Humpback whale × 2 · calf/ }).click();
            const detail = page.getByRole('dialog', { name: 'Humpback whale' });
            await expect(detail).toContainText('Forecast data: ECMWF');
            await dialogFits(page, detail, detail.getByRole('button', { name: 'Delete' }));
            await shot(page, `detail_${mode}`);
        });

        test('the public feed, three hours late', async ({ page }) => {
            await open(page, `mode=${mode}&tab=public`);
            await expect(page.getByTestId('public-explainer')).toContainText('3 hours behind, on purpose.');
            await expect(page.getByText(/A Thalassa sailor · 3 h ago · ~1 km area/)).toBeVisible();
            await expect(page.getByTestId('public-centre')).toHaveText('Around Airlie Beach');
            await noSidewaysScroll(page);
            await targets(page.getByTestId('sightings-page'));
            await shot(page, `page_public_${mode}`);
        });

        test('the life list', async ({ page }) => {
            await open(page, `mode=${mode}&tab=mine`);
            await page.getByRole('button', { name: 'Life list' }).click();
            await expect(page.getByTestId('life-list')).toContainText('Kittiwake Run’s species');
            await noSidewaysScroll(page);
            await targets(page.getByTestId('sightings-page'));
            await shot(page, `page_life_${mode}`);
        });

        test('the ways in: Scuttlebutt card and the Log page pill', async ({ page }) => {
            await open(page, `mode=${mode}&screen=scuttlebutt&seen=false`);
            const card = page.getByRole('button', { name: 'Sightings, new' });
            await expect(card).toBeVisible();
            expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(56);
            await noSidewaysScroll(page);
            await shot(page, `entry_scuttlebutt_${mode}`);

            await open(page, `mode=${mode}&screen=logpill`);
            const pill = page.getByRole('button', { name: 'Log a sighting' });
            await expect(pill).toBeVisible();
            const box = (await pill.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(48);
            const expand = (await page.getByRole('button', { name: 'Expand live map' }).boundingBox())!;
            expect(box.x + box.width).toBeLessThan(expand.x); // never under the expand button
            await shot(page, `entry_logpill_${mode}`);
        });

        test('the Log page when not recording: the pill tops the voyage list', async ({ page }) => {
            await open(page, `mode=${mode}&screen=logentry`);
            const entry = page.getByTestId('log-sighting-entry');
            await expect(entry).toBeVisible();
            const pill = entry.getByRole('button', { name: 'Log a sighting' });
            expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(48);
            await noSidewaysScroll(page);
            await shot(page, `entry_loglist_${mode}`);
        });

        test('signed out: logging still works, sharing asks you to sign in', async ({ page }) => {
            await open(page, `mode=${mode}&auth=signed-out&tab=crew`);
            await expect(page.getByTestId('sightings-signed-out')).toBeVisible();
            await targets(page.getByTestId('sightings-page'));
            await shot(page, `state_signedout_${mode}`);
        });
    });
}

test.describe('Sightings · states (dark)', () => {
    test('offline: waiting to send, and the crew feed from the last fetch', async ({ page }) => {
        await open(page, 'mode=dark&feed=offline&tab=crew');
        await expect(page.getByTestId('sightings-waiting')).toContainText('Offline · 3 waiting to send');
        await expect(page.getByText(/^Offline · crew feed from /)).toBeVisible();
        await shot(page, 'state_offline_dark');
    });

    test('stuck: waiting for a position, or refused, says so and offers the way out', async ({ page }) => {
        await open(page, 'mode=dark&feed=stuck&tab=mine');
        await expect(page.getByTestId('sightings-needs-position')).toContainText('2 need a position');
        await expect(page.getByTestId('sightings-not-sent')).toContainText('1 not sent');
        // A recent one retries from its row; an old one explains first, in the detail.
        await expect(page.getByRole('button', { name: 'Retry the position' })).toHaveCount(1);
        await targets(page.getByTestId('sightings-page'));
        await noSidewaysScroll(page);
        await shot(page, 'state_stuck_dark');
        await page.getByRole('button', { name: /^Turtle/ }).click();
        const detail = page.getByRole('dialog', { name: 'Turtle' });
        await expect(detail.getByTestId('needs-position')).toContainText('Only if you haven’t moved far since');
        await dialogFits(page, detail, detail.getByRole('button', { name: 'Delete' }));
        await shot(page, 'detail_needsposition_dark');
    });

    test('not pushed yet: saved on this phone, nothing to do', async ({ page }) => {
        await open(page, 'mode=dark&feed=notpushed&tab=mine');
        await expect(page.getByTestId('sightings-not-pushed')).toContainText('Sharing isn’t switched on yet');
        await shot(page, 'state_notpushed_dark');
    });

    test('empty: a first sighting waits', async ({ page }) => {
        await open(page, 'mode=dark&feed=empty&tab=crew');
        await expect(page.getByTestId('sightings-empty')).toContainText('No sightings yet');
        await shot(page, 'state_empty_dark');
    });

    test('boat GPS silent: the amber line comes before the tap', async ({ page }) => {
        await open(page, 'mode=dark&screen=quick&position=silent');
        const pick = page.getByRole('dialog', { name: 'What did you see?' });
        await expect(pick.getByText('Boat GPS isn’t answering.')).toBeVisible();
        await dialogFits(page, pick);
        await shot(page, 'quick_gpssilent_dark');
    });

    test('my map (tiles blocked here, as offline)', async ({ page }) => {
        await open(page, 'mode=dark&tab=mine');
        await page.getByRole('button', { name: 'Map' }).click();
        await expect(page.getByTestId('sightings-map')).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, 'page_map_dark');
    });
});

test.describe('Sightings · 320x568 SE', () => {
    const SE = { width: 320, height: 568 };

    test('the quick log fits, scrolls inside, and Done stays on screen', async ({ page }) => {
        await open(page, 'mode=dark&screen=quick', SE);
        const pick = page.getByRole('dialog', { name: 'What did you see?' });
        await expect(pick.getByText('Boat GPS (via Pi)')).toBeVisible();
        await dialogFits(page, pick);
        await noSidewaysScroll(page);
        await shot(page, 'se_quick_pick_dark');
        const logged = await logWhale(page);
        await dialogFits(page, logged, logged.getByRole('button', { name: 'Done' }));
        await noSidewaysScroll(page);
        await toTop(logged);
        await shot(page, 'se_quick_logged_dark');
        await logged.getByRole('button', { name: 'More…' }).click();
        const picker = page.getByRole('dialog', { name: 'Which species?' });
        await dialogFits(page, picker);
        await shot(page, 'se_picker_dark');
    });

    test('the page reads at 320', async ({ page }) => {
        await open(page, 'mode=dark&tab=crew', SE);
        await expect(page.getByText('Green turtle')).toBeVisible();
        await noSidewaysScroll(page);
        await targets(page.getByTestId('sightings-page'));
        await shot(page, 'se_page_crew_dark');
    });
});

test.describe('Sightings · iPad split pane', () => {
    for (const mode of ['dark', 'light'] as Mode[]) {
        test(`the sheet stays in its pane (${mode})`, async ({ page }) => {
            await open(page, `mode=${mode}&pane=true&screen=quick`, { width: 1024, height: 768 });
            const pick = page.getByRole('dialog', { name: 'What did you see?' });
            await dialogFits(page, pick);
            const logged = await logWhale(page);
            await dialogFits(page, logged, logged.getByRole('button', { name: 'Done' }));
            await noSidewaysScroll(page);
            await toTop(logged);
            await shot(page, `split_quick_logged_${mode}`);
        });
    }

    test('the page in the pane', async ({ page }) => {
        await open(page, 'mode=dark&pane=true&tab=crew', { width: 1024, height: 768 });
        await expect(page.getByText('Green turtle')).toBeVisible();
        await noSidewaysScroll(page);
        await shot(page, 'split_page_crew_dark');
    });
});
