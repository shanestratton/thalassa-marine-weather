import { expect, test, type Locator, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

// Exercise the packaged Glass and its actual model sheet. Seed only normal
// persisted settings/weather; no application component or store is replaced.

type FooterScenario = {
    locationType: 'inshore' | 'offshore';
    displayMode: 'light' | 'dark';
    model: 'ecmwf_ifs025' | 'spitfire';
};

async function openGlass(page: Page, baseURL: string, width: number, scenario: FooterScenario) {
    await page.setViewportSize({ width, height: 844 });
    const origin = new URL(baseURL).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const staticRead =
            url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/functions/');
        return staticRead ? route.continue() : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(({ locationType, displayMode, model }: FooterScenario) => {
        localStorage.setItem('thalassa_split_view', '0');
        for (const key of [
            'thalassa_glass_tutorial_seen',
            'thalassa_tutorial_completed',
            'thalassa_onboarding_complete',
        ]) {
            localStorage.setItem(`${key}::anonymous`, 'true');
        }
        for (const key of ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous']) {
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.settings.defaultLocation = 'Newport QLD';
            saved.settings.defaultLocationCoords = { lat: -27.2, lon: 153.1 };
            saved.settings.displayMode = displayMode;
            saved.settings.forecastModel = model;
            // The legacy source has a longer, different name. It must never
            // leak into the location badge or duplicate the selected model.
            saved.settings.offshoreModel = 'gfs';
            localStorage.setItem(key, JSON.stringify(saved));
        }
        const key = 'thalassa_weather_cache_v9::anonymous';
        const weather = JSON.parse(localStorage.getItem(key)!);
        weather.generatedAt = new Date().toISOString();
        weather.locationName = 'Newport QLD';
        weather.coordinates = { lat: -27.2, lon: 153.1 };
        weather.locationType = locationType;
        weather.modelUsed = model === 'spitfire' ? 'SPITFIRE' : 'ECMWF';
        localStorage.setItem(key, JSON.stringify(weather));

        const denyPosition = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
            queueMicrotask(() =>
                error?.({
                    code: 1,
                    message: 'GPS disabled in footer layout regression',
                    PERMISSION_DENIED: 1,
                    POSITION_UNAVAILABLE: 2,
                    TIMEOUT: 3,
                }),
            );
        };
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: denyPosition,
                watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
                    denyPosition(success, error);
                    return 0;
                },
                clearWatch: () => undefined,
            },
        });
    }, scenario);
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Navigate to The Glass', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.getByRole('textbox', { name: 'Current location', exact: true })).toHaveValue('Newport QLD');
    if (scenario.displayMode === 'light') await expect(page.locator('html')).toHaveClass(/display-light/);
    else await expect(page.locator('html')).not.toHaveClass(/display-light/);
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
}

async function measureFooter(strip: Locator) {
    return strip.evaluate((element) => {
        const bounds = (node: Element) => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const children = Array.from(element.children).map((child) => {
            const textRects = [];
            const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                if (!walker.currentNode.textContent?.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(walker.currentNode);
                textRects.push(
                    ...Array.from(range.getClientRects()).map((rect) => ({
                        x: rect.x,
                        y: rect.y,
                        right: rect.right,
                        bottom: rect.bottom,
                        height: rect.height,
                    })),
                );
            }
            return {
                text: child.textContent,
                bounds: bounds(child),
                clientWidth: child.clientWidth,
                scrollWidth: child.scrollWidth,
                fontSize: parseFloat(getComputedStyle(child).fontSize),
                fontFamily: getComputedStyle(child).fontFamily,
                textRects,
            };
        });
        return {
            bounds: bounds(element),
            children,
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
    });
}

function expectOneUnclippedRow(layout: Awaited<ReturnType<typeof measureFooter>>) {
    expect(layout.children).toHaveLength(3);
    expect(layout.bounds.x).toBeGreaterThanOrEqual(0);
    expect(layout.bounds.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    for (const child of layout.children) {
        expect(child.bounds.width).toBeGreaterThan(0);
        expect(child.fontSize).toBeGreaterThanOrEqual(12);
        expect(child.bounds.x).toBeGreaterThanOrEqual(layout.bounds.x - 1);
        expect(child.bounds.right).toBeLessThanOrEqual(layout.bounds.right + 1);
        expect(child.scrollWidth).toBeLessThanOrEqual(child.clientWidth + 1);
        expect(
            Math.abs(child.bounds.y + child.bounds.height / 2 - (layout.bounds.y + layout.bounds.height / 2)),
        ).toBeLessThanOrEqual(1);
        expect(child.textRects.length).toBeGreaterThan(0);
        for (const rect of child.textRects) {
            expect(rect.x).toBeGreaterThanOrEqual(child.bounds.x - 1);
            expect(rect.right).toBeLessThanOrEqual(child.bounds.right + 1);
            expect(rect.y).toBeGreaterThanOrEqual(child.bounds.y - 1);
            expect(rect.bottom).toBeLessThanOrEqual(child.bounds.bottom + 1);
        }
        const textTop = Math.min(...child.textRects.map((rect) => rect.y));
        const textBottom = Math.max(...child.textRects.map((rect) => rect.bottom));
        const lineHeight = Math.max(...child.textRects.map((rect) => rect.height));
        expect(textBottom - textTop).toBeLessThanOrEqual(lineHeight + 1);
    }
    for (let index = 1; index < layout.children.length; index++) {
        expect(layout.children[index].bounds.x).toBeGreaterThanOrEqual(layout.children[index - 1].bounds.right);
    }
    expect(Math.abs(layout.children[0].bounds.width - layout.children[2].bounds.width)).toBeLessThanOrEqual(1);
    // The app scales rem with phone width (13–17px), so h-8 is two
    // rem rather than an absolute 32px on every device.
    for (const index of [0, 2]) {
        expect(layout.children[index].bounds.height).toBeCloseTo(2 * layout.rootFontSize, 0);
    }
}

for (const displayMode of ['light', 'dark'] as const) {
    for (const width of [320, 390, 430]) {
        test(`Glass footer stays one row inshore and offshore at ${width}px in ${displayMode} mode`, async ({
            browser,
            baseURL,
            isMobile,
            hasTouch,
            deviceScaleFactor,
            userAgent,
        }, testInfo) => {
            test.setTimeout(60_000);
            // The narrowest phone also exercises the longest model label.
            // Newport is within the real Spitfire catalogue, so it remains
            // selectable through the unmodified production model sheet.
            const forecastModel = width === 320 ? 'spitfire' : 'ecmwf_ifs025';
            const modelLabel = width === 320 ? 'SPITFIRE' : 'ECMWF';
            const layouts: Awaited<ReturnType<typeof measureFooter>>[] = [];
            for (const locationType of ['inshore', 'offshore'] as const) {
                await test.step(locationType, async () => {
                    // Capacitor migrates the localStorage cache into browser
                    // IndexedDB. Independent contexts keep that async cache
                    // from replacing the next scenario's seeded report.
                    const context = await browser.newContext({
                        baseURL,
                        isMobile,
                        hasTouch,
                        deviceScaleFactor,
                        userAgent,
                        serviceWorkers: 'block',
                        storageState: {
                            ...ONBOARDED_STORAGE,
                            origins: ONBOARDED_STORAGE.origins.map((origin) => ({
                                ...origin,
                                origin: new URL(baseURL!).origin,
                            })),
                        },
                    });
                    const page = await context.newPage();
                    try {
                        await openGlass(page, baseURL!, width, { locationType, displayMode, model: forecastModel });
                        const strip = page.getByTestId('glass-status-strip');
                        const label = locationType.toUpperCase();
                        const location = strip.getByRole('status', { name: /^Location type:/ });
                        const model = strip.getByRole('button', { name: /Choose forecast model/ });
                        await expect(strip).toBeInViewport();
                        await expect(location).toHaveText(label);
                        await expect(location).toHaveAccessibleName(`Location type: ${label}`);
                        await expect(model).toHaveText(modelLabel);
                        await expect(strip.getByText(modelLabel, { exact: true })).toHaveCount(1);
                        await expect(strip).not.toContainText(/GFS|NOAA|OFFSHORE\s*\(/);
                        const layout = await measureFooter(strip);
                        expectOneUnclippedRow(layout);
                        layouts.push(layout);

                        // Linux Chromium's platform font renders "just now"
                        // wider than the original 56px reserved age track.
                        // Reproduce that ordinary font-metric difference on
                        // every host without shrinking text or relaxing bounds.
                        const age = strip.getByRole('status', { name: /^Forecast updated/ });
                        await expect(age).toHaveText('just now');
                        await age.evaluate((element) => {
                            element.style.fontFamily = 'monospace';
                        });
                        const widerFontLayout = await measureFooter(strip);
                        const ageText = widerFontLayout.children[1].textRects[0];
                        expect(ageText.right - ageText.x).toBeGreaterThan(56);
                        await testInfo.attach(`footer-${locationType}-wider-age-font`, {
                            body: JSON.stringify(widerFontLayout, null, 2),
                            contentType: 'application/json',
                        });
                        expectOneUnclippedRow(widerFontLayout);
                        await age.evaluate((element) => {
                            element.style.removeProperty('font-family');
                        });

                        await model.click();
                        const picker = page.getByRole('dialog', { name: 'Choose a forecast model', exact: true });
                        await expect(picker).toBeVisible();
                        const currentModel = picker.getByRole('button', {
                            name: `Use the ${modelLabel === 'SPITFIRE' ? 'Spitfire' : modelLabel} forecast model`,
                            exact: true,
                        });
                        await expect(currentModel).toHaveAttribute('aria-current', 'true');
                        await currentModel.scrollIntoViewIfNeeded();
                        await expect(currentModel).toBeInViewport();
                        await expect(currentModel).toBeEnabled();
                        await picker.getByRole('button', { name: 'Close', exact: true }).click();
                        await expect(picker).toHaveCount(0);
                        await expect(strip).toBeInViewport();
                        await expect(model).toHaveText(modelLabel);

                        if (testInfo.project.name === 'mobile-safari' && width <= 390) {
                            await page.screenshot({
                                path: testInfo.outputPath(`footer-${locationType}-${displayMode}.png`),
                                fullPage: true,
                                animations: 'disabled',
                            });
                        }
                        if (locationType === 'offshore') {
                            // Keep the real selection/persistence interaction
                            // deterministic when providers are unavailable.
                            await context.setOffline(true);
                            await model.click();
                            await picker
                                .getByRole('button', { name: 'Use the ICON forecast model', exact: true })
                                .click();
                            await expect(picker).toHaveCount(0);
                            await expect(model).toHaveText('ICON');
                            await expect
                                .poll(() =>
                                    page.evaluate(() => {
                                        const saved = JSON.parse(
                                            localStorage.getItem('thalassa_settings_mirror::anonymous')!,
                                        );
                                        return saved.settings.forecastModel;
                                    }),
                                )
                                .toBe('dwd_icon');
                            expectOneUnclippedRow(await measureFooter(strip));
                        }
                    } catch (error) {
                        await page
                            .screenshot({
                                path: testInfo.outputPath(`footer-${locationType}-failure.png`),
                                fullPage: true,
                                animations: 'disabled',
                            })
                            .catch(() => undefined);
                        throw error;
                    } finally {
                        await context.close();
                    }
                });
            }
            const [inshore, offshore] = layouts;
            expect(Math.abs(offshore.bounds.height - inshore.bounds.height)).toBeLessThanOrEqual(1);
            for (const index of [0, 2]) {
                expect(
                    Math.abs(offshore.children[index].bounds.height - inshore.children[index].bounds.height),
                ).toBeLessThanOrEqual(1);
                expect(
                    Math.abs(offshore.children[index].bounds.width - inshore.children[index].bounds.width),
                ).toBeLessThanOrEqual(1);
            }
            await testInfo.attach('footer-layouts', {
                body: JSON.stringify({ width, displayMode, forecastModel, inshore, offshore }, null, 2),
                contentType: 'application/json',
            });
        });
    }
}
