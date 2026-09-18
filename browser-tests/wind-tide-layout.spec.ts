import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function expectNoOverflow(element: Locator) {
    const geometry = await element.evaluate((el) => ({
        width: el.scrollWidth - el.clientWidth,
        height: el.scrollHeight - el.clientHeight,
        left: el.scrollLeft,
        top: el.scrollTop,
    }));
    expect(geometry.width).toBeLessThanOrEqual(1);
    expect(geometry.height).toBeLessThanOrEqual(1);
    expect(geometry.left).toBe(0);
    expect(geometry.top).toBe(0);
}

async function expectMinimumFont(element: Locator, size: number) {
    expect(await element.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(size);
}

async function expectTouchTarget(control: Locator, container: Locator) {
    await expect(control).toBeVisible();
    await expectContained(control, container);
    const rect = await control.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(44);
    expect(rect!.height).toBeGreaterThanOrEqual(44);
}

async function expectStaticFace(page: Page) {
    const card = page.getByTestId('tide-card');
    const details = page.getByRole('region', { name: 'Wind versus tide details' });
    const face = details.locator('..');
    await expect(details).toBeVisible();
    for (const container of [face, details]) {
        await expect(container).toHaveCSS('overflow-x', 'clip');
        await expect(container).toHaveCSS('overflow-y', 'clip');
        await expectNoOverflow(container);
        await expectContained(container, card);
    }

    const verdict = page.getByTestId('wind-tide-verdict');
    await expectContained(verdict, face);
    await expectNoOverflow(verdict);
    await expectMinimumFont(verdict, 16);
    await expect(verdict).not.toHaveCSS('text-overflow', 'ellipsis');
    for (const id of ['wind-tide-wind', 'wind-tide-stream']) {
        const readout = page.getByTestId(id);
        await expectContained(readout, details);
        await expectNoOverflow(readout);
        const label = readout.locator(':scope > div').nth(0);
        const reading = readout.locator(':scope > div').nth(1);
        await expectMinimumFont(label, 12);
        await expectMinimumFont(reading, 14);
        for (const text of [label, reading]) {
            await expectContained(text, readout);
            await expectNoOverflow(text);
        }
    }
    const source = page.getByTestId('wind-tide-source');
    await expectContained(source, details);
    await expectNoOverflow(source);
    await expectMinimumFont(source, 12);
    await expectTouchTarget(page.getByRole('button', { name: 'Back to tide graph' }), face);
    await expectTouchTarget(page.getByRole('button', { name: 'Flood direction minus 15 degrees' }), details);
    await expectTouchTarget(page.getByRole('button', { name: 'Flood direction plus 15 degrees' }), details);
    const auto = page.getByRole('button', { name: 'Use modelled current instead' });
    if (await auto.count()) await expectTouchTarget(auto, details);

    await expect(page.locator('[data-testid^="wind-tide-outlook-"]')).toHaveCount(0);
    await expect(page.getByText(/More below|Scroll up|\+(3|6|9|12)h/)).toHaveCount(0);
}

for (const mode of ['light', 'dark', 'night']) {
    for (const size of [
        { width: 320, height: 150, split: false },
        { width: 430, height: 180, split: false },
        { width: 1024, height: 197, split: true },
    ]) {
        test(`${mode}, ${size.width}px: current conditions and controls fit without scrolling`, async ({
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
            const close = page.getByRole('button', { name: 'Back to tide graph' });
            const closeBefore = await close.boundingBox();
            await expectStaticFace(page);
            await expect(page.getByTestId('wind-tide-verdict')).toHaveText('Wind against the stream');
            expect(await card.boundingBox()).toEqual(before.card);
            expect(await model.boundingBox()).toEqual(before.model);

            // Tapping ordinary content leaves the detail face open.
            await page.getByTestId('wind-tide-verdict').click();
            await expectStaticFace(page);

            const plus = page.getByRole('button', { name: 'Flood direction plus 15 degrees' });
            const minus = page.getByRole('button', { name: 'Flood direction minus 15 degrees' });
            const auto = page.getByRole('button', { name: 'Use modelled current instead' });
            await plus.click();
            await expect(page.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 15°');
            await expectStaticFace(page);
            if (mode === 'light' && size.width === 430) {
                await card.screenshot({ path: testInfo.outputPath('wind-tide-current-conditions.png') });
            }
            await minus.click();
            await expect(page.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 0°');
            await expectStaticFace(page);
            await auto.click();
            await expect(page.getByTestId('wind-tide-source')).toHaveText('Stream from modelled current');
            await expect(auto).toHaveCount(0);
            await expectStaticFace(page);
            expect(await close.boundingBox()).toEqual(closeBefore);
            expect(await model.boundingBox()).toEqual(before.model);
            expect(await card.boundingBox()).toEqual(before.card);
            await expect(page.getByTestId('daily-carousel')).toHaveJSProperty('scrollTop', 0);
            await expect(page.getByTestId('hourly-carousel')).toHaveJSProperty('scrollLeft', 0);
            await close.click();
            await expect(page.getByRole('button', { name: 'Show wind versus tide' })).toBeVisible();
            expect(await card.boundingBox()).toEqual(before.card);
            expect(await model.boundingBox()).toEqual(before.model);
        });
    }
}

for (const [scenario, verdict] of [
    ['measured', 'Wind over tide — expect short, steep chop'],
    ['inferred', 'Wind over tide likely — expect short, steep chop'],
    ['unknown', 'Wind against the stream — stream strength unknown'],
    ['missing', 'Stream direction unavailable'],
    ['with', 'Wind with the stream — easier going'],
]) {
    test(`${scenario}: full verdict and readings fit a 320px viewport and 150px card`, async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 850 });
        await page.goto(`/e2e/fixtures/wind-tide.html?mode=light&height=150&scenario=${scenario}`);
        const card = page.getByTestId('tide-card');
        const model = page.getByTestId('model-strip');
        const before = { card: await card.boundingBox(), model: await model.boundingBox() };
        await page.getByRole('button', { name: 'Show wind versus tide' }).click();
        await expect(page.getByTestId('wind-tide-verdict')).toHaveText(verdict);
        await expectStaticFace(page);
        if (scenario === 'missing') {
            await expect(page.getByTestId('wind-tide-wind')).toHaveText('Wind-- from --');
            await expect(page.getByTestId('wind-tide-stream')).toContainText('~ to --');
        }
        // Showing Auto adds the third 44px control at the most constrained size.
        await page.getByRole('button', { name: 'Flood direction plus 15 degrees' }).click();
        await expect(page.getByRole('button', { name: 'Use modelled current instead' })).toBeVisible();
        await expect(page.getByTestId('wind-tide-verdict')).toHaveText(verdict);
        await expectStaticFace(page);
        expect(await card.boundingBox()).toEqual(before.card);
        expect(await model.boundingBox()).toEqual(before.model);
    });
}

test('three-digit flood direction and wraparound controls fit without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 850 });
    await page.goto('/e2e/fixtures/wind-tide.html?mode=light&height=150&customFlood=1');
    await page.getByRole('button', { name: 'Show wind versus tide' }).click();
    const source = page.getByTestId('wind-tide-source');
    await expect(source).toHaveText('Stream from your flood 345°');
    await expectStaticFace(page);
    await page.getByRole('button', { name: 'Flood direction plus 15 degrees' }).click();
    await expect(source).toHaveText('Stream from your flood 0°');
    await expectStaticFace(page);
    await page.getByRole('button', { name: 'Flood direction minus 15 degrees' }).click();
    await expect(source).toHaveText('Stream from your flood 345°');
    await expectStaticFace(page);
    await page.getByRole('button', { name: 'Use modelled current instead' }).click();
    await expect(source).toHaveText('Stream from modelled current');
    await expectStaticFace(page);
});

test('navigation keys keep the face fixed and keyboard controls restore graph focus', async ({ page, browserName }) => {
    // macOS WebKit's default keyboard-access setting skips buttons with plain Tab;
    // Option+Tab traverses all controls without changing the user's setting.
    const needsOption = browserName === 'webkit' && process.platform === 'darwin';
    const nextControl = needsOption ? 'Alt+Tab' : 'Tab';
    const previousControl = needsOption ? 'Alt+Shift+Tab' : 'Shift+Tab';
    await page.setViewportSize({ width: 320, height: 850 });
    await page.goto('/e2e/fixtures/wind-tide.html?height=150');
    const graph = page.getByRole('button', { name: 'Show wind versus tide' });
    await graph.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('region', { name: 'Wind versus tide details' });
    const face = details.locator('..');
    const before = await details.boundingBox();
    await expect(details).toBeFocused();
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
        await page.keyboard.press(key);
        await expect(details).toBeFocused();
        await expect(page.getByTestId('escaped-keys')).toHaveText('0');
        await expectNoOverflow(details);
        await expectNoOverflow(face);
        expect(await details.boundingBox()).toEqual(before);
        await expect(page.getByTestId('daily-carousel')).toHaveJSProperty('scrollTop', 0);
        await expect(page.getByTestId('hourly-carousel')).toHaveJSProperty('scrollLeft', 0);
    }

    const minus = page.getByRole('button', { name: 'Flood direction minus 15 degrees' });
    const plus = page.getByRole('button', { name: 'Flood direction plus 15 degrees' });
    const auto = page.getByRole('button', { name: 'Use modelled current instead' });
    const close = page.getByRole('button', { name: 'Back to tide graph' });
    await page.keyboard.press(nextControl);
    await expect(minus).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 345°');
    await expectStaticFace(page);
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
        await page.keyboard.press(key);
        await expect(minus).toBeFocused();
        await expect(page.getByTestId('escaped-keys')).toHaveText('0');
        await expectNoOverflow(details);
        await expectNoOverflow(face);
        await expect(page.getByTestId('daily-carousel')).toHaveJSProperty('scrollTop', 0);
        await expect(page.getByTestId('hourly-carousel')).toHaveJSProperty('scrollLeft', 0);
    }
    await page.keyboard.press(nextControl);
    await expect(plus).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wind-tide-source')).toHaveText('Stream from your flood 0°');
    await page.keyboard.press(nextControl);
    await expect(auto).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(plus).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(minus).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(details).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(graph).toBeFocused();
    await page.keyboard.press('Space');
    await expect(details).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(close).toBeFocused();
    await page.keyboard.press('Space');
    await expect(graph).toBeFocused();
});
