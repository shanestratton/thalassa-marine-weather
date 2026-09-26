import { expect, test } from '@playwright/test';

test('ownship status sits beside the fix, clear of the AIS name row, without geographic drift', async ({ page }) => {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/navigation-marker-anchoring.html');
    // Existing fixture runs real Mapbox projection at z8/12.7/19, two
    // bearing/pitch pairs and reversed marker insertion order.
    await expect(page.locator('#results')).toContainText('PASS', { timeout: 30_000 });
    const layout = await page.locator('.vessel-tracker-marker').evaluate((root) => {
        const badge = root.querySelector<HTMLElement>('.vessel-sog-badge')!;
        const marker = root as HTMLElement;
        // Isolate label layout from the already-verified Mapbox transform:
        // the badge's clearance is in CSS pixels, never geographic metres.
        const transform = marker.style.transform;
        marker.style.transform = 'translate(180px, 180px)';
        const name = document.createElement('div');
        name.textContent = 'SERENE SUMMER';
        name.style.cssText =
            'position:absolute;top:calc(50% + 16.8px);left:50%;transform:translateX(-50%);font:700 12px/1.2 sans-serif;white-space:nowrap;';
        marker.appendChild(name);
        const samples = ['Stopped', '6.5 kts', 'Anchored'].map((label) => {
            badge.textContent = label;
            const badgeRect = badge.getBoundingClientRect();
            const rootRect = marker.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            return {
                label,
                // The AIS name hangs below the fix; the badge must end above it.
                gap: nameRect.top - badgeRect.bottom,
                centreOffset: badgeRect.top + badgeRect.height / 2 - (rootRect.top + rootRect.height / 2),
                rightOfFix: badgeRect.left - (rootRect.left + rootRect.width / 2),
                rootWidth: rootRect.width,
                rootHeight: rootRect.height,
            };
        });
        name.remove();
        marker.style.transform = transform;
        return samples;
    });
    // Beside the dot, centred on it (UX scorecard run 6): parked below the
    // fix it read as the caption of the basemap place label under the boat.
    for (const sample of layout) {
        expect(sample.gap, sample.label).toBeGreaterThanOrEqual(4);
        expect(Math.abs(sample.centreOffset), sample.label).toBeLessThan(1);
        expect(sample.rightOfFix, sample.label).toBeCloseTo(18, 1);
        expect(sample.rootWidth).toBe(48);
        expect(sample.rootHeight).toBe(48);
    }
});
