import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

/**
 * The Glass's Locations box at phone size (Shane 2026-10-13, build 128):
 * saved places delete with a right-to-left swipe, Delete then Confirm, as the
 * saved-route rows do; the swipe never opens the place; the delete survives a
 * reload. Real touches through Chromium's DevTools protocol, so the browser
 * decides for itself whether a gesture was a tap. Fictional places, worldwide.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'Real touch sequences go through Chromium DevTools');

test.use({
    serviceWorkers: 'block',
    hasTouch: true,
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

const PLACES = ['Falmouth, England, GB', 'Lyttelton, Canterbury, NZ', 'Annapolis, MD, US'];
const SETTINGS_KEYS = ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous'];

async function openGlass(page: Page, baseURL: string, width = 390, height = 844) {
    await page.setViewportSize({ width, height });
    const origin = new URL(baseURL).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const staticRead =
            url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/functions/');
        return staticRead ? route.continue() : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(
        ({ places, keys }) => {
            // Seed once: a reload must show what the app itself saved.
            if (sessionStorage.getItem('tidy128-seeded')) return;
            sessionStorage.setItem('tidy128-seeded', '1');
            localStorage.setItem('thalassa_split_view', '0');
            for (const key of keys) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.displayMode = 'dark';
                saved.settings.savedLocations = [...places, 'Sydney, NSW'];
                saved.settings.savedLocationCoords = {
                    'Falmouth, England, GB': { lat: 50.153, lon: -5.067 },
                    'Lyttelton, Canterbury, NZ': { lat: -43.603, lon: 172.72 },
                    'Annapolis, MD, US': { lat: 38.978, lon: -76.492 },
                };
                localStorage.setItem(key, JSON.stringify(saved));
            }
            const deny = (_ok: PositionCallback, error?: PositionErrorCallback | null) =>
                queueMicrotask(() =>
                    error?.({
                        code: 1,
                        message: 'GPS off in this test',
                        PERMISSION_DENIED: 1,
                        POSITION_UNAVAILABLE: 2,
                        TIMEOUT: 3,
                    }),
                );
            Object.defineProperty(navigator, 'geolocation', {
                configurable: true,
                value: {
                    getCurrentPosition: deny,
                    watchPosition: (ok: PositionCallback, error?: PositionErrorCallback | null) => {
                        deny(ok, error);
                        return 0;
                    },
                    clearWatch: () => undefined,
                },
            });
        },
        { places: PLACES, keys: SETTINGS_KEYS },
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Saved locations', exact: true })).toBeVisible();
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Saved locations', exact: true });
const placeRow = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });

async function openMenu(page: Page) {
    await page.getByRole('button', { name: 'Saved locations', exact: true }).tap();
    await expect(menu(page)).toBeVisible();
}

async function centre(target: Locator) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, box: box! };
}

/** A real finger: touchStart, moves, touchEnd. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, dx: number) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: from.x + (dx * step) / 8, y: from.y }],
        });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const savedNames = (page: Page) =>
    page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key)!);
        return {
            names: saved.settings.savedLocations as string[],
            coords: Object.keys(saved.settings.savedLocationCoords ?? {}),
        };
    }, SETTINGS_KEYS[0]);

test('a swipe shows Delete without opening the place; Delete, Confirm, and it stays gone after a reload', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(90_000);
    await openGlass(page, baseURL!);
    const cdp = await page.context().newCDPSession(page);
    const location = page.getByRole('textbox', { name: 'Current location', exact: true });
    const before = await location.inputValue();
    await openMenu(page);
    await expect(menu(page).getByText('Remove', { exact: true })).toHaveCount(0);

    const falmouth = placeRow(page, PLACES[0]);
    const start = await centre(falmouth);
    await swipe(cdp, { x: start.x + 60, y: start.y }, -110);
    const del = menu(page).getByRole('menuitem', { name: `Delete ${PLACES[0]}`, exact: true });
    await expect(del).toBeVisible();
    await expect(del).toHaveText('Delete');
    // The swipe opened nothing: the flyout is still up, the Glass still shows its place.
    await expect(menu(page)).toBeVisible();
    await expect(location).toHaveValue(before);
    // Delete sits inside the flyout, at the row's right edge.
    const flyout = (await menu(page).boundingBox())!;
    const delBox = (await del.boundingBox())!;
    expect(delBox.x + delBox.width).toBeLessThanOrEqual(flyout.x + flyout.width + 0.5);
    expect(delBox.x).toBeGreaterThanOrEqual(flyout.x);

    await del.tap();
    const confirm = menu(page).getByRole('menuitem', { name: `Confirm delete ${PLACES[0]}`, exact: true });
    await expect(confirm).toHaveText('Confirm');
    expect((await savedNames(page)).names).toContain(PLACES[0]);
    await confirm.tap();
    await expect(placeRow(page, PLACES[0])).toHaveCount(0);
    await expect(menu(page)).toBeVisible();
    await expect(placeRow(page, PLACES[1])).toBeVisible();
    await expect.poll(async () => (await savedNames(page)).names).toEqual([PLACES[1], PLACES[2], 'Sydney, NSW']);
    expect((await savedNames(page)).coords).not.toContain(PLACES[0]);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Saved locations', exact: true })).toBeVisible();
    await openMenu(page);
    await expect(placeRow(page, PLACES[0])).toHaveCount(0);
    await expect(placeRow(page, PLACES[1])).toBeVisible();
    await expect(placeRow(page, PLACES[2])).toBeVisible();
});

test('a short swipe snaps back and still does not open the place; a tap does; Set home stays a tap', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(90_000);
    await openGlass(page, baseURL!);
    const cdp = await page.context().newCDPSession(page);
    await openMenu(page);
    const lyttelton = placeRow(page, PLACES[1]);
    const start = await centre(lyttelton);
    await swipe(cdp, { x: start.x + 40, y: start.y }, -16);
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: `Delete ${PLACES[1]}`, exact: true })).toHaveCount(0);

    await menu(page)
        .getByRole('menuitem', { name: `Set home port to ${PLACES[2]}`, exact: true })
        .tap();
    await expect(menu(page).getByRole('menuitem', { name: /^Annapolis, MD, US\s*Home$/ })).toBeVisible();
    await expect
        .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).settings.homePort, SETTINGS_KEYS[0]))
        .toBe(PLACES[2]);

    await lyttelton.tap();
    await expect(menu(page)).toHaveCount(0);
});

for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
]) {
    test(`the flyout fits ${size.width} x ${size.height} in wide fonts, a long name using the freed width`, async ({
        page,
        baseURL,
    }) => {
        test.setTimeout(90_000);
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                const wide = document.createElement('style');
                wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
                document.head.append(wide);
            });
        });
        await openGlass(page, baseURL!, size.width, size.height);
        await openMenu(page);
        const flyout = (await menu(page).boundingBox())!;
        expect(flyout.x).toBeGreaterThanOrEqual(8);
        expect(flyout.x + flyout.width).toBeLessThanOrEqual(size.width - 8);
        expect(flyout.y + flyout.height).toBeLessThanOrEqual(size.height);
        for (const name of PLACES) {
            const home = (await menu(page)
                .getByRole('menuitem', { name: `Set home port to ${name}`, exact: true })
                .boundingBox())!;
            expect(home.x + home.width, `${name}: Set home inside the flyout`).toBeLessThanOrEqual(
                flyout.x + flyout.width,
            );
            // The name gets the width Remove gave up: at least 60 % of the flyout.
            const nameBox = (await placeRow(page, name).boundingBox())!;
            expect(nameBox.width / flyout.width, `${name}: name width`).toBeGreaterThanOrEqual(0.6);
        }
    });
}
