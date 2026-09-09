import { expect, test, type Locator } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

type CardBounds = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

async function expectCardToFit(card: Locator, originalBounds: CardBounds) {
    const bounds = await card.boundingBox();
    expect(bounds).not.toBeNull();
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(bounds![dimension] - originalBounds[dimension])).toBeLessThanOrEqual(1);
    }

    const visibleContent = [
        card.getByTestId('wind-tide-verdict'),
        card.getByTestId('wind-tide-wind'),
        card.getByTestId('wind-tide-stream'),
        card.getByTestId('wind-tide-source'),
        ...(await card.getByRole('button').all()),
    ];
    for (const content of visibleContent) {
        await expect(content).toBeVisible();
        const contentBounds = await content.boundingBox();
        expect(contentBounds).not.toBeNull();
        expect(contentBounds!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
        expect(contentBounds!.y).toBeGreaterThanOrEqual(bounds!.y - 1);
        expect(contentBounds!.x + contentBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
        expect(contentBounds!.y + contentBounds!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    }
    for (const button of await card.getByRole('button').all()) {
        const buttonBounds = await button.boundingBox();
        expect(buttonBounds!.width).toBeGreaterThanOrEqual(44);
        expect(buttonBounds!.height).toBeGreaterThanOrEqual(44);
    }

    const overflow = await card.evaluate((root) => {
        const elements = [root, ...root.querySelectorAll<HTMLElement>('*')];
        return elements.flatMap((element) => {
            const style = getComputedStyle(element);
            const scrollable = /^(auto|scroll)$/.test(style.overflowY) || /^(auto|scroll)$/.test(style.overflowX);
            const clipped =
                (/^(hidden|clip)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
                (/^(hidden|clip)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1);
            return scrollable || clipped
                ? [{ element: element.getAttribute('data-testid') || element.tagName, scrollable, clipped }]
                : [];
        });
    });
    expect(overflow).toEqual([]);
}

test.describe('Glass wind versus tide card', () => {
    test.use({ storageState: ONBOARDED_STORAGE, viewport: { width: 390, height: 844 } });

    test('shows current conditions and all controls without scrolling or resizing the card', async ({ page }) => {
        await page.addInitScript((entries) => {
            // Seed the actual application storage on either the local release
            // origin or a hosted preview, then refresh its cache for this run.
            for (const entry of entries) localStorage.setItem(entry.name, entry.value);
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.dashboardMode = 'full';
                delete saved.settings.tideFloodDirection;
                localStorage.setItem(key, JSON.stringify(saved));
            }

            const cacheKey = 'thalassa_weather_cache_v9::anonymous';
            const weather = JSON.parse(localStorage.getItem(cacheKey)!);
            const now = Date.now();
            const atHour = (offset: number) => new Date(now + offset * 3_600_000).toISOString();
            weather.generatedAt = new Date(now).toISOString();
            weather.locationType = 'coastal';
            Object.assign(weather.current, {
                windSpeed: 6,
                windGust: 8,
                windDegree: 45,
                windDirection: 'NE',
                currentDirection: 0,
                currentSpeed: 0,
            });
            weather.tides = [
                { time: atHour(-2), height: 0.4, type: 'Low' },
                { time: atHour(4), height: 2, type: 'High' },
                { time: atHour(10), height: 0.4, type: 'Low' },
                { time: atHour(16), height: 2, type: 'High' },
            ];
            weather.tideHourly = Array.from({ length: 25 }, (_, index) => {
                const hour = index - 6;
                return { time: atHour(hour), height: 1.2 + 0.8 * Math.sin(((hour - 1) * Math.PI) / 6) };
            });
            localStorage.setItem(cacheKey, JSON.stringify(weather));
            localStorage.setItem('thalassa_swipe_hint_seen_v1', '1');
        }, ONBOARDED_STORAGE.origins[0].localStorage);

        await page.goto('/');
        await expect(page.getByRole('tab', { name: 'Navigate to The Glass' })).toHaveAttribute('aria-selected', 'true');
        const graph = page.getByRole('button', { name: 'Show wind versus tide', exact: true });
        await expect(graph).toHaveCount(1);
        await expect(graph).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const originalBounds = await graph.boundingBox();
        expect(originalBounds).not.toBeNull();

        await graph.click();
        const details = page.getByRole('region', { name: 'Wind versus tide details' });
        await expect(details).toBeVisible();
        const card = page.locator('[data-wind-tide-card]').filter({ has: details });
        await expect(card).toHaveCount(1);
        await expect(card.getByTestId('wind-tide-verdict')).toHaveText('Wind against the stream');
        await expect(card.getByTestId('wind-tide-wind')).toContainText('6 kts from NE');
        await expect(card.getByTestId('wind-tide-stream')).toContainText('0 kts to N');
        await expect(card.getByTestId('wind-tide-source')).toHaveText('Stream from modelled current');
        await expect(card.getByText(/^\+(3|6|9|12)h$/)).toHaveCount(0);
        await expect(card.getByTestId(/^wind-tide-outlook-/)).toHaveCount(0);
        await expect(card.getByText(/More below|Scroll up/)).toHaveCount(0);
        await expectCardToFit(card, originalBounds!);

        await card.getByRole('button', { name: 'Flood direction minus 15 degrees' }).click();
        await expect(card.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 345°');
        await expect(card.getByRole('button', { name: 'Use modelled current instead' })).toBeVisible();
        await expectCardToFit(card, originalBounds!);

        await card.getByRole('button', { name: 'Flood direction plus 15 degrees' }).click();
        await expect(card.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 0°');
        await card.getByRole('button', { name: 'Use modelled current instead' }).click();
        await expect(card.getByTestId('wind-tide-source')).toHaveText('Stream from modelled current');
        await expect(card.getByRole('button', { name: 'Use modelled current instead' })).toHaveCount(0);

        await details.focus();
        await page.keyboard.press('PageDown');
        const detailsScrollTop = await details.evaluate((element) => {
            element.scrollTop = 999;
            return element.scrollTop;
        });
        expect(detailsScrollTop).toBe(0);
        await expectCardToFit(card, originalBounds!);

        await card.getByRole('button', { name: 'Back to tide graph' }).click();
        await expect(details).toHaveCount(0);
        await expect(graph).toBeVisible();
        const restoredBounds = await graph.boundingBox();
        for (const dimension of ['x', 'y', 'width', 'height'] as const) {
            expect(Math.abs(restoredBounds![dimension] - originalBounds![dimension])).toBeLessThanOrEqual(1);
        }
    });
});
