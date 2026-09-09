import { expect, test, type Locator } from '@playwright/test';

async function expectContained(element: Locator, container: Locator) {
    const outer = await container.boundingBox();
    const inner = await element.boundingBox();
    expect(outer).not.toBeNull();
    expect(inner).not.toBeNull();
    expect(inner!.x).toBeGreaterThanOrEqual(outer!.x - 1);
    expect(inner!.y).toBeGreaterThanOrEqual(outer!.y - 1);
    expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
    expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
}

for (const mode of ['light', 'dark', 'night']) {
    for (const size of [
        { width: 320, height: 150, split: false },
        { width: 430, height: 180, split: false },
        { width: 1024, height: 197, split: true },
    ]) {
        test(`${mode}, ${size.width}px: all outlooks and controls are reachable within the card`, async ({
            page,
        }, testInfo) => {
            await page.setViewportSize({ width: size.width, height: 850 });
            await page.goto(
                `/e2e/fixtures/wind-tide.html?mode=${mode}&height=${size.height}${size.split ? '&split=1' : ''}`,
            );
            const card = page.getByTestId('tide-card');
            const model = page.getByTestId('model-strip');
            const before = { card: await card.boundingBox(), model: await model.boundingBox() };
            await page.getByRole('button', { name: 'Show wind versus tide' }).click();
            const details = page.getByRole('region', { name: 'Wind versus tide details' });
            const close = page.getByRole('button', { name: 'Back to tide graph' });
            await expect(details).toBeVisible();
            await expect(details).toHaveCSS('overflow-y', 'auto');
            await expect(details).toHaveCSS('overscroll-behavior-y', 'contain');
            await expect(page.getByText('More below ↓')).toBeVisible();
            const closeBefore = await close.boundingBox();
            const overflow = await details.evaluate((el) => ({
                width: el.scrollWidth - el.clientWidth,
                height: el.scrollHeight - el.clientHeight,
            }));
            expect(overflow.width).toBeLessThanOrEqual(1);
            expect(overflow.height).toBeGreaterThan(0);
            expect(await card.boundingBox()).toEqual(before.card);
            expect(await model.boundingBox()).toEqual(before.model);

            // A non-control tap must leave the detail view open.
            await details.getByText('Wind against the stream', { exact: true }).click();
            await expect(details).toBeVisible();
            for (const hour of [3, 6, 9, 12]) {
                const outlook = page.getByTestId(`wind-tide-outlook-${hour}`);
                await outlook.scrollIntoViewIfNeeded();
                await expect(outlook).toContainText(`+${hour}h`);
                await expect(outlook).toContainText('against');
                await expectContained(outlook, details);
            }
            if (mode === 'light' && size.width === 430) {
                await card.screenshot({ path: testInfo.outputPath('wind-tide-outlooks.png') });
            }

            const plus = page.getByRole('button', { name: 'Flood direction plus 15 degrees' });
            await plus.scrollIntoViewIfNeeded();
            await expectContained(plus, details);
            await plus.click();
            await expect(details).toContainText('Stream from your flood 15°');
            const minus = page.getByRole('button', { name: 'Flood direction minus 15 degrees' });
            const auto = page.getByRole('button', { name: 'Use modelled current instead' });
            await auto.scrollIntoViewIfNeeded();
            for (const control of [minus, plus, auto]) {
                await expectContained(control, details);
                const rect = await control.boundingBox();
                expect(rect!.width).toBeGreaterThanOrEqual(44);
                expect(rect!.height).toBeGreaterThanOrEqual(44);
            }
            await minus.click();
            await expect(details).toContainText('Stream from your flood 0°');
            await auto.click();
            await expect(details).toContainText('Stream from modelled current');
            expect(await close.boundingBox()).toEqual(closeBefore);
            await expectContained(close, card);
            expect(await model.boundingBox()).toEqual(before.model);
            expect(await card.boundingBox()).toEqual(before.card);
            expect(await page.getByTestId('daily-carousel').evaluate((el) => el.scrollTop)).toBe(0);
            expect(await page.getByTestId('hourly-carousel').evaluate((el) => el.scrollLeft)).toBe(0);
            await close.click();
            await expect(page.getByRole('button', { name: 'Show wind versus tide' })).toBeVisible();
        });
    }
}

test('keyboard scrolling stays in the details rather than changing day/hour', async ({ page }) => {
    await page.goto('/e2e/fixtures/wind-tide.html?height=150');
    const graph = page.getByRole('button', { name: 'Show wind versus tide' });
    await graph.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('region', { name: 'Wind versus tide details' });
    await expect(details).toBeFocused();
    await page.keyboard.press('ArrowDown');
    // Arrow input must not change the day. End below verifies native scrolling
    // to the footer, including mobile WebKit's different keyboard behaviour.
    await expect(page.getByTestId('escaped-keys')).toHaveText('0');
    await page.keyboard.press('End');
    // Native keyboard scrolling is animated in Chromium. Wait until End has
    // actually reached the bottom before measuring the footer's position.
    await expect
        .poll(() => details.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('escaped-keys')).toHaveText('0');
    await expectContained(page.getByRole('button', { name: 'Flood direction plus 15 degrees' }), details);
    await page.keyboard.press('Home');
    await expect.poll(() => details.evaluate((el) => el.scrollTop)).toBe(0);
    const close = page.getByRole('button', { name: 'Back to tide graph' });
    await expectContained(close, page.getByTestId('tide-card'));
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(graph).toBeFocused();
    await page.keyboard.press('Space');
    await expect(details).toBeFocused();
});

test.describe('desktop wheel input', () => {
    // Mobile WebKit has no wheel input. Its native keyboard scrolling and
    // constrained-card geometry are exercised in the mobile cases above.
    test.use({ isMobile: false, hasTouch: false });

    test('wheel scrolling reaches the footer without moving the outer day carousel', async ({ page }) => {
        await page.goto('/e2e/fixtures/wind-tide.html?height=150');
        await page.getByRole('button', { name: 'Show wind versus tide' }).click();
        const details = page.getByRole('region', { name: 'Wind versus tide details' });
        await details.hover();
        await page.mouse.wheel(0, 1000);
        await expect
            .poll(() => details.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
            .toBeLessThanOrEqual(1);
        await expectContained(page.getByRole('button', { name: 'Flood direction plus 15 degrees' }), details);
        await expect(page.getByText('Scroll up ↑')).toBeVisible();
        // A second gesture at the bottom must not chain into the next day.
        await page.mouse.wheel(0, 500);
        await expect(page.getByTestId('daily-carousel')).toHaveJSProperty('scrollTop', 0);
        await expect(page.getByTestId('hourly-carousel')).toHaveJSProperty('scrollLeft', 0);
    });
});
