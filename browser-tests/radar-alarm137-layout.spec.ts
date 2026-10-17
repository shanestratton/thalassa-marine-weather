import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`radar source/episode actions remain reachable at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const external: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            external.push(url.href);
            return route.abort();
        });
        await page.clock.setFixedTime(new Date('2026-01-02T12:00:00Z'));
        await page.goto('/e2e/fixtures/radar-alarm137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const card = page.locator('[data-radar-alarm]');
        await expect(card).toContainText('PHONE · RADAR TARGET 1');
        await expect(card).toContainText('Collision risk');
        expect(await card.locator('img').count()).toBe(0);
        expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath('radar-danger.png') });
        await page.evaluate(() =>
            (window as unknown as { __radarAlarm137: { lost: () => void } }).__radarAlarm137.lost(),
        );
        await expect(card).toContainText('CPA unknown · not shown clear');
        await card.getByRole('button', { name: /Mute for 30 minutes radar target/ }).click();
        await expect(card).toHaveCount(0);
        await page.getByRole('button', { name: 'Generate close quarters' }).click();
        await expect(card).toContainText('Close quarters');
        expect(
            await page.evaluate(() =>
                (window as unknown as { __radarAlarm137: { oldAck: () => boolean } }).__radarAlarm137.oldAck(),
            ),
        ).toBe(false);
        await expect(card).toHaveCount(1);
        await page.screenshot({ path: info.outputPath('radar-escalation.png') });
        await card.getByRole('button', { name: /Acknowledge radar target/ }).click();
        await expect(card).toHaveCount(0);
        expect(external).toEqual([]);
    });
