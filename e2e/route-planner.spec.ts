import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({ storageState: ONBOARDED_STORAGE });

test('planner parks the comfort card without hiding departure or route controls', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Navigate to Plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Route Planner', exact: true })).toBeVisible();

    const planner = page.locator('.route-planner-page');
    await expect(planner).toBeVisible();
    await expect(planner.getByRole('button', { name: /Comfort/i })).toHaveCount(0);
    await expect(planner.getByLabel('Departure date', { exact: true })).toBeVisible();
    await expect(planner.getByLabel('Departure date', { exact: true })).toBeEnabled();
    await expect(planner.getByRole('button', { name: /From a past voyage/i })).toBeVisible();
    await expect(planner.getByRole('button', { name: /Saved routes/i })).toBeVisible();

    await planner.getByRole('button', { name: 'Page actions', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Route Planner actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import GPX/i })).toBeEnabled();
});

test('departure has one persistent Now action and no OK button', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Navigate to Plan', exact: true }).click();
    const planner = page.locator('.route-planner-page');
    const date = planner.getByLabel('Departure date', { exact: true });
    const now = planner.getByRole('button', { name: 'Now', exact: true });
    await expect(date).toBeVisible();
    await expect(now).toBeVisible();
    await expect(now).toBeEnabled();
    await expect(planner.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);
    const originalSize = await now.boundingBox();
    const today = await date.inputValue();
    const future = new Date(`${today}T12:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 2);
    const scheduledDate = future.toISOString().slice(0, 10);
    await date.fill(scheduledDate);
    await expect(date).toHaveValue(scheduledDate);
    await expect(planner.getByText('leaving now', { exact: true })).toHaveCount(0);

    for (let press = 0; press < 2; press++) {
        await now.click();
        await expect(now).toBeVisible();
        await expect(now).toBeEnabled();
        await expect(date).toHaveValue(today);
        await expect(planner.getByText('leaving now', { exact: true })).toBeVisible();
        const size = await now.boundingBox();
        expect(size?.width).toBe(originalSize?.width);
        expect(size?.height).toBe(originalSize?.height);
        await expect(planner.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);
    }
});

test.describe('routing choice entry', () => {
    test.use({ serviceWorkers: 'block' });

    test('Start Plotting opens routing choice before Manual opens the existing tracer', async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(60_000);
        const origin = new URL(baseURL!).origin;
        let trialCalculations = 0;
        await page.route('**/*', (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.pathname === '/functions/v1/autorouting-trial' && request.postDataJSON()?.action === 'calculate')
                trialCalculations += 1;
            if (
                url.origin === origin &&
                ['GET', 'HEAD'].includes(request.method()) &&
                !url.pathname.startsWith('/api/')
            )
                return route.continue();
            if (url.hostname.endsWith('.mapbox.com') && /^\/styles\/v1\/[^/]+\/[^/]+\/?$/.test(url.pathname))
                return route.fulfill({
                    json: {
                        version: 8,
                        glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
                        sources: {},
                        layers: [{ id: 'fixture-water', type: 'background', paint: { 'background-color': '#18354b' } }],
                    },
                });
            if (url.hostname.endsWith('.mapbox.com') && /^\/fonts\/v1\/mapbox\/[^/]+\/[^/]+\.pbf$/.test(url.pathname))
                return route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.from([0x0a, 0x00]) });
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/');
        await page.getByRole('tab', { name: 'Navigate to Plan', exact: true }).click();
        const slider = page.getByRole('button', { name: 'Slide to Start Plotting', exact: true });
        await expect(slider).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Choose routing mode', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Autorouting · Trial/i })).toHaveCount(0);
        await slider.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        // Use the actual pointer gesture, not a synthetic callback or Enter.
        const box = (await slider.boundingBox())!;
        await page.mouse.move(box.x + 24, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 32, box.y + box.height / 2, { steps: 10 });
        await page.mouse.up();
        const choice = page.getByRole('dialog', { name: 'Choose routing mode', exact: true });
        await expect(choice).toBeVisible();
        await expect(choice.getByRole('button', { name: 'Manual routing', exact: true })).toBeEnabled();
        await expect(choice.getByRole('button', { name: 'Auto routing', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Collapse tracer panel', exact: true })).toHaveCount(0);
        const screenshot = info.outputPath('planning-routing-choice.png');
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        await info.attach('planning-routing-choice', { path: screenshot, contentType: 'image/png' });
        await choice.getByRole('button', { name: 'Manual routing', exact: true }).click();
        await expect(choice).toHaveCount(0);
        await expect(page.getByTestId('map-hub')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Collapse tracer panel', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /✏️ Plot/ })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('dialog', { name: 'Autorouting trial', exact: true })).toHaveCount(0);
        expect(trialCalculations).toBe(0);
    });
});
