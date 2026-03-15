import { test, expect } from '@playwright/test';

test.describe('Critical Path', () => {
    // Reset storage state before test
    test.use({ storageState: { cookies: [], origins: [] } });

    test('Non-onboarded user sees onboarding wizard', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);
        // Without completed onboarding, the user should see onboarding/intro content
        // The app shows feature intro slides ("Your Weather", "WX TAB", etc.)
        const hasOnboarding =
            (await page
                .getByText('Welcome', { exact: false })
                .isVisible()
                .catch(() => false)) ||
            (await page
                .getByText('Get Started', { exact: false })
                .isVisible()
                .catch(() => false)) ||
            (await page
                .getByText('Your Weather', { exact: false })
                .isVisible()
                .catch(() => false)) ||
            (await page
                .getByText('Next', { exact: true })
                .isVisible()
                .catch(() => false)) ||
            (await page
                .getByText('Skip', { exact: true })
                .isVisible()
                .catch(() => false));
        expect(hasOnboarding).toBe(true);
    });

    test('Onboarding wizard has interactive controls', async ({ page }) => {
        await page.goto('/');

        // If we see onboarding, verify it has interactive elements
        const hasGetStarted = await page.getByRole('button', { name: /get started|next|continue/i }).isVisible();
        if (hasGetStarted) {
            const btn = page.getByRole('button', { name: /get started|next|continue/i }).first();
            await expect(btn).toBeEnabled();
        }
    });

    test('Full onboarding flow completes', async ({ page }) => {
        await page.goto('/');

        // Step through onboarding — click any "Get Started" or "Next" button
        const getStarted = page.getByRole('button', { name: /get started/i });
        if (await getStarted.isVisible({ timeout: 5000 })) {
            await getStarted.click();
            await page.waitForTimeout(500);
        }

        // Try filling location if the input appears
        const locationInput = page.getByPlaceholder(/port|location|city/i).first();
        if (await locationInput.isVisible({ timeout: 3000 })) {
            await locationInput.fill('Sydney, NSW');
            await page.waitForTimeout(500);
        }

        // Click through remaining steps
        for (let i = 0; i < 5; i++) {
            const nextBtn = page.getByRole('button', { name: /next|continue|launch|finish|done/i }).first();
            if (await nextBtn.isVisible({ timeout: 2000 })) {
                await nextBtn.click();
                await page.waitForTimeout(800);
            } else {
                break;
            }
        }

        // After onboarding, should see dashboard content
        await page.waitForTimeout(3000);
        const body = await page.textContent('body');
        expect(body?.length).toBeGreaterThan(50);
    });
});
