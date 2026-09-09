import { test, expect, type Locator } from '@playwright/test';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';

test.use({
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: baseURL! })),
        });
    },
});

async function geometry(port: Locator) {
    return port.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
        height: element.clientHeight,
        paddingTop: parseFloat(getComputedStyle(element).paddingTop),
        paddingBottom: parseFloat(getComputedStyle(element).paddingBottom),
        snapType: getComputedStyle(element).scrollSnapType,
    }));
}

async function contained(element: Locator, port: Locator) {
    const inner = await element.boundingBox();
    const outer = await port.boundingBox();
    return !!inner && !!outer && inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

for (const size of [
    { width: 390, height: 650 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 768 },
    { width: 390, height: 844, mode: 'light' },
    { width: 390, height: 844, mode: 'night' },
]) {
    test(`Vessel first row returns fully at ${size.width}x${size.height} ${size.mode ?? 'dark'}`, async ({
        page,
    }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize(size);
        await page.addInitScript((mode) => {
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.displayMode = mode;
                localStorage.setItem(key, JSON.stringify(saved));
            }
        }, size.mode ?? 'dark');
        await page.goto('/');
        await page.getByRole('tab', { name: 'Navigate to Vessel', exact: true }).click();
        const diary = page.getByRole('button', { name: 'Open Diary', exact: true });
        const chat = page.getByRole('button', { name: 'Open Scuttlebutt', exact: true });
        await expect(diary).toBeVisible({ timeout: 25_000 });
        const port = page.locator('.vessel-hub-surface > .overflow-y-auto').filter({ has: diary });
        const deck = page.getByRole('region', { name: 'Vessel status and safety controls' });
        await expect(port).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Expand Settings & Connect' })).toBeVisible();
        // Both snap targets have staggered entrance transforms. Measure only
        // after every direct child's entrance has settled, not just the first.
        await port.evaluate(async (el) => {
            await Promise.all(
                Array.from(el.children).flatMap((child) =>
                    child.getAnimations().map((animation) => animation.finished),
                ),
            );
        });
        const initialDeck = await deck.boundingBox();
        const before = await geometry(port);
        await testInfo.attach('vessel-initial-geometry', {
            body: JSON.stringify(before),
            contentType: 'application/json',
        });
        // A large phone may fit all collapsed cards. It should stay at home,
        // while a shorter pane may genuinely need scrolling.
        await port.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));

        // Model the end of a return gesture with the first row still partly
        // beneath the fixed deck. The resting position must be exactly home.
        await port.evaluate((el) => el.scrollTo({ top: 24, behavior: 'instant' }));
        await expect.poll(async () => Math.abs((await geometry(port)).top)).toBeLessThanOrEqual(1);
        const portRect = await port.boundingBox();
        for (const tile of [diary, chat]) {
            const rect = await tile.boundingBox();
            expect(rect!.y).toBeCloseTo(portRect!.y + before.paddingTop, 0);
            expect(rect!.y + rect!.height).toBeLessThanOrEqual(portRect!.y + portRect!.height + 1);
        }
        expect(await deck.boundingBox()).toEqual(initialDeck);

        // A proximity target must not trap the user at the top when a lower
        // section is expanded; its actual controls must remain reachable.
        await page.getByRole('button', { name: 'Expand Settings & Connect' }).click();
        const account = page.getByRole('button', { name: 'Account & Settings', exact: true });
        // Let the real 250ms expansion and delayed section scroll finish.
        // Racing that scroll with our return gesture would test two competing
        // programmatic scrolls rather than the user's settled page.
        await page.getByRole('button', { name: 'Collapse Settings & Connect' }).evaluate(async (button) => {
            const group = button.parentElement!;
            void group.getBoundingClientRect();
            await Promise.all(group.getAnimations({ subtree: true }).map((animation) => animation.finished));
        });
        await expect.poll(() => contained(account, port)).toBe(true);
        await expect.poll(async () => (await geometry(port)).max).toBeGreaterThan(before.max);
        await port.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
        await expect.poll(async () => (await geometry(port)).top).toBeGreaterThan(0);
        const bottomPort = await port.boundingBox();
        await expect
            .poll(async () => {
                const rect = await account.boundingBox();
                return rect!.y + rect!.height;
            })
            .toBeLessThanOrEqual(bottomPort!.y + bottomPort!.height + 1);
        const accountRect = await account.boundingBox();
        expect(accountRect!.y).toBeGreaterThanOrEqual(bottomPort!.y - 1);
        expect(accountRect!.y + accountRect!.height).toBeLessThanOrEqual(bottomPort!.y + bottomPort!.height + 1);
        expect(await deck.boundingBox()).toEqual(initialDeck);

        await port.evaluate((el) => el.scrollTo({ top: 24, behavior: 'instant' }));
        await expect.poll(async () => Math.abs((await geometry(port)).top)).toBeLessThanOrEqual(1);
        await expect(diary).toBeVisible();
        await expect(chat).toBeVisible();
    });
}

test.describe('native wheel input', () => {
    // Mobile WebKit does not support wheel input; mobile geometry is above.
    test.use({ isMobile: false, hasTouch: false });

    test('Vessel returns home after a wheel gesture without moving the safety deck', async ({ page }) => {
        await page.setViewportSize({ width: 768, height: 650 });
        await page.goto('/');
        await page.getByRole('tab', { name: 'Navigate to Vessel', exact: true }).click();
        const diary = page.getByRole('button', { name: 'Open Diary', exact: true });
        const port = page.locator('.vessel-hub-surface > .overflow-y-auto').filter({ has: diary });
        const deck = page.getByRole('region', { name: 'Vessel status and safety controls' });
        await expect(diary).toBeVisible({ timeout: 25_000 });
        // Match the geometry cases above: the incoming cards must finish
        // their entrance transforms before WebKit hit-tests a wheel gesture.
        await port.evaluate(async (el) => {
            await document.fonts.ready;
            await Promise.all(
                Array.from(el.children).flatMap((child) =>
                    child.getAnimations().map((animation) => animation.finished),
                ),
            );
        });
        const deckBefore = await deck.boundingBox();
        await port.hover();
        await page.mouse.wheel(0, 1000);
        await expect.poll(async () => (await geometry(port)).top).toBeGreaterThan(30);
        // mouse.wheel returns before native scrolling/snap has finished.
        // Reading the first moving offset made the reverse delta too small.
        let previousTop = -1;
        let stableReadings = 0;
        await expect
            .poll(
                async () => {
                    const { top } = await geometry(port);
                    stableReadings = Math.abs(top - previousTop) < 0.5 ? stableReadings + 1 : 0;
                    previousTop = top;
                    return stableReadings;
                },
                { intervals: [100] },
            )
            .toBeGreaterThanOrEqual(3);
        const lower = await geometry(port);
        // Stop the gesture just short of home and let native snapping settle.
        await page.mouse.wheel(0, -(lower.top - 12));
        await expect.poll(async () => Math.abs((await geometry(port)).top)).toBeLessThanOrEqual(1);
        await expect.poll(() => contained(diary, port)).toBe(true);
        expect(await deck.boundingBox()).toEqual(deckBefore);
        await page.mouse.wheel(0, -1000);
        await expect.poll(async () => Math.abs((await geometry(port)).top)).toBeLessThanOrEqual(1);
        expect(await deck.boundingBox()).toEqual(deckBefore);
    });
});
