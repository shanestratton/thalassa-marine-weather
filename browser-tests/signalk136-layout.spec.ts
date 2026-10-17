import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`direct Signal K setup fits and refuses authenticated browser transport at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        const forbidden: string[] = [],
            sockets: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:') return route.continue();
            forbidden.push(u.origin);
            return route.abort();
        });
        page.on('websocket', (socket) => {
            if (!socket.url().includes('127.0.0.1')) sockets.push(socket.url());
        });
        await page.goto('/e2e/fixtures/nmea-udp136.html');
        await page.getByRole('button', { name: 'Signal K device setup', exact: true }).click();
        const card = page.getByRole('region', { name: 'Direct Signal K reader' });
        await expect(card).toBeVisible();
        await expect(card.getByText('Direct Signal K needs the iPhone or iPad app.', { exact: false })).toBeVisible();
        await card.getByLabel('Signal K server origin', { exact: true }).fill('https://boat.example');
        await card.getByLabel('Allow unencrypted HTTP only on my private boat network', { exact: true }).check();
        await expect(card.getByRole('button', { name: 'Request device access', exact: true })).toBeDisabled();
        await expect(card.getByRole('button', { name: 'Read Signal K', exact: true })).toBeDisabled();
        const stop = card.getByRole('button', { name: 'Stop reader', exact: true });
        await stop.scrollIntoViewIfNeeded();
        await expect(stop).toBeInViewport();
        expect(
            await stop.evaluate((el) => {
                const r = el.getBoundingClientRect();
                return (
                    r.bottom <= innerHeight - 64 &&
                    el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
                );
            }),
        ).toBe(true);
        await stop.click();
        await expect(card.getByRole('status')).toHaveText('Reader stopped');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(forbidden).toEqual([]);
        expect(sockets).toEqual([]);
    });
