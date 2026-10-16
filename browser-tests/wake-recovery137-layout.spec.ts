import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`recovery remains deliberate and readable at ${width}px with large text`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 640 });
        const remote: string[] = [],
            errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            if (['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) return route.continue();
            remote.push(route.request().url());
            return route.abort();
        });
        await page.goto('/e2e/fixtures/wake-recovery137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const review = page.getByRole('region', { name: 'Review phone delivery setup' }),
            button = review.getByRole('button', { name: 'Restore phone delivery' }),
            consent = review.getByRole('checkbox', { name: 'Use these saved Pi rules for phone delivery' });
        await expect(review).toBeVisible();
        await expect(review.getByText(/different sensor feed/)).toBeVisible();
        await expect(review.getByRole('list')).toContainText('quiet 22:00–06:00 UTC+10:00');
        await expect(review.getByRole('list')).toContainText('no quiet hours');
        await expect(review.getByRole('list')).toContainText('Depth below keel: < 3 m');
        await expect(review.getByRole('list')).toContainText('True wind above: > 25 kn');
        await expect(button).toBeDisabled();
        await expect(page.getByLabel('Fictional review requests')).toHaveText('0');
        await consent.focus();
        await page.keyboard.press('Space');
        await expect(button).toBeEnabled();
        await page.getByRole('button', { name: 'Simulate changed Pi rules' }).click();
        await expect(consent).not.toBeChecked();
        await expect(button).toBeDisabled();
        await consent.focus();
        await page.keyboard.press('Space');
        await button.focus();
        await expect(button).toBeInViewport();
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Enter');
        await expect(page.getByLabel('Fictional review requests')).toHaveText('1');
        await expect(
            page.getByText('Review sent. Waiting for fresh Pi confirmation; delivery is not confirmed.'),
        ).toBeVisible();
        await expect(consent).not.toBeChecked();
        await expect(button).toBeDisabled();
        await expect(page.getByText('Locked-phone delivery is held for review.', { exact: false })).toBeVisible();
        expect(await page.locator('body').evaluate((n) => n.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`wake-recovery-${width}.png`), animations: 'disabled' });
        expect(remote).toEqual([]);
        expect(errors).toEqual([]);
    });
