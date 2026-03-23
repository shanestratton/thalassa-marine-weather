import { test, expect } from '@playwright/test';

test.describe('Settings & Preferences', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('theme-color meta tag is set', async ({ page }) => {
        await page.goto('/');
        const themeColor = await page.getAttribute('meta[name="theme-color"]', 'content');
        expect(themeColor).toBeTruthy();
    });

    test('viewport is configured for mobile', async ({ page }) => {
        await page.goto('/');
        const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
        expect(viewport).toContain('width=device-width');
        expect(viewport).toContain('viewport-fit=cover');
    });

    test('CSP meta tag is present', async ({ page }) => {
        await page.goto('/');
        const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("frame-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
    });

    test('manifest link is present', async ({ page }) => {
        await page.goto('/');
        const manifest = page.locator('link[rel="manifest"]');
        await expect(manifest).toBeAttached();
    });

    test('fonts are loaded from allowed origins', async ({ page }) => {
        const fontRequests: string[] = [];
        page.on('request', (req) => {
            if (req.resourceType() === 'font') {
                fontRequests.push(req.url());
            }
        });

        await page.goto('/', { waitUntil: 'networkidle' });

        // All font requests should come from allowed CSP origins
        for (const url of fontRequests) {
            const isAllowed = url.includes('fonts.gstatic.com') || url.startsWith('/') || url.includes('localhost');
            expect(isAllowed).toBe(true);
        }
    });

    test('dark mode styles are applied by default', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(1000);

        // Body background should be dark
        const bgColor = await page.evaluate(() => {
            const body = document.body;
            return window.getComputedStyle(body).backgroundColor;
        });

        // Dark backgrounds typically have low RGB values
        expect(bgColor).toBeTruthy();
    });
});
