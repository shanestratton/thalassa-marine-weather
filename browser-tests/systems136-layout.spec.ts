import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`measured Systems fit ${width}px with enlarged text and remain monitoring only`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 640 });
        const remote: string[] = [];
        page.on('request', (request) => {
            if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:'))
                remote.push(request.url());
        });
        await page.goto('/e2e/fixtures/systems136.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const opener = page.getByRole('button', { name: 'Systems' });
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'Boat systems' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/-5 A/)).toBeVisible();
        await expect(dialog.getByRole('region', { name: 'Solar' }).getByText(/125 W/)).toBeVisible();
        await expect(dialog.getByRole('region', { name: 'Autopilot' }).locator('dd')).toContainText('Auto');
        await expect(dialog.getByRole('button')).toHaveCount(1);
        const battery = dialog.getByRole('region', { name: 'Battery' });
        await battery.getByRole('combobox').selectOption(JSON.stringify(['b', 'bank2', 'venus.1']));
        await expect(battery.getByText(/12.8 V/)).toBeVisible();
        const overflow = await dialog.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
        expect(overflow).toBe(false);
        for (const card of await dialog.getByRole('region').all()) {
            const rect = await card.boundingBox();
            expect(rect!.y).toBeGreaterThanOrEqual(0);
            expect(rect!.y + rect!.height).toBeLessThanOrEqual(640);
        }
        const close = await dialog.getByRole('button', { name: 'Close' }).boundingBox();
        expect(close!.x + close!.width).toBeLessThanOrEqual(width);
        expect(close!.y).toBeGreaterThanOrEqual(0);
        await dialog.getByRole('button', { name: 'Close' }).focus();
        await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        await page.screenshot({ path: info.outputPath(`systems-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        expect(remote).toEqual([]);
    });
test('no reporting senders remain unknown instead of assuming physical instruments', async ({ page }) => {
    await page.goto('/e2e/fixtures/systems136.html?empty');
    await page.getByRole('button', { name: 'Systems' }).click();
    const dialog = page.getByRole('dialog', { name: 'Boat systems' });
    await expect(dialog.getByText('No current reported sender')).toHaveCount(5);
    await expect(dialog.getByText(/No current reported engine/)).toBeVisible();
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
    await expect(dialog.getByText('Standby', { exact: true })).toHaveCount(0);
});
