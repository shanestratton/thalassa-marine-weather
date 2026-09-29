import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page, width: number, height: number, query = '') {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === 'http://127.0.0.1:4199' &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width, height });
    await page.goto(`/e2e/fixtures/shore-watch.html${query}`);
    await expect(page.getByRole('region', { name: 'Vessel anchor readings' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
}

async function assertNoHorizontalOverflow(page: Page) {
    expect(
        await page.evaluate(() => {
            const errors: string[] = [];
            for (const element of [
                document.documentElement,
                document.body,
                document.querySelector('[data-testid="shore-watch-page"]')!,
                document.querySelector('[data-testid="shore-readings-scroll"]')!,
                ...document.querySelectorAll('[aria-label="Vessel anchor readings"] *'),
            ]) {
                if (element.scrollWidth > element.clientWidth + 1)
                    errors.push(`${element.tagName}: ${element.scrollWidth} > ${element.clientWidth}`);
            }
            if (window.scrollY !== 0) errors.push('Document scrolled instead of the readings region');
            return errors;
        }),
    ).toEqual([]);
}

async function assertInsideReadings(control: Locator) {
    expect(
        await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const scroll = document.querySelector('[data-testid="shore-readings-scroll"]')!.getBoundingClientRect();
            const nav = document.querySelector('nav')!.getBoundingClientRect();
            return (
                box.top >= scroll.top - 1 &&
                box.bottom <= Math.min(scroll.bottom, nav.top) + 1 &&
                box.left >= scroll.left - 1 &&
                box.right <= scroll.right + 1
            );
        }),
    ).toBe(true);
}

for (const size of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 375, height: 667 },
]) {
    test(`Healthy Shore Watch fits ${size.width}x${size.height} above navigation`, async ({ page }, info) => {
        await openFixture(page, size.width, size.height);
        const scroll = page.getByTestId('shore-readings-scroll');
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
        expect(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
        await assertNoHorizontalOverflow(page);
        await assertInsideReadings(page.getByRole('region', { name: 'Vessel anchor readings' }));
        for (const label of ['Swing Radius', 'Rode', 'Depth', 'Last Update']) {
            await expect(page.getByText(label, { exact: true })).toBeVisible();
            await assertInsideReadings(page.getByText(label, { exact: true }));
        }
        for (const value of ['50 m', '45 m', '4.3 m'])
            await assertInsideReadings(page.getByText(value, { exact: true }));
        await expect(page.getByRole('status')).toHaveText('Holding');
        await expect(page.getByRole('button', { name: 'Leave Shore Watch' })).toBeInViewport();
        if (size.width === 430) {
            const path = info.outputPath('shore-watch-430x932.png');
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('shore-watch-430x932', { path, contentType: 'image/png' });
        }
    });
}

for (const size of [
    { label: 'short phone', width: 375, height: 667, query: '?notificationWarning=true' },
    { label: 'large text', width: 390, height: 844, query: '?notificationWarning=true&largeText=true' },
]) {
    test(`Shore Watch notification warning stays actionable with ${size.label}`, async ({ page }) => {
        await openFixture(page, size.width, size.height, size.query);
        const retry = page.getByRole('button', { name: 'Retry notifications' });
        await expect(retry).toBeInViewport();
        await retry.click();
        await expect(retry).toBeDisabled();
        await expect(page.getByText('Checking background notifications…')).toBeVisible();
        const lastUpdate = page.getByText('Last Update', { exact: true }).locator('..');
        await lastUpdate.scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate);
        await assertNoHorizontalOverflow(page);
    });
}

for (const scenario of ['stale', 'alarm']) {
    test(`Shore Watch ${scenario} stays readable and controls remain reachable`, async ({ page }) => {
        await openFixture(page, 375, 667, `?scenario=${scenario}`);
        await assertNoHorizontalOverflow(page);
        const status = page.getByRole('status');
        await expect(status).toHaveText(scenario === 'alarm' ? 'Drag Alarm' : 'Last-known data');
        if (scenario === 'stale') {
            await expect(page.getByText(/Vessel offline · showing last-known data/)).toBeInViewport();
            await expect(page.getByText('last-known from anchor')).toBeVisible();
        }
        await status.scrollIntoViewIfNeeded();
        await assertInsideReadings(status);
        const mute = page.getByRole('button', { name: 'Mute alarm on this device only' });
        await mute.scrollIntoViewIfNeeded();
        await assertInsideReadings(mute);
        await mute.click();
        await expect(mute).toBeDisabled();
        await expect(mute).toContainText('Muted on this device only');
        const lastUpdate = page.getByText(scenario === 'stale' ? 'Last-Known Update' : 'Last Update', { exact: true });
        await lastUpdate.locator('..').scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate.locator('..'));
        await assertNoHorizontalOverflow(page);
    });
}

// Shane 2026-09-29: on this phone's own Pi watch, Weigh Anchor ends the
// readings column, beside the header's Leave. The readings keep the region
// (pinned under it, compact landscape had a 40 px sliver of readings), and the
// button scrolls into reach whole, tappable and clear of the tab bar on the
// smallest phone, in landscape and at large text.
for (const size of [
    { label: 'small phone', width: 320, height: 568, query: '?ownPi=true' },
    { label: 'short phone', width: 375, height: 667, query: '?ownPi=true' },
    { label: 'compact landscape', width: 844, height: 430, query: '?ownPi=true' },
    { label: 'large text', width: 390, height: 844, query: '?ownPi=true&largeText=true' },
]) {
    test(`Shore Watch Weigh Anchor stays reachable above navigation on a ${size.label}`, async ({ page }) => {
        // The bar takes no room from the readings: same region, same start.
        const readings = page.getByTestId('shore-readings-scroll');
        await openFixture(page, size.width, size.height, size.query.replace(/ownPi=true&?/, '').replace(/\?$/, ''));
        const without = await readings.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop }));
        await openFixture(page, size.width, size.height, size.query);
        expect(await readings.evaluate((el) => ({ height: el.clientHeight, top: el.scrollTop }))).toEqual(without);
        await expect(page.getByRole('button', { name: 'Leave Shore Watch' })).toBeInViewport();
        const weigh = page.getByRole('button', { name: '⏏ Weigh Anchor' });
        await expect(weigh).toHaveAccessibleDescription('Stops the Pi’s watch. Leave keeps the Pi watching.');
        const note = page.getByText('Stops the Pi’s watch. Leave keeps the Pi watching.');
        await note.scrollIntoViewIfNeeded();
        await assertInsideReadings(weigh);
        await assertInsideReadings(note);
        expect(await weigh.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        await assertNoHorizontalOverflow(page);
        await weigh.click();
        await expect(page.getByRole('alert')).toHaveText('Weigh anchor pressed');
    });
}

for (const size of [
    { label: 'compact landscape', width: 844, height: 430, query: '' },
    { label: 'large text', width: 390, height: 844, query: '?largeText=true' },
]) {
    test(`Shore Watch ${size.label} scrolls within its available space`, async ({ page }) => {
        await openFixture(page, size.width, size.height, size.query);
        const scroll = page.getByTestId('shore-readings-scroll');
        const headerBefore = await page.getByRole('heading', { name: 'Shore Watch' }).boundingBox();
        expect(await scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
            await scroll.evaluate((element) => element.clientHeight),
        );
        const lastUpdate = page.getByText('Last Update', { exact: true }).locator('..');
        await lastUpdate.scrollIntoViewIfNeeded();
        await assertInsideReadings(lastUpdate);
        expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await page.getByRole('heading', { name: 'Shore Watch' }).boundingBox()).toEqual(headerBefore);
        await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
        await assertInsideReadings(page.getByText('from anchor', { exact: true }));
        await assertNoHorizontalOverflow(page);
    });
}
