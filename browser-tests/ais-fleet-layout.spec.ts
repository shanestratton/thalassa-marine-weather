import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`fleet AIS credit, limited coverage and silent targets fit${width}px`, async ({ page, baseURL }) => {
        const origin = new URL(baseURL!).origin;
        await page.route('**/*', (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 667 });
        await page.goto('/e2e/fixtures/ais-fleet.html');
        const credit = page.getByRole('link', { name: /Data: AISHub contributors/ });
        await expect(credit).toBeVisible();
        await expect(credit).toContainText('AIS centre 0 min ago · partial');
        expect(await credit.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const rect = await credit.boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        expect(rect!.height).toBeGreaterThanOrEqual(44);
        await page.getByRole('button', { name: 'Targets', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'AIS targets' });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText(/Do not use for navigation/)).toBeVisible();
        const target = sheet.getByRole('button', { name: /FICTIONAL RELAYED SART/ });
        await expect(target).toContainText('Internet · informational, silent');
        await expect(target).toContainText('6 min old');
        expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await target.click();
        await expect(page.getByRole('status')).toHaveText('Selected actual MMSI 970111111');
        await page.goto('/e2e/fixtures/ais-fleet.html?held=1');
        await expect(page.getByText('AIS held · licence review')).toBeVisible();
        await expect(page.getByRole('link', { name: /Data: AISHub contributors/ })).toHaveCount(0);
        await page.getByRole('button', { name: 'Targets', exact: true }).click();
        await expect(page.getByText('No targets match the display filters.')).toBeVisible();
        expect(errors).toEqual([]);
    });
