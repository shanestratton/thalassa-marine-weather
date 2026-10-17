import { test, expect, type Locator } from '@playwright/test';
async function reachable(control: Locator, width: number) {
    // Chromium's nearest-scroll visibility calculation can leave a fractional
    // edge clipped. Centre through the actual scroll container, then require
    // the full44px clipped target below, without a geometry tolerance.
    await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
    );
    const measure = () =>
        control.evaluate((element) => {
            const r = element.getBoundingClientRect();
            let left = r.left,
                right = r.right,
                top = r.top,
                bottom = r.bottom;
            for (let p = element.parentElement; p; p = p.parentElement) {
                const css = getComputedStyle(p),
                    box = p.getBoundingClientRect();
                if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) {
                    left = Math.max(left, box.left);
                    right = Math.min(right, box.right);
                }
                if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) {
                    top = Math.max(top, box.top);
                    bottom = Math.min(bottom, box.bottom);
                }
            }
            const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
            return {
                left,
                right,
                top,
                bottom,
                width: right - left,
                height: bottom - top,
                hit: !!hit && (hit === element || element.contains(hit)),
            };
        });
    // Require full clipped44px and the real hit target at stable paint.
    let result = await measure();
    await expect
        .poll(async () => {
            result = await measure();
            return (
                result.width >= 44 &&
                result.height >= 44 &&
                result.left >= 0 &&
                result.right <= width &&
                result.top >= 0 &&
                result.bottom <= 667 &&
                result.hit
            );
        })
        .toBe(true);
    expect(result.width).toBeGreaterThanOrEqual(44);
    expect(result.height).toBeGreaterThanOrEqual(44);
    expect(result.left).toBeGreaterThanOrEqual(0);
    expect(result.right).toBeLessThanOrEqual(width);
    expect(result.top).toBeGreaterThanOrEqual(0);
    expect(result.bottom).toBeLessThanOrEqual(667);
    expect(result.hit).toBe(true);
}
for (const width of [300, 375, 430])
    for (const large of [false, true])
        for (const kind of ['skill', 'buoy', 'credits']) {
            test(`weather evidence ${kind} ${width}px ${large ? '130%' : 'normal'} stays bounded`, async ({
                page,
            }, info) => {
                await page.setViewportSize({ width, height: 667 });
                const errors: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await page.route('**/*', (route) =>
                    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
                        ? route.continue()
                        : route.abort(),
                );
                await page.routeWebSocket('**/*', (socket) => socket.close());
                await page.goto(`/e2e/fixtures/weather-evidence141.html?kind=${kind}&large=${large ? 1 : 0}`);
                if (kind === 'credits') {
                    await page.getByRole('button', { name: 'Credits', exact: true }).click();
                } else
                    await page
                        .getByRole('button', {
                            name: kind === 'buoy' ? 'Open buoy' : 'Choose forecast model',
                            exact: true,
                        })
                        .click();
                const dialog = page.getByRole('dialog');
                await expect(dialog).toBeVisible();
                await dialog.evaluate(async (element) => {
                    await Promise.all(
                        element
                            .getAnimations({ subtree: true })
                            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                            .map((a) => a.finished),
                    );
                });
                if (kind === 'skill') {
                    await expect(page.locator('html')).toHaveAttribute('data-evidence-reads', '0');
                    const summary = page.getByText('Forecast skill nearby', { exact: true });
                    await reachable(summary, width);
                    await summary.click();
                    await expect(page.getByText(/Warming at this station/)).toBeVisible();
                    for (const control of [page.getByLabel('Skill measure'), page.getByLabel('Skill forecast lead')])
                        await reachable(control, width);
                    await page.getByLabel('Skill measure').selectOption('wave_hs_m');
                    await page.getByLabel('Skill forecast lead').selectOption('48-72h');
                    await expect(page.getByText(/Warming at this station/)).toBeVisible();
                    await expect(page.locator('html')).toHaveAttribute('data-evidence-reads', '3');
                    await expect(page.getByText(/Closest here lately:/)).toHaveCount(0);
                    await page.getByLabel('Skill forecast lead').scrollIntoViewIfNeeded();
                } else if (kind === 'buoy') {
                    const pinned = dialog.getByRole('button', { name: 'Close buoy', exact: true });
                    const before = await pinned.boundingBox();
                    await expect(page.getByText(/Provisional measurements are not scored/)).toBeVisible();
                    await expect(page.getByRole('img', { name: /72-hour measured waves/ })).toBeVisible();
                    await expect(page.getByText(/No captured forecast history is available yet/)).toBeVisible();
                    for (const name of ['Source data', 'Source terms'])
                        await reachable(page.getByRole('link', { name, exact: true }), width);
                    await reachable(pinned, width);
                    expect(await pinned.boundingBox()).toEqual(before);
                    await expect(page.locator('html')).toHaveAttribute('data-evidence-reads', '0');
                } else {
                    const pinned = dialog.getByRole('button', { name: 'Close credits', exact: true });
                    const before = await pinned.boundingBox();
                    await dialog.getByRole('heading', { name: 'Source 5', exact: true }).scrollIntoViewIfNeeded();
                    const texts = dialog.getByText(/Synthetic source credit/);
                    await texts.last().scrollIntoViewIfNeeded();
                    await expect(texts.last()).toBeVisible();
                    await reachable(pinned, width);
                    expect(await pinned.boundingBox()).toEqual(before);
                }
                expect(
                    await page.evaluate(() => ({
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    })),
                ).toEqual({ width, height: 667 });
                expect(
                    await dialog.evaluate((element) =>
                        Array.from(element.querySelectorAll('*'))
                            .filter(
                                (e) =>
                                    e.clientWidth > 0 &&
                                    getComputedStyle(e).overflowX === 'visible' &&
                                    e.scrollWidth > e.clientWidth + 1,
                            )
                            .map((e) => e.tagName + ':' + e.textContent?.slice(0, 60)),
                    ),
                ).toEqual([]);
                await page.screenshot({ path: info.outputPath('weather-evidence.png'), animations: 'disabled' });
                const close = page
                    .getByRole('button', {
                        name: kind === 'credits' ? 'Close credits' : kind === 'buoy' ? 'Close buoy' : 'Close',
                        exact: true,
                    })
                    .last();
                await reachable(close, width);
                await close.click();
                await expect(dialog).toHaveCount(0);
                expect(errors).toEqual([]);
            });
        }
