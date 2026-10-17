import { test, expect, type Locator } from '@playwright/test';
async function reachable(control: Locator, width: number) {
    await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const r = element.getBoundingClientRect();
                let left = r.left,
                    right = r.right,
                    top = r.top,
                    bottom = r.bottom;
                for (let p = element.parentElement; p; p = p.parentElement) {
                    const style = getComputedStyle(p),
                        box = p.getBoundingClientRect();
                    if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
                        left = Math.max(left, box.left);
                        right = Math.min(right, box.right);
                    }
                    if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
                        top = Math.max(top, box.top);
                        bottom = Math.min(bottom, box.bottom);
                    }
                }
                const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                return (
                    right - left >= 44 &&
                    bottom - top >= 44 &&
                    left >= 0 &&
                    right <= innerWidth &&
                    top >= 0 &&
                    bottom <= 667 &&
                    !!hit &&
                    (hit === element || element.contains(hit))
                );
            }),
        )
        .toBe(true);
    expect(await control.evaluate((e) => e.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
}
for (const width of [300, 375, 430])
    for (const large of [false, true]) {
        test(`private scorecard ${width}px ${large ? '130%' : 'normal'} keeps opt-in and privacy controls reachable`, async ({
            page,
        }, info) => {
            await page.setViewportSize({ width, height: 667 });
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.route('**/*', (r) =>
                ['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort(),
            );
            await page.routeWebSocket('**/*', (socket) => socket.close());
            await page.goto(`/e2e/fixtures/own-boat-skill141.html?large=${large ? 1 : 0}`);
            await page.getByRole('button', { name: 'Open private controls', exact: true }).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await dialog.evaluate(async (e) => {
                await Promise.all(
                    e
                        .getAnimations({ subtree: true })
                        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                        .map((a) => a.finished),
                );
            });
            const pinned = dialog.getByRole('button', { name: 'Close private controls', exact: true });
            const summary = page.locator('summary').filter({ hasText: 'Private boat scorecard' });
            await reachable(summary, width);
            await summary.click();
            await expect(page.locator('html')).toHaveAttribute('data-private-requests', '0');
            const review = page.getByRole('button', { name: 'Review instruments', exact: true });
            await reachable(review, width);
            await review.click();
            const confirm = page.getByRole('button', { name: 'Save access with logging off', exact: true });
            await expect(confirm).toBeDisabled();
            const before = await pinned.boundingBox();
            const association = page.getByRole('checkbox', { name: /I confirm/ }),
                logging = page.getByRole('checkbox', { name: /Log true wind/ });
            await expect(association).not.toBeChecked();
            await expect(logging).not.toBeChecked();
            await reachable(association.locator('..'), width);
            await association.locator('..').click();
            await reachable(logging.locator('..'), width);
            await logging.locator('..').click();
            const enable = page.getByRole('button', { name: 'Enable private logging', exact: true });
            await reachable(enable, width);
            await page.screenshot({ path: info.outputPath('review.png'), animations: 'disabled' });
            await enable.click();
            const read = page.getByRole('button', { name: 'Read private scorecard', exact: true });
            await reachable(read, width);
            await read.click();
            await expect(page.getByText(/Warming\. No score or closest model yet/)).toBeVisible();
            const lead = page.getByRole('combobox', { name: 'Private wind forecast lead' });
            await reachable(lead, width);
            await lead.selectOption('48-72h');
            expect(await lead.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(15, 23, 42)');
            const stop = page.getByRole('button', { name: 'Stop private logging', exact: true });
            await reachable(stop, width);
            const clear = page.getByRole('button', { name: 'Stop and clear private evidence', exact: true });
            await reachable(clear, width);
            await page.screenshot({ path: info.outputPath('scorecard.png'), animations: 'disabled' });
            await clear.click();
            await expect(
                page.getByText(/Pi confirmed logging off and private scorecard evidence cleared/),
            ).toBeVisible();
            await reachable(pinned, width);
            expect(await pinned.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');
            expect(await pinned.boundingBox()).toEqual(before);
            expect(
                await page.evaluate(() => ({
                    width: document.documentElement.scrollWidth,
                    height: document.documentElement.scrollHeight,
                })),
            ).toEqual({ width, height: 667 });
            expect(
                await dialog.evaluate((e) =>
                    [...e.querySelectorAll('*')]
                        .filter(
                            (v) =>
                                v.clientWidth > 0 &&
                                getComputedStyle(v).overflowX === 'visible' &&
                                v.scrollWidth > v.clientWidth + 1,
                        )
                        .map((v) => v.tagName),
                ),
            ).toEqual([]);
            await pinned.click();
            await expect(dialog).toHaveCount(0);
            expect(errors).toEqual([]);
        });
    }
