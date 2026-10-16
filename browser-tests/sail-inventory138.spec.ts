import { expect, test } from '@playwright/test';
for (const width of [300, 375]) {
    test(`selected-vessel sail editor fits and saves at ${width}px with wide text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.protocol === 'blob:')
                return route.continue();
            remote.push(url.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/sail-inventory138.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        await page.getByRole('button', { name: 'Edit sails & crossovers' }).click();
        const dialog = page.getByRole('dialog', { name: /Sails/ });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Save sail inventory' })).toBeVisible();
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect(
            await dialog.evaluate((node) => {
                const box = node.getBoundingClientRect();
                return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
            }),
        ).toBe(true);
        await dialog.getByLabel('Name', { exact: true }).first().fill('My explicitly entered sail');
        await dialog.getByRole('button', { name: 'Save sail inventory' }).click();
        await expect(dialog).toHaveCount(0);
        const value = await page.evaluate(() =>
            (
                window as unknown as { __sailInventory138: { inventory: () => { sails: Array<{ name: string }> } } }
            ).__sailInventory138.inventory(),
        );
        expect(value.sails[0].name).toBe('My explicitly entered sail');
        await page.getByRole('button', { name: 'Edit sails & crossovers' }).click();
        await expect(page.getByRole('dialog', { name: /Sails/ })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('sail-editor.png') });
        await page.evaluate(() =>
            (window as unknown as { __sailInventory138: { switchBoat: () => void } }).__sailInventory138.switchBoat(),
        );
        await expect(page.getByRole('dialog', { name: /Sails/ })).toHaveCount(0);
        await page.getByRole('button', { name: 'Edit sails & crossovers' }).click();
        await expect(page.getByRole('dialog', { name: /Sails/ }).getByLabel('Name', { exact: true })).toHaveCount(0);
        await page.evaluate(() =>
            (
                window as unknown as { __sailInventory138: { switchAccount: () => void } }
            ).__sailInventory138.switchAccount(),
        );
        await expect(page.getByRole('dialog', { name: /Sails/ })).toHaveCount(0);
        expect(remote).toEqual([]);
    });
}
