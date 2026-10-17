import { test, expect, type Locator } from '@playwright/test';
async function hit(control: Locator, width: number) {
    await control.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await expect
        .poll(() =>
            control.evaluate((el, viewport) => {
                const r = el.getBoundingClientRect();
                let left = r.left,
                    top = r.top,
                    right = r.right,
                    bottom = r.bottom;
                for (let p = el.parentElement; p; p = p.parentElement) {
                    const css = getComputedStyle(p),
                        box = p.getBoundingClientRect();
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
                        left = Math.max(left, box.left);
                        right = Math.min(right, box.right);
                    }
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                        top = Math.max(top, box.top);
                        bottom = Math.min(bottom, box.bottom);
                    }
                }
                const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                return (
                    right - left >= 44 &&
                    bottom - top >= 44 &&
                    left >= 0 &&
                    right <= viewport &&
                    top >= 0 &&
                    bottom <= 667 &&
                    !!target &&
                    (target === el || el.contains(target))
                );
            }, width),
        )
        .toBe(true);
}
for (const width of [300, 375])
    test(`crowd142 ${width}px130% stays inside map and sheet`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (route) =>
            ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
                ? route.continue()
                : route.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/crowd142.html');
        const html = page.locator('html');
        await expect(html).toHaveAttribute('data-crowd-reads', '0');
        const before = await page.getByTestId('map').boundingBox();
        const settings = page.getByRole('button', { name: 'Contribution settings', exact: true });
        await hit(settings, width);
        await settings.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.evaluate(async (el) => {
            await Promise.allSettled(
                el
                    .getAnimations({ subtree: true })
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished),
            );
        });
        await expect(dialog.getByText(/Fictional owned yacht/)).toBeVisible();
        const checks = dialog.getByRole('checkbox');
        await expect(checks.nth(0)).not.toBeChecked();
        await expect(checks.nth(1)).not.toBeChecked();
        const mapChoice = dialog.locator('label').filter({ hasText: 'Allow qualified soundings' });
        await hit(mapChoice, width);
        await mapChoice.click();
        await dialog.getByLabel('Instrument depth reference').selectOption('T');
        await dialog.getByLabel('Exact instrument source identifier').fill('fixture:checked-transducer');
        await dialog.getByLabel('Sounder make and model').fill('Fictional test sounder');
        await dialog.getByLabel('Calibration date and time (UTC)').fill('2026-10-17T09:00');
        for (const [label, value] of [
            ['Measured waterline to transducer (m)', '0.8'],
            ['Offset uncertainty bound (m)', '0.1'],
            ['Sounder uncertainty bound (m)', '0.2'],
            ['Maximum depth actually checked (m)', '30'],
        ]) {
            const input = dialog.getByLabel(label);
            await hit(input, width);
            await input.fill(value);
        }
        const confirm = dialog.locator('label').filter({ hasText: 'I checked these measurements' });
        await hit(confirm, width);
        await confirm.click();
        await expect(checks.nth(1)).not.toBeChecked();
        const close = dialog.getByRole('button', { name: 'Close', exact: true }).last(),
            save = dialog.getByRole('button', { name: 'Save choices', exact: true });
        await hit(save, width);
        await expect(save).toBeEnabled();
        const pinned = await close.boundingBox();
        await dialog.locator('[data-modal-sheet-body]').evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        await hit(close, width);
        expect(await close.boundingBox()).toEqual(pinned);
        await save.click();
        await expect(dialog.getByRole('status')).toContainText('Choices saved for future captures');
        expect(
            await dialog.locator('[data-modal-sheet-body]').evaluate((body) => {
                const bounds = body.getBoundingClientRect();
                return (
                    body.scrollWidth <= body.clientWidth + 1 &&
                    body.scrollLeft === 0 &&
                    [...body.querySelectorAll('label,input,select,p,legend')].every((el) => {
                        const r = el.getBoundingClientRect();
                        return r.left >= bounds.left && r.right <= bounds.right;
                    })
                );
            }),
        ).toBe(true);
        await hit(close, width);
        await page.screenshot({ path: info.outputPath('crowd-consent.png'), animations: 'disabled' });
        await close.click();
        await expect(html).toHaveAttribute('data-crowd-reads', '0');
        const toggle = page.getByRole('button', { name: 'Crowd soundings', exact: true });
        await hit(toggle, width);
        await toggle.click();
        await expect(html).toHaveAttribute('data-crowd-reads', '3');
        await expect(html).toHaveAttribute('data-crowd-features', '1');
        const credits = page.getByRole('button', { name: /^Credits(?:;|$)/ });
        await hit(credits, width);
        await credits.click();
        const creditsDialog = page.getByRole('dialog');
        await creditsDialog.evaluate(async (element) => {
            await Promise.allSettled(
                element
                    .getAnimations({ subtree: true })
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished),
            );
        });
        const source = creditsDialog.getByRole('region', { name: 'Crowd soundings', exact: true });
        await expect(source).toContainText('0.5 m is contour spacing, not accuracy');
        await source.scrollIntoViewIfNeeded();
        const closeCredits = page.getByRole('button', { name: 'Close credits', exact: true });
        await hit(closeCredits, width);
        const creditsPinned = await closeCredits.boundingBox();
        await creditsDialog.locator('[data-modal-sheet-body]').evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        await hit(closeCredits, width);
        expect(await closeCredits.boundingBox()).toEqual(creditsPinned);
        await closeCredits.click();
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        expect(
            await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]),
        ).toEqual([width, 667]);
        await page.screenshot({ path: info.outputPath('crowd-overlay.png'), animations: 'disabled' });
        await page.getByRole('button', { name: 'Hide all', exact: true }).click();
        await expect(html).toHaveAttribute('data-crowd-features', '0');
        await expect(html).toHaveAttribute('data-crowd-reads', '3');
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        expect(errors).toEqual([]);
    });
