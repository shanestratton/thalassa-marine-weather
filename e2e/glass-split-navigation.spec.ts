import { test, expect, type Locator, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

type GlassProbe = Window & { __glassResetCount: number };

async function openGlass(page: Page, baseURL: string, width: number, height: number) {
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
    await page.addInitScript(() => {
        localStorage.setItem('thalassa_split_view', '0');
        for (const key of ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous']) {
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.settings.displayMode = 'dark';
            localStorage.setItem(key, JSON.stringify(saved));
        }
        const probe = window as unknown as GlassProbe;
        probe.__glassResetCount = 0;
        window.addEventListener('hero-reset-scroll', () => {
            probe.__glassResetCount += 1;
        });
        // No device GPS or permission prompt is needed for this navigation test.
        const denyPosition = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
            queueMicrotask(() =>
                error?.({
                    code: 1,
                    message: 'GPS disabled in navigation test',
                    PERMISSION_DENIED: 1,
                    POSITION_UNAVAILABLE: 2,
                    TIMEOUT: 3,
                }),
            );
        };
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: denyPosition,
                watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
                    denyPosition(success, error);
                    return 0;
                },
                clearWatch: () => undefined,
            },
        });
    });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Navigate to The Glass', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
}

const resetCount = (page: Page) => page.evaluate(() => (window as unknown as GlassProbe).__glassResetCount);
const splitPreference = (page: Page) => page.evaluate(() => localStorage.getItem('thalassa_split_view'));
const navigationCrumb = (page: Page) => page.evaluate(() => localStorage.getItem('thalassa.lastView'));

async function hold(page: Page, button: Locator) {
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // Exercise the actual 500ms pointer timer and the release-generated click.
    await page.waitForTimeout(650);
    await page.mouse.up();
    // The ordinary refresh is delayed 10ms; catch an unintended release refresh.
    await page.waitForTimeout(100);
}

test('Glass hold toggles dual screen while a short press refreshes the pinned Glass only', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(60_000);
    await openGlass(page, baseURL!, 1024, 768);
    const glass = page.getByRole('tab', { name: 'Navigate to The Glass', exact: true });
    const log = page.getByRole('tab', { name: 'Navigate to Log', exact: true });
    const initialResets = await resetCount(page);

    await hold(page, glass);
    await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();
    await expect(page.locator('[data-split-pane="page"]')).toBeVisible();
    await expect(log).toHaveAttribute('aria-selected', 'true');
    expect(await splitPreference(page)).toBe('1');
    expect(await resetCount(page)).toBe(initialResets);
    const rightPage = await navigationCrumb(page);
    expect(JSON.parse(rightPage!).view).toBe('details');

    await glass.click();
    await expect.poll(() => resetCount(page)).toBe(initialResets + 1);
    await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();
    await expect(page.locator('[data-split-pane="page"]')).toBeVisible();
    await expect(log).toHaveAttribute('aria-selected', 'true');
    expect(await splitPreference(page)).toBe('1');
    expect(await navigationCrumb(page)).toBe(rightPage);

    await hold(page, glass);
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
    await expect(page.locator('[data-split-pane="page"]')).toHaveCount(0);
    await expect(log).toHaveAttribute('aria-selected', 'true');
    expect(await splitPreference(page)).toBe('0');
    expect(await resetCount(page)).toBe(initialResets + 1);
    expect(await navigationCrumb(page)).toBe(rightPage);

    // Outside dual screen, the first tap navigates; tapping the active Glass
    // retains its established reset-to-live behavior without fetching weather.
    await glass.click();
    await expect(glass).toHaveAttribute('aria-selected', 'true');
    await expect(log).toHaveAttribute('aria-selected', 'false');
    expect(JSON.parse((await navigationCrumb(page))!).view).toBe('dashboard');
    expect(await resetCount(page)).toBe(initialResets + 1);
    await glass.click();
    await expect.poll(() => resetCount(page)).toBe(initialResets + 2);
    expect(await splitPreference(page)).toBe('0');
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
});

test('phone-width Glass hold cannot enable dual screen and ordinary taps still work', async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    await openGlass(page, baseURL!, 390, 844);
    const glass = page.getByRole('tab', { name: 'Navigate to The Glass', exact: true });
    const initialResets = await resetCount(page);

    await hold(page, glass);
    expect(await splitPreference(page)).toBe('0');
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
    // With no long-press callback at phone width, release is the ordinary tap.
    await expect.poll(() => resetCount(page)).toBe(initialResets + 1);

    const vessel = page.getByRole('tab', { name: 'Navigate to Vessel', exact: true });
    await vessel.click();
    await expect(vessel).toHaveAttribute('aria-selected', 'true');
    await glass.click();
    await expect(glass).toHaveAttribute('aria-selected', 'true');
    expect(await resetCount(page)).toBe(initialResets + 1);
    await glass.click();
    await expect.poll(() => resetCount(page)).toBe(initialResets + 2);
    expect(await splitPreference(page)).toBe('0');
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
});
