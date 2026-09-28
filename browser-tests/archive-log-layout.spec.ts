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
    await expect(page.getByText('5 voyages · 1 passage')).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(5);
    for (const width of [320, 390, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => document.fonts.ready);
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
    await page.getByRole('button', { name: 'Archived voyages', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
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

async function fullyInside(element: Locator, port: Locator) {
    const rect = await element.boundingBox();
    const bounds = await port.boundingBox();
    return !!rect && !!bounds && rect.y >= bounds.y - 1 && rect.y + rect.height <= bounds.y + bounds.height + 1;
}

async function returnHistoryToTop(page: Page, port: Locator) {
    await port.hover();
    await page.mouse.wheel(0, 800);
    await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
    await settledScroll(port);
    await page.mouse.wheel(0, -5000);
    // Wait after releasing the wheel gesture: proximity snapping previously
    // moved the first current-voyage card to the top and hid the archive.
    await settledScroll(port);
    await expect.poll(() => port.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
}

async function returnToArchive(page: Page, port: Locator, archive: Locator) {
    await port.hover();
    await page.mouse.wheel(0, 1000);
    await settledScroll(port);
    const archiveRect = await archive.boundingBox();
    const portRect = await port.boundingBox();
    // Expanded stats share the same scrollport. Return to the archive itself,
    // not past its now-taller preceding stats content, then release the wheel.
    await page.mouse.wheel(0, archiveRect!.y - portRect!.y - 8);
    await settledScroll(port);
    expect(await fullyInside(archive, port)).toBe(true);
}

test.describe('whole log scroll layout', () => {
    // Native wheel input is unavailable in mobile WebKit. These are real
    // browser gestures at phone viewport sizes on both engines; the original
    // fixture test above retains the project's native mobile configuration.
    test.use({ isMobile: false, hasTouch: false });

    for (const viewport of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
    ]) {
        test(`archive remains reachable after scroll release at ${viewport.width}x${viewport.height}`, async ({
            page,
            baseURL,
        }, info) => {
            await page.setViewportSize(viewport);
            const origin = new URL(baseURL!).origin;
            await page.route('**/*', (route) => {
                const request = route.request();
                const url = new URL(request.url());
                if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
                if (url.pathname === '/pages/log/useEndpointNames.ts') {
                    return route.fulfill({
                        contentType: 'text/javascript',
                        body: `
                        const names={'-20':['Butterfly Bay','Daydream Island'],'-21':['Whitsundays','Butterfly Bay'],'-22':['Mackay Harbour','Whitsundays'],'-23':['Callemondah','Mackay Harbour'],'-27':['Newport','Callemondah']};
                        export const useEndpointNames=(first)=>{const pair=names[first.latitude];return {startLabel:pair[0],endLabel:pair[1]}};
                    `,
                    });
                }
                return route.continue();
            });
            await page.routeWebSocket('**/*', (socket) => socket.close());
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto('/e2e/fixtures/archive-log.html?log=1');
            const port = page.getByRole('region', { name: 'Voyage history', exact: true });
            const archive = page.getByRole('button', { name: 'Archived voyages', exact: true });
            const stats = page.getByRole('button', { name: 'Voyage stats', exact: true });
            await expect(archive).toHaveAttribute('aria-expanded', 'false');
            await expect(port).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            expect(await port.evaluate((element) => getComputedStyle(element).scrollSnapType)).toBe('none');
            expect(await page.getByRole('region', { name: 'Current voyages' }).locator('.snap-start').count()).toBe(4);
            const headerBefore = await page.getByRole('banner', { name: 'Log header' }).boundingBox();
            const footerBefore = await page.getByRole('contentinfo', { name: 'Tracking controls' }).boundingBox();
            await returnHistoryToTop(page, port);
            expect(await fullyInside(archive, port)).toBe(true);
            await expect(archive).toBeInViewport();

            await stats.click();
            await expect(stats).toHaveAttribute('aria-expanded', 'true');
            await expect.poll(() => port.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(44);
            await returnToArchive(page, port, archive);
            expect(await fullyInside(archive, port)).toBe(true);
            await archive.click();
            await expect(archive).toHaveAttribute('aria-expanded', 'true');
            const lastRestore = page.getByRole('button', { name: /^Restore voyage Newport/ });
            await lastRestore.scrollIntoViewIfNeeded();
            await settledScroll(port);
            expect(await fullyInside(lastRestore, port)).toBe(true);
            await expect(lastRestore).toBeInViewport();

            const problems = await page.evaluate(() => {
                const issues: string[] = [];
                for (const element of [
                    document.documentElement,
                    ...document.querySelectorAll('main, [aria-label="Voyage history"], article'),
                ]) {
                    if (element.scrollWidth > element.clientWidth + 1) issues.push('Horizontal overflow');
                }
                for (const button of document.querySelectorAll('button')) {
                    const rect = button.getBoundingClientRect();
                    if (rect.width < 44 || rect.height < 44) issues.push('Small touch target');
                    if (rect.left < -1 || rect.right > innerWidth + 1) issues.push('Clipped action');
                }
                return issues;
            });
            expect(problems).toEqual([]);
            expect(await page.getByRole('banner', { name: 'Log header' }).boundingBox()).toEqual(headerBefore);
            expect(await page.getByRole('contentinfo', { name: 'Tracking controls' }).boundingBox()).toEqual(
                footerBefore,
            );
            await page.screenshot({ path: info.outputPath('log-archive-expanded.png'), animations: 'disabled' });
            await lastRestore.click();
            await expect(page.getByText('4 voyages · 1 passage', { exact: true })).toBeVisible();
            expect(errors).toEqual([]);
        });
    }
});
