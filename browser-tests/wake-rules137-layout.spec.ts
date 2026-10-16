import { expect, test, type Locator } from '@playwright/test';
const presets = [
    'depth-below-keel',
    'wind-above',
    'speed-below',
    'pressure-fall',
    'engine-coolant-above',
    'engine-oil-below',
    'engine-rpm-above',
    'battery-below',
];
async function bounded(dialog: Locator, width: number, bottom: number) {
    const panel = dialog.locator('[data-modal-sheet]');
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(bottom + 1);
    expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(
        await dialog.locator('[data-modal-sheet-body]').evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
    const save = (await dialog.getByRole('button', { name: 'Save rules' }).boundingBox())!;
    expect(save.y).toBeGreaterThanOrEqual(box.y);
    expect(save.y + save.height).toBeLessThanOrEqual(bottom);
}
for (const width of [300, 375])
    test(`wake presets fit ${width}px at130percent with scroll, keyboard and explicit Save`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 640 });
        const remote: string[] = [];
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
            remote.push(url.origin);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/wake-rules137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const opener = page.getByRole('button', { name: 'Wake rules: choose sensor alarm presets' });
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'Wake rules' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/Phone only while the app is active/)).toBeVisible();
        for (const preset of presets) {
            await dialog.getByLabel('Preset', { exact: true }).selectOption(preset);
            const sources = dialog.getByLabel('Sensor source');
            await sources.selectOption({ label: 'Generated physical sender / explicit reference' });
            await expect(
                dialog
                    .getByText('Generated physical sender / explicit reference', { exact: true })
                    .filter({ visible: true }),
            ).toBeVisible();
            expect(await sources.evaluate((node) => getComputedStyle(node).appearance)).toBe('none');
            const quiet = dialog.getByLabel('Quiet hours');
            await quiet.check();
            const footer = dialog.locator('[data-modal-sheet-footer]');
            await bounded(dialog, width, 640);
            await dialog.getByLabel('UTC offset').scrollIntoViewIfNeeded();
            await expect(dialog.getByLabel('UTC offset')).toBeInViewport();
            const rect = (await dialog.getByLabel('UTC offset').boundingBox())!;
            const foot = (await footer.boundingBox())!;
            expect(rect.y + rect.height).toBeLessThanOrEqual(foot.y + 1);
        }
        await dialog.getByLabel('Preset', { exact: true }).selectOption('wind-above');
        await dialog.getByLabel('Enable selected wake rule').check();
        await dialog.getByLabel('Threshold (kn)').fill('30');
        await dialog.getByRole('button', { name: 'Save rules' }).click();
        await expect(dialog.getByRole('status', { name: 'Wake rule save status' })).toHaveText('Saved.');
        await dialog.getByLabel('Minimum hold (s)').focus();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 280 })));
        await expect.poll(() => page.locator('html').getAttribute('data-keyboard-open')).toBe('true');
        await expect
            .poll(async () => {
                const box = (await dialog.locator('[data-modal-sheet]').boundingBox())!;
                return box.y + box.height;
            })
            .toBeLessThanOrEqual(361);
        await bounded(dialog, width, 360);
        await expect(dialog.getByLabel('Minimum hold (s)')).toBeInViewport();
        const input = (await dialog.getByLabel('Minimum hold (s)').boundingBox())!;
        const footer = (await dialog.locator('[data-modal-sheet-footer]').boundingBox())!;
        expect(input.y + input.height).toBeLessThanOrEqual(footer.y + 1);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 0 })));
        await expect.poll(() => page.locator('html').getAttribute('data-keyboard-open')).not.toBe('true');
        await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
        await dialog.locator('[data-modal-sheet-body]').evaluate((node) => {
            node.scrollTop = 0;
        });
        await page.screenshot({ path: info.outputPath(`wake-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(opener).toBeFocused();
        expect(remote).toEqual([]);
        expect(errors).toEqual([]);
    });
test('empty qualified catalogue cannot enable a wake rule or claim a Pi keeper', async ({ page }) => {
    await page.goto('/e2e/fixtures/wake-rules137.html?empty');
    await page.getByRole('button', { name: 'Wake rules: choose sensor alarm presets' }).click();
    const dialog = page.getByRole('dialog', { name: 'Wake rules' });
    await expect(dialog.getByLabel('Enable selected wake rule')).toBeDisabled();
    await expect(dialog.getByLabel('Enable selected wake rule')).not.toBeChecked();
    await expect(dialog.getByText(/No qualified live source/)).toBeVisible();
    await expect(dialog.getByText(/Phone only while the app is active/)).toBeVisible();
});
