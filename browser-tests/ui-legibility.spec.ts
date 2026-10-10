import { expect, test, type Locator, type Page } from '@playwright/test';

/** Measure settled colors while leaving infinite decorative animations running. */
async function settleFiniteAnimations(page: Page) {
    await page.evaluate(async () => {
        for (;;) {
            // Flush the theme/hover style update before collecting transitions.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const animations = document.getAnimations().filter((animation) => {
                const endTime = animation.effect?.getComputedTiming().endTime;
                return (
                    (animation.playState === 'running' || animation.pending) &&
                    typeof endTime === 'number' &&
                    Number.isFinite(endTime)
                );
            });
            if (animations.length === 0) return;
            // A replacement transition can cancel its predecessor. Recheck on
            // the next frame so cancellation cannot expose an intermediate color.
            await Promise.allSettled(animations.map((animation) => animation.finished));
        }
    });
}

/** Resolve real browser colors, translucent cards, ancestor opacity and the night scrim. */
function measureContrast(elements: Element[]) {
    type RGBA = [number, number, number, number];
    const parser = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string): RGBA => {
        parser.clearRect(0, 0, 1, 1);
        parser.fillStyle = color;
        parser.fillRect(0, 0, 1, 1);
        const pixel = parser.getImageData(0, 0, 1, 1).data;
        return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    };
    const over = (front: RGBA, back: RGBA): RGBA => {
        const alpha = front[3] + back[3] * (1 - front[3]);
        if (!alpha) return [0, 0, 0, 0];
        return [
            ...[0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha),
            alpha,
        ] as RGBA;
    };
    const luminance = (pixel: RGBA) =>
        pixel
            .slice(0, 3)
            .map((value) => value / 255)
            .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
            .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const scrim = document.querySelector('[data-testid="night-scrim"]');
    const scrimColor: RGBA = scrim ? rgba(getComputedStyle(scrim).backgroundColor) : [0, 0, 0, 0];
    return elements.map((element) => {
        const ink = rgba(getComputedStyle(element).color);
        const compose = (initial: RGBA) => {
            let pixel = initial;
            for (let node: Element | null = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.backgroundImage !== 'none') throw new Error('Text must not depend on a gradient fill');
                pixel = over(pixel, rgba(style.backgroundColor));
                pixel[3] *= Number(style.opacity);
            }
            return over(scrimColor, over(pixel, [255, 255, 255, 1]));
        };
        const foreground = compose(ink);
        const background = compose([0, 0, 0, 0]);
        const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return {
            label: element.textContent?.trim(),
            ratio: (lighter + 0.05) / (darker + 0.05),
            ink,
            foreground,
            background,
        };
    });
}

async function expectReadable(locator: Locator, state: string) {
    expect(await locator.count()).toBeGreaterThan(0);
    for (const result of await locator.evaluateAll(measureContrast)) {
        expect(result.ratio, `${state}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(4.5);
        expect(result.ink[3], `${state}: ${result.label} must use solid text`).toBe(1);
    }
}

/** Only the shared primary and confirmation actions' two-stop gradients are eligible here. */
function measureActionGradient(elements: Element[]) {
    type RGBA = [number, number, number, number];
    const parser = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string): RGBA => {
        if (!window.CSS.supports('color', color)) throw new Error(`Invalid gradient color: ${color}`);
        parser.clearRect(0, 0, 1, 1);
        parser.fillStyle = color;
        parser.fillRect(0, 0, 1, 1);
        const pixel = parser.getImageData(0, 0, 1, 1).data;
        return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
    };
    const over = (front: RGBA, back: RGBA): RGBA => {
        const alpha = front[3] + back[3] * (1 - front[3]);
        if (!alpha) return [0, 0, 0, 0];
        return [
            ...[0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha),
            alpha,
        ] as RGBA;
    };
    const luminance = (pixel: RGBA) =>
        pixel
            .slice(0, 3)
            .map((value) => value / 255)
            .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
            .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const scrim = document.querySelector('[data-testid="night-scrim"]');
    const scrimColor: RGBA = scrim ? rgba(getComputedStyle(scrim).backgroundColor) : [0, 0, 0, 0];
    return elements.flatMap((element) => {
        const actionStyle = getComputedStyle(element);
        if (
            !element.matches('button.ui-confirm-action, button.ui-primary-action') ||
            !actionStyle.backgroundImage.startsWith('linear-gradient(') ||
            actionStyle.getPropertyValue('--tw-gradient-via-stops').trim()
        ) {
            throw new Error('Expected a shared primary or confirmation action with two gradient endpoints');
        }
        const ink = rgba(actionStyle.color);
        return ['--tw-gradient-from', '--tw-gradient-to'].map((stop) => {
            const endpoint = rgba(actionStyle.getPropertyValue(stop).trim());
            const compose = (initial: RGBA) => {
                let pixel = initial;
                for (let node: Element | null = element; node; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    if (node === element) pixel = over(pixel, endpoint);
                    else if (style.backgroundImage !== 'none') throw new Error('Unexpected ancestor gradient');
                    pixel = over(pixel, rgba(style.backgroundColor));
                    pixel[3] *= Number(style.opacity);
                }
                return over(scrimColor, over(pixel, [255, 255, 255, 1]));
            };
            const foreground = compose(ink);
            const background = compose([0, 0, 0, 0]);
            const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return {
                stop,
                ratio: (lighter + 0.05) / (darker + 0.05),
                ink,
                endpoint,
                endpointLuminance: luminance(endpoint),
                foreground,
                background,
            };
        });
    });
}

async function expectActionGradientReadable(locator: Locator, state: string) {
    const measurements = await locator.evaluateAll(measureActionGradient);
    expect(measurements).toHaveLength(2);
    for (const result of measurements) {
        // With opaque dark stops and solid white ink, the brighter endpoint
        // bounds the minimum contrast of this same-hue action gradient.
        expect(result.ink, `${state}: solid white action text`).toEqual([255, 255, 255, 1]);
        expect(result.endpoint[3], `${state}: opaque ${result.stop}`).toBe(1);
        expect(result.endpointLuminance, `${state}: dark ${result.stop}`).toBeLessThanOrEqual(0.18);
        expect(result.ratio, `${state}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(4.5);
    }
}

async function expectUnclipped(locator: Locator) {
    const overflow = await locator.evaluateAll((elements) =>
        elements.flatMap((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const fragments = [...range.getClientRects()];
            for (let node: Element | null = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                const constrained =
                    node.hasAttribute('data-testid') ||
                    node.hasAttribute('data-modal-sheet') ||
                    node.hasAttribute('data-pane-dialog-panel') ||
                    ['hidden', 'clip', 'auto'].includes(style.overflowX);
                if (!constrained) continue;
                const box = node.getBoundingClientRect();
                for (const text of fragments) {
                    if (
                        text.left < box.left - 1 ||
                        text.right > box.right + 1 ||
                        (style.overflowY === 'hidden' && (text.top < box.top - 1 || text.bottom > box.bottom + 1))
                    ) {
                        return [{ label: element.textContent, text: text.toJSON(), box: box.toJSON() }];
                    }
                }
            }
            return [];
        }),
    );
    expect(overflow).toEqual([]);
}

async function expectTypography(page: Page) {
    const measurements = await page.evaluate(
        (roles) =>
            roles.flatMap(([selector, fontSize, fontWeight]) =>
                [...document.querySelectorAll(selector)].map((element) => {
                    const style = getComputedStyle(element);
                    return {
                        label: element.textContent,
                        expected: { fontSize, fontWeight },
                        actual: { fontSize: style.fontSize, fontWeight: style.fontWeight },
                    };
                }),
            ),
        [
            ['.ui-page-title', '20px', '800'],
            ['.ui-dialog-title', '18px', '800'],
            ['.ui-section-heading', '13px', '700'],
            ['.ui-field-label', '13px', '700'],
            ['.ui-caption', '12px', '500'],
            ['.ui-error-caption', '12px', '500'],
        ],
    );
    for (const { label, expected, actual } of measurements) {
        expect(actual, label ?? 'Text role typography').toEqual(expected);
    }
}

for (const width of [320, 390, 669]) {
    test(`shared UI remains uniform and readable at ${width}px across display and environment themes`, async ({
        page,
    }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width, height: 1100 });
        const unexpectedRequests: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === 'http://127.0.0.1:4199' && !url.pathname.startsWith('/api/')) return route.continue();
            unexpectedRequests.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/ui-legibility.html');
        const background = page.getByTestId('ui-background');
        const labels = page.locator(
            '[data-testid="ui-pane"] .ui-page-title, [data-testid="ui-pane"] .ui-section-heading, ' +
                '[data-testid="ui-pane"] .ui-field-label, [data-testid="ui-pane"] .ui-caption, ' +
                '[data-testid="form-card"] [role="alert"], [data-testid="warning-caption"]',
        );
        await expect(page.getByRole('heading', { name: 'Vessel details' })).toHaveClass(/ui-page-title/);
        await expect(page.getByRole('heading', { name: 'Safety reminders' })).toHaveClass(/ui-section-heading/);
        await expect(page.getByTestId('form-card').locator('label')).toHaveCount(4);
        await expect(page.getByTestId('form-card').locator('label.ui-field-label')).toHaveCount(4);
        await expect(page.getByTestId('ui-pane').locator('.ui-caption')).toHaveCount(3);
        await expect(page.getByRole('alert')).toHaveClass(/ui-error-caption/);

        for (const environment of ['offshore', 'onshore'] as const) {
            if (environment === 'onshore') await page.getByRole('button', { name: 'Toggle environment' }).click();
            await expect(background).toHaveAttribute('data-environment', environment);

            for (const mode of ['light', 'dark', 'night'] as const) {
                const state = `${width}px ${environment} ${mode}`;
                await page.getByRole('button', { name: mode, exact: true }).click();
                await expect(background).toHaveAttribute('data-mode', mode);
                await settleFiniteAnimations(page);
                await expect(page.getByTestId('ui-pane')).toHaveCSS('width', `${width}px`);
                await expect(page.getByRole('heading', { name: 'Safety reminders' }).locator('..')).toHaveCSS(
                    'opacity',
                    '1',
                );
                await expectTypography(page);
                await expectReadable(labels, state);
                await expectReadable(page.getByTestId('form-card').locator('input:not(:disabled)'), `${state} values`);
                await expectUnclipped(labels);
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

                // Disabled controls retain their native state and intentional
                // opacity; readable labels must not globally brighten them.
                const disabledField = page.getByRole('textbox', { name: 'Assigned berth' });
                await expect(disabledField).toBeDisabled();
                await expect(disabledField).toHaveCSS('opacity', '0.5');
                await expect(page.getByTestId('disabled-save')).toBeDisabled();
                await expect(page.getByTestId('disabled-save')).toHaveCSS('opacity', '0.4');
                const errorField = page.getByRole('textbox', { name: 'Emergency contact' });
                await expect(errorField).toHaveAttribute('aria-invalid', 'true');
                await expect(errorField).toHaveAccessibleDescription('Add a contact before departure.');
                await expect(
                    page.getByRole('textbox', { name: 'Registration', exact: true }),
                ).toHaveAccessibleDescription('Use the number on your certificate.');
                await expect(page.getByText('This hint must yield to the error.')).toHaveCount(0);
                const semantics = await page
                    .locator('[role="alert"], [data-testid="warning-heading"], [data-testid="warning-caption"]')
                    .evaluateAll(measureContrast);
                for (const { ink } of semantics) {
                    expect(ink[0]).toBeGreaterThan(ink[1]);
                    expect(ink[0]).toBeGreaterThan(ink[2]);
                }
                const sectionInk = (
                    await page.getByRole('heading', { name: 'Safety reminders' }).evaluateAll(measureContrast)
                )[0].ink;
                expect(sectionInk[2], `${state}: settings heading keeps its blue accent`).toBeGreaterThan(
                    sectionInk[0],
                );

                const dangerHover = page.getByTestId('danger-hover');
                const accentHover = page.getByTestId('accent-hover');
                const filledAction = page.getByTestId('filled-action');
                const primaryAction = page.getByTestId('primary-action');
                await expectReadable(dangerHover, `${state} neutral action`);
                await expectReadable(accentHover.locator('span'), `${state} neutral grouped action`);
                await expect(filledAction).toBeEnabled();
                await expect(filledAction).toHaveCSS('color', 'rgb(255, 255, 255)');
                await expectReadable(filledAction, `${state} filled action`);
                await expect(primaryAction).toBeEnabled();
                // One primary in both environments (UX scorecard run 7).
                await expect(primaryAction).toHaveClass(/ui-primary-action--sky/);
                await expectActionGradientReadable(primaryAction, `${state} primary action`);
                if (await page.evaluate(() => window.matchMedia('(hover: hover)').matches)) {
                    const neutralInk = await dangerHover.evaluate((element) => getComputedStyle(element).color);
                    await dangerHover.hover();
                    await settleFiniteAnimations(page);
                    await expect(dangerHover).not.toHaveCSS('color', neutralInk);
                    await expectReadable(dangerHover, `${state} danger hover`);
                    const dangerInk = (await dangerHover.evaluateAll(measureContrast))[0].ink;
                    expect(dangerInk[0]).toBeGreaterThan(dangerInk[1]);
                    expect(dangerInk[0]).toBeGreaterThan(dangerInk[2]);
                    await accentHover.hover();
                    await settleFiniteAnimations(page);
                    await expect(dangerHover).toHaveCSS('color', neutralInk);
                    const accentCaption = accentHover.locator('span');
                    await expect(accentCaption).not.toHaveCSS('color', neutralInk);
                    await expectReadable(accentCaption, `${state} grouped accent hover`);
                    const accentInk = (await accentCaption.evaluateAll(measureContrast))[0].ink;
                    expect(accentInk[2]).toBeGreaterThan(accentInk[0]);
                    await filledAction.hover();
                    await settleFiniteAnimations(page);
                    await expect(filledAction).toHaveCSS('color', 'rgb(255, 255, 255)');
                    await expectReadable(filledAction, `${state} filled action hover`);
                    await expect(accentCaption).toHaveCSS('color', neutralInk);
                    const primaryNormalStop = await primaryAction.evaluate((element) =>
                        getComputedStyle(element).getPropertyValue('--tw-gradient-from'),
                    );
                    await primaryAction.hover();
                    await settleFiniteAnimations(page);
                    await expect(primaryAction).not.toHaveCSS('--tw-gradient-from', primaryNormalStop);
                    await expectActionGradientReadable(primaryAction, `${state} primary action hover`);
                }

                await page.getByRole('button', { name: 'Open details', exact: true }).click();
                const sheet = page.getByRole('dialog', { name: 'Equipment details' });
                await expect(sheet).toBeVisible();
                await settleFiniteAnimations(page);
                await expect(sheet.locator('[data-modal-sheet]')).toHaveCSS('opacity', '1');
                await expect(sheet.getByRole('heading')).toHaveClass(/ui-dialog-title/);
                const sheetLabels = sheet.locator('.ui-dialog-title, .ui-field-label, .ui-caption');
                await expect(sheetLabels).toHaveCount(3);
                await expectTypography(page);
                await expectReadable(sheetLabels, `${state} modal sheet`);
                await expectUnclipped(sheetLabels);
                await sheet.getByRole('button', { name: 'Close', exact: true }).click();
                await expect(sheet).toHaveCount(0);

                await page.getByRole('button', { name: 'Open confirmation', exact: true }).click();
                const confirmation = page.getByRole('dialog', { name: 'Remove reminder?' });
                await expect(confirmation).toBeVisible();
                await settleFiniteAnimations(page);
                await expect(confirmation.locator('[data-pane-dialog-panel]')).toHaveCSS('opacity', '1');
                await expect(confirmation.getByRole('heading')).toHaveClass(/ui-dialog-title/);
                const confirmLabels = confirmation.locator('.ui-dialog-title, p');
                await expectTypography(page);
                await expectReadable(confirmLabels, `${state} confirmation`);
                await expectUnclipped(confirmLabels);
                const remove = confirmation.getByRole('button', { name: 'Remove', exact: true });
                await expect(remove).toHaveClass(/from-red-600/);
                await expectActionGradientReadable(remove, `${state} remove action`);
                if (await page.evaluate(() => window.matchMedia('(hover: hover)').matches)) {
                    const normalStop = await remove.evaluate((element) =>
                        getComputedStyle(element).getPropertyValue('--tw-gradient-from'),
                    );
                    await remove.hover();
                    await settleFiniteAnimations(page);
                    await expect(remove).not.toHaveCSS('--tw-gradient-from', normalStop);
                    await expectActionGradientReadable(remove, `${state} remove action hover`);
                }
                await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
                await expect(confirmation).toHaveCount(0);
            }
        }

        // Returning from warm night mode must update the same mounted fields.
        await page.getByRole('button', { name: 'light', exact: true }).click();
        await page.getByRole('textbox', { name: 'Vessel name' }).fill('Seabird');
        await expect(page.getByRole('textbox', { name: 'Vessel name' })).toHaveValue('Seabird');
        await settleFiniteAnimations(page);
        await expectReadable(labels, `${width}px onshore light restored`);
        expect(unexpectedRequests).toEqual([]);
    });
}

/**
 * R&M's delete question and service sheet (126-B7a) on the smallest phones,
 * with wide fonts (Verdana on a Mac measures like CI's DejaVu Sans). Both are
 * centred overlays above the app's chrome: what must hold is that every
 * choice is in view without scrolling, and that the card sits clear of the
 * tab bar (4rem; these phones have no bottom safe area).
 */
/** The tab bar is 4rem (h-16), and the root size scales with phone width: 52 px at 320. */
const tabBarPx = (page: Page) =>
    page.evaluate(() => 4 * parseFloat(getComputedStyle(document.documentElement).fontSize));

async function openWithWideFonts(page: Page, width: number, height: number, open: string) {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    await page.goto(`/e2e/fixtures/ui-legibility.html?open=${open}`);
}

/** The card is centred in the screen above the tab bar, and nothing inside it needs a scroll. */
async function expectCentredAboveTabBar(card: Locator, width: number, height: number) {
    const tabBarTop = height - (await tabBarPx(card.page()));
    const box = (await card.boundingBox())!;
    expect(box.y, 'card top on screen').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, 'card bottom clear of the tab bar').toBeLessThanOrEqual(tabBarTop);
    expect(Math.abs(box.x - (width - box.x - box.width)), 'centred across').toBeLessThanOrEqual(1);
    // Centred in the space above the tab bar, not over it (the card's own
    // 1rem margin above, and 1rem over the bar below).
    expect(Math.abs(box.y + box.height / 2 - tabBarTop / 2), 'centred above the tab bar').toBeLessThanOrEqual(2);
    expect(
        await card.evaluate((element) => element.scrollHeight - element.clientHeight),
        'nothing scrolled out of view',
    ).toBeLessThanOrEqual(0);
}

async function expectInViewAboveTabBar(button: Locator, height: number) {
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = (await button.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height - (await tabBarPx(button.page())));
    expect(box.height).toBeGreaterThanOrEqual(43.5);
}

for (const [width, height] of [
    [320, 568],
    [375, 667],
] as const) {
    test(`R&M's delete question shows all three choices, centred above the tab bar, at ${width}x${height}`, async ({
        page,
    }) => {
        await openWithWideFonts(page, width, height, 'delete-ask');
        const dialog = page.getByRole('dialog', { name: 'Delete “Raw-water impeller and strainer, port engine”?' });
        await expect(dialog).toBeVisible();
        await settleFiniteAnimations(page);
        const card = dialog.locator('[data-pane-dialog-panel]');
        await expect(card).toHaveCSS('opacity', '1');
        await expectCentredAboveTabBar(card, width, height);
        for (const name of ['Pause instead', 'Keep', 'Delete task and records']) {
            await expectInViewAboveTabBar(dialog.getByRole('button', { name, exact: true }), height);
        }
        await expectUnclipped(dialog.locator('.ui-dialog-title, p, button'));
        await expect(dialog.getByRole('button', { name: 'Keep', exact: true })).toBeFocused();
        // Pause instead is the prominent, readable primary.
        await expectActionGradientReadable(
            dialog.getByRole('button', { name: 'Pause instead', exact: true }),
            `${width}px pause instead`,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
}

for (const state of ['active', 'paused'] as const) {
    test(`R&M's ${state} service sheet at 320x568: one-line secondary buttons, the primary in view`, async ({
        page,
    }) => {
        await openWithWideFonts(page, 320, 568, `service-${state}`);
        const sheet = page.getByRole('dialog', { name: 'Raw-water impeller and strainer, port engine' });
        await expect(sheet).toBeVisible();
        await settleFiniteAnimations(page);
        await expectCentredAboveTabBar(sheet, 320, 568);

        const secondary = state === 'active' ? ['History', 'Edit task', 'Pause'] : ['History', 'Edit task'];
        for (const name of secondary) {
            const button = sheet.getByRole('button', { name, exact: true });
            await expectInViewAboveTabBar(button, 568);
            // One line, and the whole label inside its button.
            const fit = await button.evaluate((element) => {
                const tops = new Set<number>();
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const rect of range.getClientRects()) if (rect.height > 0) tops.add(Math.round(rect.top));
                }
                return { lines: tops.size, overflow: element.scrollWidth - element.clientWidth };
            });
            expect(fit, name).toEqual({ lines: 1, overflow: 0 });
        }
        await expect(sheet.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(state === 'active' ? 1 : 0);
        await expectInViewAboveTabBar(
            sheet.getByRole('button', { name: state === 'active' ? 'Log service' : 'Resume', exact: true }),
            568,
        );
        await expect(sheet.getByRole('button', { name: state === 'active' ? 'Resume' : 'Log service' })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    });
}
