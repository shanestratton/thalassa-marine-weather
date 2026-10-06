import { expect, test, type Locator, type Page } from '@playwright/test';

test('archive cards and passage restoration stay readable on small phones and desktop', async ({
    page,
    baseURL,
}, info) => {
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
        if (url.pathname === '/pages/log/useEndpointNames.ts') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: `const names={
                    '-20':['Butterfly Bay','Daydream Island'],
                    '-21':['Whitsundays','Butterfly Bay'],
                    '-22':['Mackay Harbour','Whitsundays'],
                    '-23':['Callemondah','Mackay Harbour'],
                    '-27':['Newport','Callemondah']
                }; export const useEndpointNames=(first)=>{const pair=names[first.latitude];return {startLabel:pair[0],endLabel:pair[1]}};`,
            });
        }
        return route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/fixtures/archive-log.html');
    // The card shows the count; the passages are in its VoiceOver description.
    await expect(page.locator('button[aria-label="Archived voyages"] .sr-only')).toHaveText('5 voyages · 1 passage');
    await expect(page.getByRole('article')).toHaveCount(5);
    for (const width of [320, 390, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => document.fonts.ready);
        // The archive is a sheet now (2026-10-06): measure it once its zoom-in has settled.
        await sheetSettled(page);
        const problems = await page.evaluate(() => {
            const problems: string[] = [];
            for (const element of [document.documentElement, ...document.querySelectorAll('article')]) {
                if (element.scrollWidth > element.clientWidth + 1) problems.push('Horizontal overflow');
            }
            for (const button of document.querySelectorAll('article button')) {
                const bounds = button.getBoundingClientRect();
                if (bounds.width < 44 || bounds.height < 44) problems.push('Small touch target');
                if (bounds.left < 0 || bounds.right > innerWidth) problems.push('Clipped restore action');
            }
            return problems;
        });
        expect(problems).toEqual([]);
        if (width === 390)
            await page.screenshot({
                path: info.outputPath('archive-phone.png'),
                fullPage: true,
                animations: 'disabled',
            });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const lastRestore = page.getByRole('button', { name: /^Restore voyage Newport/ });
    await lastRestore.scrollIntoViewIfNeeded();
    await expect(lastRestore).toBeInViewport();
    await page.screenshot({ path: info.outputPath('archive-phone-bottom.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Restore passage' }).click();
    await expect(page.getByRole('dialog', { name: 'Restore this passage?' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Restore 3 legs' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('restore-passage-phone.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Restore 3 legs' }).click();
    await expect(page.getByRole('article')).toHaveCount(2);
    await expect(page.getByText('2 voyages', { exact: true })).toBeVisible();
    // The archive opens as a sheet over its card (2026-10-06); Close puts it away.
    await page
        .getByRole('dialog', { name: 'Archived voyages' })
        .getByRole('button', { name: 'Close', exact: true })
        .click();
    await expect(page.getByRole('article')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archived voyages', exact: true })).toHaveAttribute(
        'aria-expanded',
        'false',
    );
    expect(errors).toEqual([]);
});

async function settledScroll(port: Locator) {
    let previous = Number.NaN;
    let stable = 0;
    await expect
        .poll(
            async () => {
                const top = await port.evaluate((element) => element.scrollTop);
                stable = Math.abs(previous - top) < 0.5 ? stable + 1 : 0;
                previous = top;
                return stable;
            },
            { intervals: [100] },
        )
        .toBeGreaterThanOrEqual(4);
}

const ENDPOINT_NAMES = `
    const names={'-20':['Butterfly Bay','Daydream Island'],'-21':['Whitsundays','Butterfly Bay'],'-22':['Mackay Harbour','Whitsundays'],'-23':['Callemondah','Mackay Harbour'],'-27':['Newport','Callemondah']};
    export const useEndpointNames=(first)=>{const pair=names[first.latitude];return {startLabel:pair[0],endLabel:pair[1]}};
`;

async function openFixture(page: Page, baseURL: string | undefined, query: string) {
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
        if (url.pathname === '/pages/log/useEndpointNames.ts') {
            return route.fulfill({ contentType: 'text/javascript', body: ENDPOINT_NAMES });
        }
        return route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.goto(`/e2e/fixtures/archive-log.html?${query}`);
    await page.evaluate(() => document.fonts.ready);
}

/** The sheet opens with a short zoom-in; measure it at rest, not at 95 %. */
async function sheetSettled(page: Page) {
    await page.evaluate(async () => {
        const panels = [...document.querySelectorAll('[data-modal-sheet]')];
        await Promise.all(
            panels.flatMap((panel) =>
                panel.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
            ),
        );
    });
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** The open sheet is centred, inside the screen and clear of the tab bar. */
async function sheetClearOfTabBar(page: Page, name: string) {
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    await sheetSettled(page);
    const panel = (await dialog.locator('[data-modal-sheet]').boundingBox())!;
    const bar = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(panel.y + panel.height, `${name} sheet clears the tab bar`).toBeLessThanOrEqual(bar.y + 0.5);
    return dialog;
}

test.describe('anchored Voyage stats and Archived voyages', () => {
    // Shane 2026-10-06: "can we make the voyage stats and the archive voyages
    // anchored to the page and also make them look the same as the diary and
    // scuttlebutt boxes for consistency". Native wheel input is unavailable in
    // mobile WebKit; these are real browser gestures at phone sizes.
    test.use({ isMobile: false, hasTouch: false });

    for (const viewport of [
        { width: 320, height: 568 },
        { width: 375, height: 667 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
    ]) {
        test(`the pair stays put while the voyage list scrolls, and opens its sheets, at ${viewport.width}x${viewport.height}`, async ({
            page,
            baseURL,
        }, info) => {
            await page.setViewportSize(viewport);
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await openFixture(page, baseURL, 'log=1');
            const port = page.getByRole('region', { name: 'Voyage history', exact: true });
            const archive = page.getByRole('button', { name: 'Archived voyages', exact: true });
            const stats = page.getByRole('button', { name: 'Voyage stats', exact: true });
            await expect(archive).toHaveAttribute('aria-expanded', 'false');
            await expect(archive.getByText('5 voyages', { exact: true })).toBeVisible();
            await expect(archive).toHaveAccessibleDescription('5 voyages · 1 passage');
            await expect(page.getByText('9 voyages · 621 nm', { exact: true })).toBeVisible();
            // Outside the scroll region, side by side, neither covering the other.
            expect(
                await port.evaluate((el) =>
                    [...document.querySelectorAll('.log-journal-pair button')].map((card) => el.contains(card)),
                ),
            ).toEqual([false, false]);
            const statsBefore = (await stats.boundingBox())!;
            const archiveBefore = (await archive.boundingBox())!;
            const portBox = (await port.boundingBox())!;
            expect(overlaps(statsBefore, archiveBefore)).toBe(false);
            expect(Math.abs(statsBefore.y - archiveBefore.y)).toBeLessThan(1);
            expect(statsBefore.y + statsBefore.height).toBeLessThanOrEqual(portBox.y + 0.5);
            // Every word whole on the card: title and subline unclipped. The
            // text's own width, fractional: scrollWidth rounds, and with 1 px
            // of slack it passed a visibly cut "Archived voyag…" at 320.
            const clipped = await page.evaluate(() =>
                [...document.querySelectorAll('.log-journal-pair button')].flatMap((card) =>
                    [...card.querySelectorAll('.vessel-hub-tile-title, .vessel-hub-tile-sub')]
                        .filter((text) => {
                            const range = document.createRange();
                            range.selectNodeContents(text);
                            const box = text.getBoundingClientRect();
                            return (
                                range.getBoundingClientRect().width > box.width + 0.25 ||
                                box.bottom > card.getBoundingClientRect().bottom + 0.5
                            );
                        })
                        .map((text) => text.textContent),
                ),
            );
            expect(clipped).toEqual([]);
            const headerBefore = await page.getByRole('banner', { name: 'Log header' }).boundingBox();
            const footer = page.getByRole('contentinfo', { name: 'Tracking controls' });
            const footerBefore = (await footer.boundingBox())!;
            expect(overlaps(archiveBefore, footerBefore)).toBe(false);

            // The list scrolls under them; the cards do not move.
            await port.hover();
            await page.mouse.wheel(0, 800);
            await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
            await settledScroll(port);
            expect(await stats.boundingBox()).toEqual(statsBefore);
            expect(await archive.boundingBox()).toEqual(archiveBefore);
            expect(await page.getByRole('banner', { name: 'Log header' }).boundingBox()).toEqual(headerBefore);
            expect(await footer.boundingBox()).toEqual(footerBefore);
            await page.screenshot({ path: info.outputPath('log-pair-scrolled.png'), animations: 'disabled' });

            // Voyage stats opens the totals and records in a sheet.
            await stats.click();
            await expect(stats).toHaveAttribute('aria-expanded', 'true');
            const statsSheet = await sheetClearOfTabBar(page, 'Voyage stats');
            await expect(statsSheet.getByText('Farthest')).toBeVisible();
            await statsSheet.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(stats).toHaveAttribute('aria-expanded', 'false');

            // Archived voyages opens the archive, Restore and all.
            await archive.click();
            const archiveSheet = await sheetClearOfTabBar(page, 'Archived voyages');
            const lastRestore = archiveSheet.getByRole('button', { name: /^Restore voyage Newport/ });
            await lastRestore.scrollIntoViewIfNeeded();
            await expect(lastRestore).toBeInViewport();
            const problems = await page.evaluate(() => {
                const issues: string[] = [];
                for (const element of [
                    document.documentElement,
                    ...document.querySelectorAll('[data-modal-sheet], [aria-label="Voyage history"], article'),
                ]) {
                    if (element.scrollWidth > element.clientWidth + 1) issues.push('Horizontal overflow');
                }
                for (const button of document.querySelectorAll('[data-modal-sheet] button')) {
                    const rect = button.getBoundingClientRect();
                    if (rect.width < 44 || rect.height < 44) issues.push('Small touch target');
                    if (rect.left < -1 || rect.right > innerWidth + 1) issues.push('Clipped action');
                }
                return issues;
            });
            expect(problems).toEqual([]);
            await page.screenshot({ path: info.outputPath('log-archive-sheet.png'), animations: 'disabled' });
            await lastRestore.click();
            await expect(page.locator('button[aria-label="Archived voyages"] .sr-only')).toHaveText(
                '4 voyages · 1 passage',
            );
            await expect(archiveSheet.getByRole('status')).toHaveText('Voyage restored to your log.');
            expect(errors).toEqual([]);
        });
    }

    test('recording: Voyage stats alone, one row, above the live card', async ({ page, baseURL }) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await openFixture(page, baseURL, 'log=1&tracking=1');
        const stats = page.getByRole('button', { name: 'Voyage stats', exact: true });
        await expect(stats).toBeVisible();
        await expect(page.getByRole('button', { name: 'Archived voyages', exact: true })).toHaveCount(0);
        const card = (await stats.boundingBox())!;
        const live = (await page.getByRole('region', { name: 'Live voyage' }).boundingBox())!;
        expect(card.height).toBeLessThanOrEqual(57);
        expect(card.y + card.height).toBeLessThanOrEqual(live.y + 0.5);
        expect(await stats.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row');
    });
});
