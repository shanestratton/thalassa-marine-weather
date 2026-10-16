import { test, expect } from '@playwright/test';
for (const width of [300, 375])
    test(`optional marine radar profile fits ${width}px at 130%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 780 });
        const outbound: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
            outbound.push(url.origin);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/radar-equipment137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const bounds = () =>
            page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            }));
        const before = await bounds();
        await expect(page.getByTestId('saved-equipment')).toHaveText('null');
        await page.getByRole('button', { name: /Marine radar/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Marine radar' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('Make', { exact: true })).toHaveValue('');
        await dialog.getByLabel('Make', { exact: true }).selectOption('raymarine');
        await dialog.getByLabel('Model', { exact: true }).selectOption('raymarine-quantum-2');
        await dialog.getByLabel('Make', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('radar-equipment-selection.png') });
        await expect(dialog).toContainText('Selecting a model does not connect its radar image to Obs');
        await dialog.getByRole('button', { name: 'Auto-detect' }).click();
        await expect(dialog).toContainText('A current paired Pi radar feed could not be verified');
        await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('raymarine-quantum-2');
        expect(await bounds()).toEqual(before);
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        for (const selector of ['select', 'button', 'input'])
            for (const node of await dialog.locator(selector).all()) {
                if (!(await node.isVisible())) continue;
                const b = await node.boundingBox();
                expect(b!.width).toBeLessThanOrEqual(width);
                expect(b!.height).toBeGreaterThanOrEqual(44);
            }
        await page.screenshot({ path: info.outputPath('radar-equipment-known.png') });
        await dialog.getByRole('button', { name: 'Save equipment' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByTestId('saved-equipment')).toContainText('raymarine-quantum-2');
        await page.getByRole('button', { name: /Marine radar/ }).click();
        await dialog.getByLabel('Model', { exact: true }).selectOption('');
        await dialog.getByLabel('Model details (optional)').fill('Raymarine · model label not yet checked');
        await dialog.getByRole('button', { name: 'Save equipment' }).click();
        await expect(page.getByRole('button', { name: /Marine radar/ })).toContainText('model label not yet checked');
        await page.getByRole('button', { name: /Marine radar/ }).click();
        await dialog.getByRole('button', { name: 'Clear equipment' }).click();
        await expect(page.getByTestId('saved-equipment')).toHaveText('null');
        expect(await bounds()).toEqual(before);
        expect(outbound).toEqual([]);
    });
