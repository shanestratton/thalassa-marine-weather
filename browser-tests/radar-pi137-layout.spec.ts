import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`owned Pi radar control and unknown alarm fit ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const external: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'blob:') return route.continue();
            external.push(u.href);
            return route.abort();
        });
        await page.clock.setFixedTime(new Date('2026-01-02T12:00:00Z'));
        await page.goto('/e2e/fixtures/radar-pi137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        await expect(page.getByText('Pi radar watch off', { exact: true })).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __radarPi137: { calls: { arm: number; off: number } } }).__radarPi137.calls,
            ),
        ).toMatchObject({ arm: 0, off: 0 });
        await page.getByRole('button', { name: 'Arm Pi radar', exact: true }).click();
        const card = page.locator('[data-pi-radar-alarm]');
        await expect(card).toContainText('PI · RADAR TARGET 1');
        await expect(card).toContainText('Collision risk');
        expect(await card.locator('img').count()).toBe(0);
        expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('paired-radar-danger.png') });
        await page.evaluate(() =>
            (window as unknown as { __radarPi137: { lost: () => Promise<void> } }).__radarPi137.lost(),
        );
        await expect(card).toContainText('CPA unknown · not shown clear');
        await expect(card.getByRole('button', { name: 'Mute Pi radar 30 min' })).toBeDisabled();
        await page.evaluate(() =>
            (window as unknown as { __radarPi137: { ashore: () => Promise<void> } }).__radarPi137.ashore(),
        );
        await expect(page.getByText('Pi radar relay received · feed status unknown', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Stand Pi radar down' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Take over Pi radar watch' })).toHaveCount(0);
        await expect(card).toContainText('CPA unknown · not shown clear');
        await page.evaluate(() =>
            (window as unknown as { __radarPi137: { escalate: () => Promise<void> } }).__radarPi137.escalate(),
        );
        await expect(card).toContainText('Close quarters');
        await card.getByRole('button', { name: 'Acknowledge Pi radar episode' }).click();
        await expect(card).toHaveCount(0);
        await page.getByRole('button', { name: 'Stand Pi radar down' }).click();
        await expect(page.getByText('Pi radar watch off', { exact: true })).toBeVisible();
        await page.evaluate(() =>
            (window as unknown as { __radarPi137: { retire: () => void } }).__radarPi137.retire(),
        );
        await expect(page.getByText('Pi radar watch unconfirmed', { exact: true })).toBeVisible();
        expect(external).toEqual([]);
    });
