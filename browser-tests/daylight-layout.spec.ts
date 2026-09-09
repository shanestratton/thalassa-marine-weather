import { expect, test } from '@playwright/test';

test('sunlight surfaces and text remain legible after passage CSS loads', async ({ page }) => {
    await page.goto('/e2e/fixtures/daylight.html');
    await expect(page.locator('html')).toHaveClass(/display-light/);
    await expect(page.getByTestId('neutral-card')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.getByTestId('dense-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.97)');
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.98)');
    await expect(page.locator('.bio-header')).toHaveCSS('color', 'rgb(15, 23, 42)');
    await expect(page.getByTestId('filled-cta')).toHaveCSS('color', 'rgb(255, 255, 255)');
    for (const kind of ['seamark-popup', 'mpa-popup', 'ntm-popup', 'tide-station-popup']) {
        await expect(page.getByTestId(kind).locator('.mapboxgl-popup-content')).toHaveCSS(
            'background-color',
            'rgb(255, 255, 255)',
        );
        await expect(page.getByTestId(kind).locator('p')).toHaveCSS('color', 'rgb(15, 23, 42)');
    }
    const gradient = await page.getByTestId('gradient-card').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(gradient).toContain('rgb(248, 250, 252)');
    expect(gradient).toContain('rgb(226, 232, 240)');

    const ratios = await page.locator('[data-contrast]').evaluateAll((elements) => {
        const luminance = (rgb: number[]) =>
            rgb
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return elements.map((element) => {
            const rgb = getComputedStyle(element)
                .color.match(/[\d.]+/g)!
                .map(Number)
                .slice(0, 3);
            // The fixture's solid white card is asserted above.
            return { label: element.className, ratio: 1.05 / (luminance(rgb) + 0.05) };
        });
    });
    for (const { label, ratio } of ratios) expect(ratio, label).toBeGreaterThanOrEqual(4.5);

    await page.getByRole('button', { name: 'Toggle day' }).click();
    await expect(page.locator('html')).not.toHaveClass(/display-light/);
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(8, 16, 28, 0.75)');
    await expect(page.locator('.bio-header')).toHaveCSS('color', 'rgb(255, 255, 255)');
    const dark = await page.getByTestId('gradient-card').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(dark).not.toBe(gradient);
    await page.getByRole('button', { name: 'Toggle day' }).click();
    await expect(page.getByTestId('passage-card')).toHaveCSS('background-color', 'rgba(248, 250, 252, 0.98)');
});
