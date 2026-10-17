import { test, expect } from '@playwright/test';

for (const width of [300, 375])
    test(`popup light rhythm, live reduced motion and teardown ${width}px130%`, async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [],
            external: string[] = [];
        const origin = new URL(baseURL!).origin;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            external.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto('/e2e/fixtures/light140.html');
        await page.addStyleTag({ content: 'html{font-size:130%!important}' });
        await page.getByRole('button', { name: 'Open enc', exact: true }).click();
        const popup = page.getByRole('region', { name: 'Fictional popup', exact: true });
        await expect(popup).toContainText('Reported rhythm · 10 s');
        const lamp = popup.locator('.light-rhythm-lamp');
        await expect(lamp).toHaveAttribute('fill', '#ef4444');
        await expect.poll(() => lamp.evaluate((node) => node.getAnimations().length)).toBe(1);
        const evidence = await lamp.evaluate((node) => {
            const animation = node.getAnimations()[0];
            const running = animation.playState;
            const duration = animation.effect!.getTiming().duration;
            animation.pause();
            const samples = [100, 500, 2100, 2500, 9900, 10100].map((time) => {
                animation.currentTime = time;
                return { time, opacity: getComputedStyle(node).opacity };
            });
            animation.play();
            return { running, duration, samples };
        });
        expect(evidence.running).toBe('running');
        expect(evidence.duration).toBe(10000);
        expect(evidence.samples.map((sample) => sample.opacity)).toEqual(['1', '0', '1', '0', '0', '1']);
        await info.attach('actual-css-timing', {
            body: JSON.stringify(evidence, null, 2),
            contentType: 'application/json',
        });
        await page.screenshot({ path: info.outputPath('enc-light.png') });

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await expect(popup.locator('.light-rhythm-static')).toBeVisible();
        await expect
            .poll(() =>
                lamp.evaluate((node) => ({
                    animations: node.getAnimations().length,
                    opacity: getComputedStyle(node).opacity,
                })),
            )
            .toEqual({ animations: 0, opacity: '1' });
        await page.screenshot({ path: info.outputPath('reduced-motion.png') });
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(popup).toHaveCount(0);
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

        await page.getByRole('button', { name: 'Open osm', exact: true }).click();
        await expect(lamp).toHaveAttribute('fill', '#22c55e');
        expect(await lamp.evaluate((node) => node.getAnimations().length)).toBe(0);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect.poll(() => lamp.evaluate((node) => node.getAnimations().length)).toBe(1);
        expect(await lamp.evaluate((node) => node.getAnimations()[0].effect!.getTiming().duration)).toBe(4000);
        await page.screenshot({ path: info.outputPath('osm-light.png') });
        const rect = await popup.boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);

        await page.getByRole('button', { name: 'Open unknown', exact: true }).click();
        await expect(popup).toContainText('Rhythm preview unavailable');
        await expect(popup.locator('svg')).toHaveCount(0);
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
    });
