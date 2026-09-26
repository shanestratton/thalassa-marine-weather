import { expect, test } from '@playwright/test';

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
