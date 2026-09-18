import { expect, test, type Page, type TestInfo } from '@playwright/test';

const sizes = [
    { width: 390, height: 844, pane: false },
    { width: 430, height: 932, pane: false },
    { width: 1024, height: 768, pane: true },
];

async function assertMusicFits(page: Page) {
    expect(
        await page.getByTestId('music-pane').evaluate((pane) => {
            const bounds = pane.getBoundingClientRect();
            const errors: string[] = [];
            for (const element of [pane, document.documentElement, document.body]) {
                if (element.scrollWidth > element.clientWidth + 1)
                    errors.push(`Horizontal overflow: ${element.tagName}`);
            }
            const stage = pane.querySelector('[data-testid^="music-player-"]')!;
            for (const element of [stage, ...stage.querySelectorAll('button')]) {
                const box = element.getBoundingClientRect();
                if (box.left < bounds.left - 1 || box.right > bounds.right + 1)
                    errors.push(`Stage/control escapes pane: ${element.textContent}`);
            }
            // Only the playlist rail itself may scroll horizontally.
            for (const tile of pane.querySelectorAll('button[aria-pressed]')) {
                if (tile.scrollWidth > tile.clientWidth + 1)
                    errors.push(`Playlist clips horizontally: ${tile.getAttribute('aria-label')}`);
            }
            return errors;
        }),
    ).toEqual([]);
}

async function capture(page: Page, info: TestInfo, label: string) {
    const path = info.outputPath(`${label}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(label, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    for (const mode of ['light', 'dark', 'night']) {
        test(`Music Stop resets compact player at ${size.width} ${mode}${size.pane ? ' split' : ''}`, async ({
            page,
        }, info) => {
            test.setTimeout(60_000);
            const origin = 'http://127.0.0.1:4199';
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                return url.origin === origin &&
                    ['GET', 'HEAD'].includes(route.request().method()) &&
                    !url.pathname.startsWith('/api/')
                    ? route.continue()
                    : route.abort();
            });
            await page.routeWebSocket('**/*', (socket) => socket.close());
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.goto(`/e2e/fixtures/music-layout.html?mode=${mode}&pane=${size.pane}`);
            const tile = page.getByRole('button', { name: 'Harbour After Hours', exact: true });
            await expect(tile).toBeVisible();
            await page.evaluate(async () => {
                await document.fonts.ready;
            });
            const idle = page.getByTestId('music-player-idle');
            await expect(idle).toContainText('All quiet on deck');
            await expect(page.getByTestId('music-on-deck-empty')).toContainText('Songs line up here');
            await expect(tile).toHaveAttribute('aria-pressed', 'false');
            const initial = await idle.boundingBox();
            await assertMusicFits(page);
            await capture(page, info, 'music-initial');

            await tile.click();
            await expect(page.getByTestId('music-player-active')).toContainText('Sea Song');
            await expect(tile).toHaveText(/Playing/);
            await expect(page.getByRole('button', { name: /Lights Across the Water Northern Passage/ })).toBeVisible();
            await page.getByRole('button', { name: 'Pause', exact: true }).scrollIntoViewIfNeeded();
            await assertMusicFits(page);
            await capture(page, info, 'music-playing');
            await page.getByRole('button', { name: 'Pause', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
            await expect(tile).toHaveText(/Paused/);
            await expect(page.getByTestId('music-player-active')).toContainText('Sea Song');
            expect(
                await page.evaluate(
                    () => (window as unknown as { __musicFixture: { queue: string[] } }).__musicFixture.queue,
                ),
            ).toHaveLength(3);

            await page.getByRole('button', { name: 'Stop the music and clear the queue', exact: true }).click();
            await expect(idle).toBeVisible();
            await expect(tile).toHaveAttribute('aria-pressed', 'false');
            await expect(page.getByTestId('music-player-active')).toHaveCount(0);
            await expect(page.getByRole('progressbar')).toHaveCount(0);
            await expect(page.getByTestId('music-on-deck-empty')).toContainText('Songs line up here');
            expect(await idle.boundingBox()).toEqual(initial);
            expect(
                await page.evaluate(
                    () =>
                        (window as unknown as { __musicFixture: { queue: string[]; stops: number; pauses: number } })
                            .__musicFixture,
                ),
            ).toMatchObject({ queue: [], stops: 1, pauses: 1 });
            // Give the cancelled artwork refresh and native poll time to return
            // retained metadata. It must not restore the expanded stage.
            await page.waitForTimeout(1100);
            await expect(idle).toBeVisible();
            await assertMusicFits(page);
            await capture(page, info, 'music-stopped');

            const options = page.getByRole('button', { name: 'More options for Harbour After Hours', exact: true });
            await options.focus();
            await options.click();
            const dialog = page.getByRole('dialog', { name: 'Harbour After Hours', exact: true });
            await expect(dialog).toBeVisible();
            const close = dialog.getByRole('button', {
                name: 'Close Harbour After Hours playlist details',
                exact: true,
            });
            await expect(close).toBeInViewport();
            const frame = await page.getByTestId('music-pane').boundingBox();
            const modal = await dialog.boundingBox();
            if (size.pane) {
                expect(modal!.x).toBeGreaterThanOrEqual(frame!.x - 1);
                expect(modal!.x + modal!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
            }
            await capture(page, info, 'music-playlist-details');
            await close.click();
            await expect(options).toBeFocused();
            await tile.click();
            await expect(page.getByTestId('music-player-active')).toContainText('Sea Song');
        });
    }
}
