import { test, expect } from '@playwright/test';

test.describe('App Smoke Tests', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('app loads without crash', async ({ page }) => {
        await page.goto('/');
        // Should land on onboarding or dashboard — either way, no crash
        await expect(page.locator('body')).toBeVisible();
        // No React error overlay
        await expect(page.locator('#react-error-overlay')).not.toBeVisible();
        // Page should have content
        const text = await page.textContent('body');
        expect(text?.length).toBeGreaterThan(10);
    });

    test('page has correct document title', async ({ page }) => {
        await page.goto('/');
        const title = await page.title();
        // Should have a meaningful title (not blank or default)
        expect(title.length).toBeGreaterThan(0);
    });
});

// ── Preview Deploy Smoke Tests ───────────────────────────────
// These run against Vercel preview URLs via the preview-smoke workflow.
// PREVIEW_URL is set by the GitHub Actions workflow.

const PREVIEW_URL = process.env.PREVIEW_URL;

test.describe('Preview Deploy Smoke Tests', () => {
    test.skip(!PREVIEW_URL, 'PREVIEW_URL not set — skipping preview tests');

    test('preview loads without fatal errors', async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        const response = await page.goto(PREVIEW_URL!, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        expect(response?.status()).toBeLessThan(400);
        await page.waitForTimeout(3000);

        // Filter known benign errors
        const fatalErrors = consoleErrors.filter(
            (e) => !e.includes('readonly property') && !e.includes('ResizeObserver') && !e.includes('Failed to fetch'),
        );
        expect(fatalErrors).toHaveLength(0);
    });

    test('preview React root renders', async ({ page }) => {
        await page.goto(PREVIEW_URL!, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        const root = page.locator('#root');
        await expect(root).toBeVisible();
        const childCount = await root.evaluate((el) => el.children.length);
        expect(childCount).toBeGreaterThan(0);
    });

    test('preview has no blocking CSP violations', async ({ page }) => {
        const cspViolations: string[] = [];
        page.on('console', (msg) => {
            if (msg.text().includes('Content Security Policy')) {
                cspViolations.push(msg.text());
            }
        });

        await page.goto(PREVIEW_URL!, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        const blockingViolations = cspViolations.filter(
            (v) => v.includes('script-src') || v.includes('Refused to execute'),
        );
        expect(blockingViolations).toHaveLength(0);
    });
});
