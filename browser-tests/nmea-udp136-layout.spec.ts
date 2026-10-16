import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

for (const width of [300, 375])
    test(`gateway unicast settings and honest web refusal fit ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const forbidden: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            forbidden.push(url.origin);
            return route.abort();
        });
        const sockets: string[] = [];
        page.on('websocket', (socket) => {
            if (!socket.url().includes('127.0.0.1')) sockets.push(socket.url());
        });
        await page.goto('/e2e/fixtures/nmea-udp136.html');
        const transport = page.getByLabel('Transport', { exact: true });
        await expect(transport).toHaveValue('tcp');
        expect(await transport.evaluate((element) => getComputedStyle(element).appearance)).toBe('none');
        await transport.selectOption('udp');
        await expect(page.getByText('Broadcast and multicast are unavailable.', { exact: false })).toBeVisible();
        const host = page.getByLabel('Host IP', { exact: true });
        await host.fill('239.1.2.3');
        const connect = page.getByRole('button', { name: 'Connect NMEA', exact: true });
        await connect.click();
        await expect(
            page.getByText('Enter the unicast IPv4 address of the gateway on this phone’s Wi-Fi.', { exact: true }),
        ).toBeVisible();
        await host.fill('192.0.2.151');
        await page.getByLabel('Port', { exact: true }).fill('10110');
        await connect.scrollIntoViewIfNeeded();
        await expect(connect).toBeInViewport();
        const box = await connect.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(667 - 64);
        const hit = await connect.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        });
        expect(hit).toBe(true);
        await connect.click();
        await expect(page.getByText('Unicast UDP needs the iPhone or iPad app', { exact: true })).toBeVisible();
        expect(
            await page.evaluate(() => ({
                transport: localStorage.getItem('nmea_transport'),
                host: localStorage.getItem('nmea_host'),
                port: localStorage.getItem('nmea_port'),
            })),
        ).toEqual({ transport: 'udp', host: '192.0.2.151', port: '10110' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(sockets).toEqual([]);
        expect(forbidden).toEqual([]);
        if (process.env.UDP136_SHOTS_DIR) {
            await mkdir(process.env.UDP136_SHOTS_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.UDP136_SHOTS_DIR, `${info.project.name}-${width}.png`) });
        }
    });
