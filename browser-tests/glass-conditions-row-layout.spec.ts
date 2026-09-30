import { expect, test } from '@playwright/test';

/**
 * The Glass's compact conditions row keeps every reading inside its own
 * fifth. Shane 2026-09-30: under 0.25 mm the rain cell read "TRACE mm", ran
 * into the HUM cell and clipped its unit to "m". Inch figures ('<0.01"',
 * '0.50"') are just as wide.
 */
for (const width of [320, 375, 390, 430]) {
    test(`conditions row readings stay inside their cells at ${width}px`, async ({ page }, info) => {
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return url.origin === 'http://127.0.0.1:4199' ? route.continue() : route.abort();
        });
        await page.setViewportSize({ width, height: 1100 });
        await page.goto('/e2e/fixtures/glass-legibility.html');
        await page.evaluate(() => document.fonts.ready);

        const trace = page.getByTestId('conditions-trace-mm');
        await expect(trace.getByText('Trace', { exact: true })).toBeVisible();
        await expect(trace).not.toContainText('TRACE');
        await expect(trace).not.toContainText('Trace mm');
        await expect(page.getByTestId('conditions-inch-small').getByText('<0.01"', { exact: true })).toBeVisible();
        await expect(page.getByTestId('conditions-inch').getByText('0.50"', { exact: true })).toBeVisible();

        for (const id of ['conditions-trace-mm', 'conditions-inch-small', 'conditions-inch']) {
            const spills = await page.getByTestId(id).evaluate((section) => {
                const row = section.querySelector('.grid-cols-5');
                if (!row) return ['no row'];
                const out: string[] = [];
                for (const cell of Array.from(row.children) as HTMLElement[]) {
                    const box = cell.getBoundingClientRect();
                    for (const el of Array.from(cell.querySelectorAll('span')) as HTMLElement[]) {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0) continue;
                        if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
                            out.push(
                                `"${el.textContent}" ${r.left.toFixed(1)}–${r.right.toFixed(1)} outside ${box.left.toFixed(1)}–${box.right.toFixed(1)}`,
                            );
                    }
                }
                return out;
            });
            expect(spills, `${id} at ${width}px`).toEqual([]);
        }
        if (width === 390) {
            const path = info.outputPath('conditions-rows-390.png');
            await page.locator('[data-testid^="conditions-"]').first().locator('..').screenshot({ path });
            await info.attach('conditions-rows-390', { path, contentType: 'image/png' });
        }
    });
}
