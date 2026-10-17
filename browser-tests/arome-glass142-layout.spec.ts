import { expect, test, type Locator } from '@playwright/test';

async function reachable(control: Locator, width: number) {
    await control.scrollIntoViewIfNeeded();
    const rect = await control.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeGreaterThanOrEqual(44);
    expect(rect!.height).toBeGreaterThanOrEqual(44);
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(667);
    const visible = await control.evaluate((element) => {
        const r = element.getBoundingClientRect();
        let left = r.left,
            right = r.right,
            top = r.top,
            bottom = r.bottom;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const css = getComputedStyle(parent),
                box = parent.getBoundingClientRect();
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
        return { width: right - left, height: bottom - top, hit: !!hit && (element === hit || element.contains(hit)) };
    });
    expect(visible.width).toBeGreaterThanOrEqual(44);
    expect(visible.height).toBeGreaterThanOrEqual(44);
    expect(visible.hit).toBe(true);
}

for (const width of [300, 375, 430])
    for (const large of [false, true])
        test(`AROME native and named fallback fit ${width}px ${large ? '130%' : 'normal'}`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 667 });
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('**/*', (route) =>
                ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
                    ? route.continue()
                    : route.abort(),
            );
            await page.routeWebSocket('**/*', (socket) => socket.close());
            for (const state of ['native', 'fallback']) {
                await page.goto(`/e2e/fixtures/marine-picker141.html?regional=1&state=${state}&large=${large ? 1 : 0}`);
                const opener = page.getByRole('button', { name: 'Choose forecast model', exact: true });
                const pageBounds = await page.evaluate(() => ({
                    width: document.documentElement.scrollWidth,
                    height: document.documentElement.scrollHeight,
                }));
                // Keyboard entry establishes a real restore target. Safari's
                // pointer activation deliberately does not focus a button.
                await opener.focus();
                await expect(opener).toBeFocused();
                await opener.press('Enter');
                const dialog = page.getByRole('dialog', { name: 'Forecast model', exact: true });
                await expect(dialog).toBeVisible();
                await dialog.evaluate(async (element) => {
                    await Promise.all(
                        element
                            .getAnimations({ subtree: true })
                            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
                            .map((animation) => animation.finished),
                    );
                });
                const local = dialog.getByRole('button', { name: 'Use the Best local forecast model', exact: true });
                await expect(local).toHaveAttribute('aria-pressed', 'true');
                await reachable(local, width);
                await expect(dialog.getByTestId('forecast-credit')).toContainText(
                    state === 'native'
                        ? 'Météo-France AROME-OM · Etalab-2.0'
                        : 'Local unavailable. Forecast: DWD ICON · CC BY 4.0',
                );
                await expect(
                    dialog.getByText(
                        state === 'native'
                            ? /The forecast ends 48 hours after/
                            : /Local source unavailable; showing ICON/,
                    ),
                ).toBeVisible();
                const details = dialog.getByText('Data sources', { exact: true });
                await reachable(details, width);
                await details.click();
                if (state === 'native') {
                    await expect(dialog.getByTestId('regional-source-credit')).toContainText(
                        'Météo-France AROME New Caledonia / Vanuatu · Etalab-2.0',
                    );
                    await expect(dialog.getByTestId('regional-source-credit')).toContainText(
                        'UV/visibility: independent forecast',
                    );
                }
                const licence =
                    state === 'native'
                        ? dialog.getByRole('link', { name: /AROME-OM.*Etalab-2.0/ })
                        : dialog.getByRole('link', { name: /^Marine: Météo-France/ });
                if (state === 'native')
                    await expect(licence).toHaveAttribute(
                        'href',
                        'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
                    );
                else await expect(dialog.getByRole('link', { name: /AROME-OM.*Etalab-2.0/ })).toHaveCount(0);
                await reachable(licence, width);
                await page.screenshot({ path: info.outputPath(`${state}-expanded.png`), animations: 'disabled' });
                const close = dialog.getByRole('button', { name: 'Close', exact: true });
                await reachable(close, width);
                expect(
                    await page.evaluate(() => ({
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    })),
                ).toEqual(pageBounds);
                expect(pageBounds).toEqual({ width, height: 667 });
                await close.click();
                await expect(dialog).toHaveCount(0);
                await expect(opener).toBeFocused();
                await opener.click();
                await local.click();
                await expect(page.getByRole('status', { name: 'Selected model' })).toHaveText('best_local');
                await opener.click();
                const manual = page.getByRole('button', { name: 'Use the ICON forecast model', exact: true });
                await reachable(manual, width);
                await manual.click();
                await expect(page.getByRole('status', { name: 'Selected model' })).toHaveText('dwd_icon');
            }
            expect(errors).toEqual([]);
        });
