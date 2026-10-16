import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`Log track-route menu fits ${width}px at 130%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 680 });
        const outbound: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
            outbound.push(url.origin);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/track-route139.html');
        await page.addStyleTag({ content: 'html{font-size:130%;font-family:Verdana,"DejaVu Sans",sans-serif}' });
        const trigger = page.getByRole('button', { name: 'Log actions', exact: true });
        await expect(trigger).toBeVisible();
        const before = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
        }));
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Log actions' }),
            action = dialog.getByRole('button', { name: 'Make route from track', exact: true });
        await expect(action).toBeEnabled();
        await action.scrollIntoViewIfNeeded();
        const box = await action.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(680);
        expect(await action.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath('track-route-log-menu.png') });
        await action.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('status')).toContainText(
            'Past voyage picker requested. Navigation remains stopped.',
        );
        expect(
            await page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            })),
        ).toEqual(before);
        expect(outbound).toEqual([]);
    });
