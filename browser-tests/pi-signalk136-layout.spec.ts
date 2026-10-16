import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`paired Pi notification controls and original source display at ${width}px`, async ({ page }) => {
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
        await page.goto('/e2e/fixtures/pi-signalk136.html');
        const card = page.getByRole('region', { name: 'Paired Pi Signal K notifications', exact: true });
        await expect(card).toBeVisible();
        await page.addStyleTag({ content: 'html { font-size: 130%; }' });
        const read = card.getByRole('button', { name: 'Read Pi notifications', exact: true });
        await read.scrollIntoViewIfNeeded();
        expect(
            await read.evaluate((el) => {
                const r = el.getBoundingClientRect();
                return (
                    r.width >= 44 &&
                    r.height >= 44 &&
                    r.bottom <= innerHeight - 64 &&
                    el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
                );
            }),
        ).toBe(true);
        await read.click();
        await expect(card.getByRole('status')).toHaveText('Paired Pi source unavailable');
        const example = page.getByRole('region', { name: 'Fictional notification example', exact: true });
        await example.scrollIntoViewIfNeeded();
        await expect(
            example.getByText('Paired Pi · server notifications · source-dated', { exact: true }),
        ).toBeVisible();
        const path = example.getByText('notifications.depth.transducer.belowKeel', { exact: true });
        await path.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await expect(path).toBeInViewport();
        expect(await path.evaluate((element) => element.getBoundingClientRect().bottom <= innerHeight - 64)).toBe(true);
        await expect(example.getByText(/fictional-receiver\.1 · .* UTC · \d+ s old/)).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`paired-pi-${width}.png`), fullPage: true });
        expect(forbidden).toEqual([]);
        expect(sockets).toEqual([]);
    });
