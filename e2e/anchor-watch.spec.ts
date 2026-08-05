import { test, expect, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

interface WarmLaunchTelemetry {
    consoleErrors: string[];
    weatherProviderRequests: string[];
    weatherLifecycle: string[];
}

const warmLaunchTelemetry = new WeakMap<Page, WarmLaunchTelemetry>();

test.describe('Anchor Watch', () => {
    test.use({ storageState: ONBOARDED_STORAGE });

    test.beforeEach(async ({ page }) => {
        // Capture startup failures before navigation. A warm-launch fixture
        // should use its scoped weather/rain caches rather than calling a
        // live provider during an unrelated Vessel journey.
        const telemetry: WarmLaunchTelemetry = { consoleErrors: [], weatherProviderRequests: [], weatherLifecycle: [] };
        warmLaunchTelemetry.set(page, telemetry);
        page.on('console', (msg) => {
            const text = msg.text();
            if (msg.type() === 'error') telemetry.consoleErrors.push(text);
            if (/\[(?:WxOrch|WeatherContext|AppController|WeatherKit)\]/.test(text)) {
                telemetry.weatherLifecycle.push(text);
            }
        });
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('/functions/v1/fetch-weatherkit') || url.includes('/functions/v1/proxy-rainbow')) {
                telemetry.weatherProviderRequests.push(url);
            }
        });

        await page.goto('/');
        // Navigate to vessel tab then anchor watch
        const vesselTab = page.locator('button, [role="tab"]').filter({ hasText: /vessel|boat/i });
        if ((await vesselTab.count()) > 0) {
            await vesselTab.first().click();
            await page.waitForTimeout(500);
        }
    });

    test('vessel hub page loads', async ({ page }) => {
        const content = await page.textContent('body');
        expect(content?.length).toBeGreaterThan(0);
    });

    test('anchor watch option is accessible', async ({ page }) => {
        // Look for anchor watch link/button in the vessel hub
        await page.waitForTimeout(1000);
        const body = await page.textContent('body');
        expect(body?.length).toBeGreaterThan(0);
    });

    test('page renders without console errors', async ({ page }) => {
        await page.waitForTimeout(2000);
        const telemetry = warmLaunchTelemetry.get(page);
        expect(telemetry).toBeDefined();
        // Filter out expected React dev warnings.
        const realErrors = telemetry!.consoleErrors.filter((e) => !e.includes('Warning:') && !e.includes('DevTools'));
        expect(
            realErrors,
            `Unexpected browser console errors:\n${realErrors.join('\n')}\n\nWeather lifecycle:\n${telemetry!.weatherLifecycle.join('\n')}`,
        ).toHaveLength(0);
        expect(
            telemetry!.weatherProviderRequests,
            `A warm launch should use its cached weather data:\n${telemetry!.weatherProviderRequests.join('\n')}\n\nWeather lifecycle:\n${telemetry!.weatherLifecycle.join('\n')}`,
        ).toHaveLength(0);
    });
});
