import { expect, test } from '@playwright/test';

test('ownship status clears the AIS name row at every zoom, without geographic drift', async ({ page }) => {
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
                gap: badgeRect.top - nameRect.bottom,
                belowFix: badgeRect.top - (rootRect.top + rootRect.height / 2),
                rootWidth: rootRect.width,
                rootHeight: rootRect.height,
            };
        });
        name.remove();
        marker.style.transform = transform;
        return samples;
    });
    for (const sample of layout) {
        expect(sample.gap, sample.label).toBeGreaterThanOrEqual(8);
        expect(sample.belowFix, sample.label).toBeCloseTo(40, 1);
        expect(sample.rootWidth).toBe(48);
        expect(sample.rootHeight).toBe(48);
    }
});
