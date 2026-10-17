import { test, expect } from '@playwright/test';
for (const width of [300, 375])
    test(`actual notice viewport, source clocks and Charts toggle fit ${width}px130%`, async ({
        page,
        baseURL,
    }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const unexpected: string[] = [],
            errors: string[] = [];
        const origin = new URL(baseURL!).origin;
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            // WebKit routes local generated worker blobs too. Their origin
            // must be this fixture; no foreign blob or remote request escapes.
            if (url.origin === origin) {
                if (url.pathname === '/notices/notices-au.json')
                    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"notices":[]}' });
                return route.continue();
            }
            if (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1')
                return route.fulfill({ status: 200, body: '' });
            if (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2')
                return route.fulfill({ status: 204, body: '' });
            unexpected.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/obs-notices139.html');
        await expect(page.getByTestId('notice-map-ready')).toHaveText('ready');
        await page.addStyleTag({ content: 'html{font-size:130% !important}' });
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(0);
        await page.evaluate(() => window.__obsNoticeMap.jumpTo({ zoom: 9 }));
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(2);
        const notice = page.getByRole('button', { name: 'Notice: Fictional broadcast warning', exact: true });
        const box = (await notice.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await notice.click();
        const popup = page.locator('.ntm-popup');
        await expect(popup.getByText('Fictional broadcast warning', { exact: true })).toBeInViewport();
        await expect(popup).toContainText('160000Z OCT 2026');
        await expect(popup).toContainText('Source checked: 2h ago');
        await expect(popup).toContainText('Coverage is incomplete');
        await expect(popup).toContainText('<img src=x');
        await expect(popup.locator('img')).toHaveCount(0);
        const bounds = (await popup.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(667);
        const close = popup.getByRole('button', { name: 'Close popup' });
        expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: info.outputPath('broadcast-popup.png') });
        await close.click();
        await page.getByRole('button', { name: 'Notice: Fictional Queensland shoal' }).click();
        await expect(popup).toContainText('Issued: 01/10/2026');
        await expect(popup).toContainText('Approximate locality');
        await expect(popup.getByRole('link', { name: 'Read official source' })).toHaveAttribute(
            'href',
            'https://www.publications.qld.gov.au/example.pdf',
        );
        await close.click();
        await page.evaluate(() => document.documentElement.classList.add('display-light'));
        await notice.click();
        expect(await popup.locator('.obs-notice-content').evaluate((el) => getComputedStyle(el).color)).toBe(
            'rgb(15, 23, 42)',
        );
        await page.screenshot({ path: info.outputPath('daylight-popup.png') });
        await close.click();
        await page.evaluate(() => document.documentElement.classList.remove('display-light'));
        await page.getByRole('button', { name: 'Charts & detail', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Charts & detail', exact: true }),
            toggle = sheet.getByRole('checkbox', { name: 'Notices on Obs' });
        await expect(toggle).toBeChecked();
        await toggle.uncheck();
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('charts-notice-toggle.png') });
        await toggle.check();
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(2);
        await page.evaluate(() => window.__obsNoticeMap.jumpTo({ center: [0, 20] }));
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(1);
        await page.evaluate(() => window.__obsNoticeMap.jumpTo({ center: [179.9, 0], zoom: 8 }));
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(0);
        await page.evaluate(() => window.__obsNoticeMap.jumpTo({ zoom: 9 }));
        await notice.click();
        await page.evaluate(() => window.__obsNoticeSwitch());
        await expect(popup).toHaveCount(0);
        await page.evaluate(() => window.__obsNoticeForeground(false));
        await expect(page.getByRole('button', { name: /^Notice:/ })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBe(0);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
    });
