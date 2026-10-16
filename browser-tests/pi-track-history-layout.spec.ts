import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ viewport: { width: 300, height: 640 } });
test('private track graphs, partial exports and nested local map fit 300 px with enlarged text', async ({
    page,
}, info) => {
    const remote: string[] = [];
    page.on('request', (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:'))
            remote.push(request.url());
    });
    await page.goto('/e2e/fixtures/pi-track-history.html?partial');
    await page.addStyleTag({ content: 'html{font-size:130%}' });
    await page.getByRole('button', { name: 'Open boat track' }).click();
    const dialog = page.getByRole('dialog', { name: 'Boat track history', exact: true });
    await expect(dialog.getByText(/4 loaded fixes/)).toBeVisible();
    await expect(dialog.getByText(/Partial window:/)).toBeVisible();
    await expect(dialog.locator('figure')).toHaveCount(5);
    await expect(dialog.getByText('No recorded measurements')).toHaveCount(1);
    await expect.poll(() => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    for (const input of await dialog.locator('input').all()) {
        const rectangle = await input.boundingBox();
        expect(rectangle!.x).toBeGreaterThanOrEqual(0);
        expect(rectangle!.x + rectangle!.width).toBeLessThanOrEqual(300);
    }
    await dialog.getByRole('slider').press('ArrowRight');
    await expect(dialog.getByTestId('track-selected-time')).toContainText('UTC');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export GPX' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('partial');
    const xml = await readFile((await download.path())!, 'utf8');
    expect(xml).toContain('PARTIAL: remaining data is not included');
    expect(xml.match(/<trkpt /g)).toHaveLength(4);
    expect(xml).not.toContain('<thalassa:pressure_hpa>');
    await dialog.getByRole('button', { name: 'View track map' }).click();
    const map = page.getByRole('dialog', { name: 'Voyage track viewer' });
    await expect(map.getByText('Logged wind (kt)')).toBeVisible();
    await expect(map.getByText('Partial loaded batch')).toBeVisible();
    const plot = map.getByRole('img', { name: /Logged positions on a local coordinate plot/ });
    await expect(plot).toBeVisible();
    await expect(plot.locator('path[data-recorded-track]')).toHaveCount(2);
    // Dateline segments occupy the local view; they do not make a line around the planet.
    const span = await plot
        .locator('path[data-recorded-track]')
        .first()
        .evaluate((path) => {
            const rect = (path as SVGPathElement).getBBox();
            return { width: rect.width, x: rect.x };
        });
    expect(span.width).toBeGreaterThan(100);
    expect(span.x).toBeGreaterThanOrEqual(0);
    await expect(map.locator('.mapboxgl-canvas')).toHaveCount(0);
    await expect(map).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('private-track-map-300.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(map).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'View track map' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'View track map' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open boat track' })).toBeFocused();
    expect(remote).toEqual([]);
});

test('legacy Pi update message and cancellation remain reachable without an invented empty voyage', async ({
    page,
}) => {
    await page.goto('/e2e/fixtures/pi-track-history.html?legacy');
    await page.getByRole('button', { name: 'Open boat track' }).click();
    await expect(page.getByRole('alert')).toContainText('Update the Pi');
    await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
    await page.goto('/e2e/fixtures/pi-track-history.html?pending');
    await page.getByRole('button', { name: 'Open boat track' }).click();
    await page.getByRole('button', { name: 'Cancel read' }).click();
    await expect(page.getByText('Read cancelled; no track loaded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export GPX' })).toHaveCount(0);
});

test('ten thousand generated fixes remain bounded and missing pressure stays unknown', async ({ page }) => {
    await page.goto('/e2e/fixtures/pi-track-history.html?many');
    await page.getByRole('button', { name: 'Open boat track' }).click();
    await expect(page.getByText(/10,000 loaded fixes/)).toBeVisible();
    await expect(page.getByRole('slider')).toHaveAttribute('max', '9999');
    await page.getByRole('slider').press('End');
    await expect(page.getByTestId('track-selected-time')).toContainText('2026-01-02 00:00:00.000 UTC');
    await expect(page.getByText('No recorded measurements')).toHaveCount(1);
});
