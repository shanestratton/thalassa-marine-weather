import { expect, test, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Hit-test real pointer delivery, not just CSS numbers or DOM visibility. */
async function expectUncoveredTarget(target: Locator) {
    await expect(target).toBeVisible();
    await expect
        .poll(() =>
            target.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return {
                    covered: !hit || !element.contains(hit),
                    onScreen:
                        box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
                };
            }),
        )
        .toEqual({ covered: false, onScreen: true });
}

for (const viewport of [
    { name: 'small phone', width: 320, height: 568 },
    { name: 'landscape phone', width: 844, height: 390 },
    { name: 'desktop', width: 1280, height: 800 },
]) {
    test(`helm categories and items beat chart overlays, but not modals: ${viewport.name}`, async ({ page }) => {
        test.setTimeout(60_000);
        // Keep this lightweight source fixture tied to the actual app's
        // outer stacking boundary, not just an independently correct mock.
        const mapHub = readFileSync(resolve(process.cwd(), 'components/map/MapHub.tsx'), 'utf8');
        expect(mapHub.match(/<div\s+data-testid="map-hub"[^>]*>/)?.[0]).toMatch(/\bisolate\b/);
        await page.setViewportSize(viewport);
        const unexpectedRequests: string[] = [];
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === 'http://127.0.0.1:4204' && !url.pathname.startsWith('/api/')) return route.continue();
            unexpectedRequests.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/helm-stacking.html');
        const fixture = page.getByTestId('helm-fixture');
        const open = page.getByRole('button', { name: 'Open layer menu', exact: true });
        await expectUncoveredTarget(open);
        for (const target of [
            open,
            page.getByRole('button', { name: 'MOB, open Man Overboard emergency', exact: true }),
        ]) {
            const box = await target.boundingBox();
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box?.height).toBeGreaterThanOrEqual(44);
        }
        await open.click();
        const close = page.getByRole('button', { name: 'Close layer menu', exact: true });
        await expectUncoveredTarget(close);
        for (const [categoryName, itemName, state] of [
            ['Live layers', 'AIS', 'ais'],
            ['Sea layers', 'Tides', 'tides'],
            ['Sky layers', 'Wind', 'wind'],
            ['Routes overlays', 'Routes', 'routes'],
        ]) {
            const category = page.getByRole('menuitem', { name: categoryName, exact: true });
            await expectUncoveredTarget(category);
            await category.click();
            await expect(category).toHaveAttribute('aria-expanded', 'true');
            const item = page.getByRole('menuitemcheckbox', { name: `${itemName}, off`, exact: true });
            await expectUncoveredTarget(item);
            await item.click();
            await expect(fixture).toHaveAttribute(`data-${state}`, 'true');
        }
        // The production route entry dismisses before opening its picker.
        await expect(open).toBeVisible();
        await expect(fixture).toHaveAttribute('data-overlay-clicks', '0');

        await open.click();
        await expectUncoveredTarget(close);
        await close.click();
        await expect(page.getByRole('menu', { name: 'Map overlay categories', exact: true })).toHaveCount(0);
        // Prove the opaque popup does intercept chart taps once the menu closes.
        await page.getByTestId('chart-popup').click({ position: { x: 8, y: viewport.height - 8 } });
        await expect(fixture).toHaveAttribute('data-overlay-clicks', '1');

        await open.click();
        await page.getByRole('menuitem', { name: 'Live layers', exact: true }).click();
        for (const [name, zIndex] of [
            ['App modal', '1100'],
            ['Chart modal', '10050'],
        ]) {
            await page.getByRole('button', { name: 'Open blocking modal', exact: true }).click();
            const dialog = page.getByRole('dialog', { name, exact: true });
            await expect(dialog).toBeVisible();
            await expect(dialog).toHaveCSS('z-index', zIndex);
            // Every currently mounted helm control must hit the modal or its
            // backdrop, never the lower menu. This also verifies the scrim.
            await expect
                .poll(() =>
                    page.locator('.radial-helm-menu button').evaluateAll((buttons) =>
                        buttons.every((button) => {
                            const box = button.getBoundingClientRect();
                            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                            return !!hit?.closest('[data-modal-sheet-backdrop], [data-overlay-layer="modal"]');
                        }),
                    ),
                )
                .toBe(true);
            await expectUncoveredTarget(dialog.getByRole('button', { name: 'Close', exact: true }));
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expectUncoveredTarget(close);
        }
        await close.click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(fixture).toHaveAttribute('data-mob-opens', '0');
        expect(unexpectedRequests).toEqual([]);
        expect(errors).toEqual([]);
    });
}
