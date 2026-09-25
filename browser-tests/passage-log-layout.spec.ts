import { expect, test } from '@playwright/test';

test('passage archive shows the exact count and confirmation fits a 390px phone', async ({ page, baseURL }, info) => {
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/functions/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/passage-log.html');
    const archive = page.getByRole('button', { name: 'Archive passage', exact: true });
    await expect(archive).toBeInViewport();
    expect((await archive.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('passage-archive-action.png') });
    // iOS touch taps do not focus buttons; seed keyboard focus to verify restoration.
    await archive.focus();
    await archive.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Archive this passage?' });
    await expect(dialog).toContainText('Move all 3 legs into Archived Voyages. Nothing is deleted');
    const confirm = dialog.getByRole('button', { name: 'Archive 3 legs', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(confirm).toBeInViewport();
    await expect(cancel).toBeInViewport();
    await expect(cancel).toBeFocused();
    const panel = dialog.locator('[data-pane-dialog-panel]');
    await expect(panel).toHaveCSS('opacity', '1');
    // Capture the resting surface, not the intentionally translucent entrance animation.
    expect(
        await panel.evaluate((element) => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d')!;
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return { opacity: style.opacity, backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3] };
        }),
    ).toEqual({ opacity: '1', backgroundAlpha: 255 });
    expect(
        await dialog.evaluate((element) => {
            const panel = element.querySelector('[data-pane-dialog-panel]')!;
            const bounds = panel.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && panel.scrollWidth <= panel.clientWidth;
        }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('passage-archive-confirm.png'), animations: 'disabled' });
    await cancel.click();
    await expect(dialog).not.toBeVisible();
    await expect(archive).toBeFocused();
    expect(
        await page.evaluate(
            () => (window as unknown as { __passageArchiveRequests: unknown[] }).__passageArchiveRequests,
        ),
    ).toEqual([]);
    await archive.click();
    await confirm.click();
    await expect(dialog).not.toBeVisible();
    expect(
        await page.evaluate(
            () => (window as unknown as { __passageArchiveRequests: unknown[] }).__passageArchiveRequests,
        ),
    ).toEqual([{ passageId: 'fixture-passage', voyageIds: ['fixture-0', 'fixture-1', 'fixture-2'] }]);
});
