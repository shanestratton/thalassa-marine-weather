import { expect, test, type Locator, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

// The production page, GPS adapter, navigation and pane portals stay real.
// Only persisted test data and browser GPS are supplied; external I/O is blocked.
test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

interface RadioViewport {
    width: number;
    height: number;
    split: boolean;
    displayMode: 'dark' | 'light' | 'night';
}

interface RadioGpsControl {
    latitude: number;
    longitude: number;
}

async function openRadio(page: Page, baseURL: string, viewport: RadioViewport, vesselName = 'Northern Surveyor') {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
    await page.addInitScript(
        ({ split, displayMode, vesselName }: RadioViewport & { vesselName: string }) => {
            localStorage.setItem('thalassa_split_view', split ? '1' : '0');
            localStorage.removeItem('thalassa_weather_last_boat_fix::anonymous');
            localStorage.removeItem('thalassa_dsc_intent::anonymous');
            for (const key of [
                'thalassa_glass_tutorial_seen',
                'thalassa_tutorial_completed',
                'thalassa_onboarding_complete',
            ]) {
                localStorage.setItem(`${key}::anonymous`, 'true');
            }
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.defaultLocation = 'Current Location';
                delete saved.settings.defaultLocationCoords;
                saved.settings.displayMode = displayMode;
                saved.settings.vessel = {
                    ...saved.settings.vessel,
                    name: vesselName,
                    type: 'sail',
                    callSign: 'VHZ1234',
                    mmsi: '503123456',
                    crewCount: 4,
                };
                localStorage.setItem(key, JSON.stringify(saved));
            }
            const key = 'thalassa_weather_cache_v9::anonymous';
            const weather = JSON.parse(localStorage.getItem(key)!);
            weather.generatedAt = new Date().toISOString();
            // Match the real first phone fix so the separate Glass pane can use
            // its fresh cache without attempting blocked live weather providers.
            weather.locationName = 'Moreton Bay, QLD';
            weather.coordinates = { lat: -27.5, lon: 153.5 };
            localStorage.setItem(key, JSON.stringify(weather));

            Object.defineProperty(navigator, 'permissions', {
                configurable: true,
                value: {
                    query: async () => ({
                        state: 'granted',
                        onchange: null,
                        addEventListener() {},
                        removeEventListener() {},
                        dispatchEvent: () => true,
                    }),
                },
            });
            const gps: RadioGpsControl = { latitude: -27.5, longitude: 153.5 };
            (window as unknown as { __radioGps: RadioGpsControl }).__radioGps = gps;
            const readPosition = (success: PositionCallback) => {
                queueMicrotask(() =>
                    success({
                        coords: {
                            latitude: gps.latitude,
                            longitude: gps.longitude,
                            accuracy: 5,
                            altitude: null,
                            altitudeAccuracy: null,
                            heading: 45,
                            speed: 2,
                            toJSON: () => ({}),
                        },
                        timestamp: Date.now(),
                        toJSON: () => ({}),
                    }),
                );
            };
            let watchId = 0;
            Object.defineProperty(navigator, 'geolocation', {
                configurable: true,
                value: {
                    getCurrentPosition: readPosition,
                    watchPosition: (success: PositionCallback) => {
                        readPosition(success);
                        return ++watchId;
                    },
                    clearWatch: () => undefined,
                },
            });
        },
        { ...viewport, vesselName },
    );
    await page.goto('/');
    await page.getByRole('tab', { name: 'Navigate to Vessel', exact: true }).click();
    await page.getByRole('button', { name: 'Open radio position reporting', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'VHF instructions', exact: true })).toBeVisible();
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
    await expect
        .poll(() =>
            page.getByTestId('radio-console-page').evaluate((element) => {
                for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
                    if (ancestor.getAnimations().some((animation) => animation.playState === 'running')) return false;
                }
                return true;
            }),
        )
        .toBe(true);
}

async function selectorGeometry(surface: Locator) {
    return surface
        .getByTestId('radio-call-selector')
        .locator('button')
        .evaluateAll((buttons) =>
            buttons.map((button) => {
                const { x, y, width, height } = button.getBoundingClientRect();
                return { x, y, width, height };
            }),
        );
}

async function expectStableSelectors(
    page: Page,
    surface: Locator,
    baseline: Awaited<ReturnType<typeof selectorGeometry>>,
) {
    // Only the current screen's selector is exposed to assistive technology.
    await expect(page.getByRole('group', { name: 'Call type', exact: true })).toHaveCount(1);
    const selector = surface.getByRole('group', { name: 'Call type', exact: true });
    await expect(selector).toBeInViewport();
    await expect(selector.getByRole('button')).toHaveCount(3);
    await expect
        .poll(async () => {
            const current = await selectorGeometry(surface);
            return (
                current.length === baseline.length &&
                current.every((rect, index) =>
                    (['x', 'y', 'width', 'height'] as const).every(
                        (key) => Math.abs(rect[key] - baseline[index][key]) <= 1,
                    ),
                )
            );
        })
        .toBe(true);
    for (const button of await selector.getByRole('button').all()) {
        await expect(button).toBeInViewport();
        expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
}

test('Very long radio identities remain readable through the final Over with Close pinned', async ({
    page,
    baseURL,
}, testInfo) => {
    const vesselName = 'Northern Surveyor of the Southern Ocean Research and Marine Conservation Expedition '
        .repeat(10)
        .trim();
    await openRadio(page, baseURL!, { width: 390, height: 844, split: false, displayMode: 'dark' }, vesselName);
    const instructions = page.getByRole('dialog', { name: 'VHF instructions', exact: true });
    const selectorBaseline = await selectorGeometry(page.getByTestId('radio-console-page'));
    await expectStableSelectors(page, instructions, selectorBaseline);
    await instructions.getByRole('button', { name: /^Distress/ }).click();
    await instructions.getByRole('combobox').selectOption('fire');
    await expect(instructions.getByTestId('radio-position-status')).toContainText('27°30.000′S');
    await instructions
        .getByRole('checkbox', { name: 'Confirm position receiver is aboard this vessel', exact: true })
        .check();
    await instructions.getByRole('button', { name: 'Continue to voice transcript', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Voice transcript', exact: true });
    const body = dialog.getByTestId('radio-transcript-body');
    const transcript = dialog.getByTestId('dsc-transcript');
    const close = dialog.getByRole('button', { name: 'Close voice transcript', exact: true });
    await expectDialogFrame(page, dialog, false);
    await expect(dialog.getByRole('note')).toHaveText(
        'Long message — scroll within the transcript to read every word.',
    );
    await expect(transcript).toContainText(vesselName);
    await expect(transcript).toHaveText(/4 persons on board\. Requesting immediate assistance\. Over\.$/);
    const before = await transcriptGeometry(body);
    expect(before.fontSize).toBeGreaterThanOrEqual(14);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
    expect(before.scrollWidth).toBeLessThanOrEqual(before.clientWidth + 1);
    const closeBefore = await close.boundingBox();
    await expect(close).toBeInViewport();
    await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect
        .poll(async () =>
            body.evaluate((element) => {
                const text = element.querySelector<HTMLElement>('[data-testid="dsc-transcript"]')!.firstChild!;
                const content = text.textContent!;
                const range = document.createRange();
                range.setStart(text, content.lastIndexOf('Over.'));
                range.setEnd(text, content.length);
                const ending = range.getBoundingClientRect();
                const visible = element.getBoundingClientRect();
                return ending.top >= visible.top && ending.bottom <= visible.bottom + 1;
            }),
        )
        .toBe(true);
    await expect(transcript).toHaveText(before.fullText!);
    await expect(close).toBeInViewport();
    expect(await close.boundingBox()).toEqual(closeBefore);
    await expectStableSelectors(page, dialog, selectorBaseline);
    await testInfo.attach('long-transcript-geometry', {
        body: JSON.stringify(before, null, 2),
        contentType: 'application/json',
    });
    await page.screenshot({
        path: testInfo.outputPath('long-transcript-ending.png'),
        fullPage: true,
        animations: 'disabled',
    });
    await close.click();
    await expect(dialog).toHaveCount(0);
});

test('Unconfirmed phone GPS never becomes vessel coordinates and does not block the voice call', async ({
    page,
    baseURL,
}, testInfo) => {
    await openRadio(page, baseURL!, { width: 390, height: 844, split: false, displayMode: 'dark' });
    const instructions = page.getByRole('dialog', { name: 'VHF instructions', exact: true });
    await instructions.getByRole('button', { name: /^Distress/ }).click();
    await instructions.getByRole('combobox').selectOption('fire');
    await expect(instructions.getByTestId('radio-position-status')).toContainText('27°30.000′S');
    await expect(
        instructions.getByRole('checkbox', { name: 'Confirm position receiver is aboard this vessel', exact: true }),
    ).not.toBeChecked();
    const proceed = instructions.getByRole('button', { name: 'Continue to voice transcript', exact: true });
    await expect(proceed).toBeEnabled();
    await proceed.click();

    const dialog = page.getByRole('dialog', { name: 'Voice transcript', exact: true });
    const transcript = dialog.getByTestId('dsc-transcript');
    await expect(transcript).toContainText(
        'Position not verified for this vessel. State your position from another reliable source, or your last known position and time.',
    );
    await expect(transcript).not.toContainText('2, 7, degrees. 3, 0, decimal, 0, minutes. South');
    await expect(transcript).not.toContainText(/this device['’]s GPS/);
    await expect(transcript).toHaveText(/4 persons on board\. Requesting immediate assistance\. Over\.$/);
    await expect
        .poll(async () => (await transcriptGeometry(dialog.getByTestId('radio-transcript-body'))).allLinesInside)
        .toBe(true);
    await page.screenshot({
        path: testInfo.outputPath('unconfirmed-phone-transcript.png'),
        fullPage: true,
        animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Close voice transcript', exact: true }).click();
    await expect(dialog).toHaveCount(0);
});

async function expectDialogFrame(page: Page, dialog: Locator, split: boolean) {
    const frame = split ? page.locator('[data-split-pane="page"]') : null;
    await expect
        .poll(async () => {
            const actual = await dialog.boundingBox();
            const target = frame ? await frame.boundingBox() : { x: 0, y: 0, ...page.viewportSize()! };
            if (!actual || !target) return false;
            return (
                Math.abs(actual.x - target.x) <= 2 &&
                Math.abs(actual.y - target.y) <= 2 &&
                Math.abs(actual.width - target.width) <= 2 &&
                Math.abs(actual.height - target.height) <= 2
            );
        })
        .toBe(true);
    if (frame) {
        await expect(frame).toHaveAttribute('inert');
        await expect(page.locator('[data-split-pane="glass"]')).not.toHaveAttribute('inert');
        expect(
            await dialog.evaluate((element) => element.closest('[data-pane-portal]')?.getAttribute('data-pane-portal')),
        ).toBe('page');
        await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    } else {
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true);
    }
}

async function transcriptGeometry(body: Locator) {
    return body.evaluate((element) => {
        const text = element.querySelector<HTMLElement>('[data-testid="dsc-transcript"]')!;
        const bounds = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            textHeight: text.getBoundingClientRect().height,
            spareHeight: element.clientHeight - text.getBoundingClientRect().height,
            fontSize: parseFloat(getComputedStyle(text).fontSize),
            fullText: text.textContent,
            allLinesInside: lines.every(
                (line) =>
                    line.x >= bounds.x - 1 &&
                    line.right <= bounds.right + 1 &&
                    line.y >= bounds.y - 1 &&
                    line.bottom <= bounds.bottom + 1,
            ),
        };
    });
}

const viewports: RadioViewport[] = [
    { width: 390, height: 844, split: false, displayMode: 'light' },
    { width: 430, height: 932, split: false, displayMode: 'dark' },
    // Reduced height also exercises native safe-area headroom without editing CSS.
    { width: 390, height: 784, split: false, displayMode: 'night' },
    { width: 1024, height: 768, split: true, displayMode: 'dark' },
];

for (const viewport of viewports) {
    test(`Radio instructions lead to a complete voice transcript at ${viewport.width}x${viewport.height}${viewport.split ? ' split' : ''}`, async ({
        page,
        baseURL,
    }, testInfo) => {
        test.setTimeout(90_000);
        await openRadio(page, baseURL!, viewport);
        const instructions = page.getByRole('dialog', { name: 'VHF instructions', exact: true });
        const transcriptDialog = page.getByRole('dialog', { name: 'Voice transcript', exact: true });
        const transcript = transcriptDialog.getByTestId('dsc-transcript');
        const close = transcriptDialog.getByRole('button', { name: 'Close voice transcript', exact: true });
        const consolePage = page.getByTestId('radio-console-page');
        const selectorBaseline = await selectorGeometry(consolePage);
        await expectStableSelectors(page, instructions, selectorBaseline);
        await instructions.getByRole('button', { name: 'Close vhf instructions', exact: true }).click();
        await expectStableSelectors(page, consolePage, selectorBaseline);
        const selectorBottom = selectorBaseline[0].y + selectorBaseline[0].height;
        expect(selectorBottom).toBeLessThan((await consolePage.getByTestId('radio-console-body').boundingBox())!.y);
        await page.screenshot({
            path: testInfo.outputPath('console-top-selectors.png'),
            fullPage: true,
            animations: 'disabled',
        });
        await consolePage.getByRole('button', { name: /^Routine/ }).click();

        for (const mode of ['routine', 'urgency', 'distress'] as const) {
            await test.step(mode, async () => {
                await expect(instructions).toBeVisible();
                await expect(transcriptDialog).toHaveCount(0);
                await expectDialogFrame(page, instructions, viewport.split);
                await instructions.getByRole('button', { name: new RegExp(`^${mode}`, 'i') }).click();
                await expectStableSelectors(page, instructions, selectorBaseline);
                if (mode !== 'routine') {
                    await instructions.getByRole('combobox').selectOption('fire');
                    await expect(instructions).toContainText('On your VHF');
                    await expect(instructions).toContainText('Channel 16');
                } else {
                    await expect(instructions.getByRole('list')).not.toContainText(/DSC Urgency|DISTRESS button/);
                }
                const proceed = instructions.getByRole('button', { name: 'Continue to voice transcript', exact: true });
                await expect(proceed).toBeInViewport();
                await expect(instructions.getByTestId('radio-position-status')).toContainText('27°30.000′S');
                await instructions
                    .getByRole('checkbox', { name: 'Confirm position receiver is aboard this vessel', exact: true })
                    .check();
                await instructions.getByText('VHF / HF channel reference', { exact: true }).click();
                await instructions.getByTestId('radio-instructions-body').evaluate((element) => {
                    element.scrollTop = element.scrollHeight;
                });
                await expectStableSelectors(page, instructions, selectorBaseline);
                await instructions.getByText('VHF / HF channel reference', { exact: true }).click();
                if (mode === 'distress') {
                    if (viewport.split) {
                        const glass = page.locator('[data-split-pane="glass"]');
                        await expect(glass.getByRole('button', { name: /Choose forecast model/ })).toBeVisible();
                        await expect(glass).not.toContainText('All weather APIs failed');
                    }
                    await page.screenshot({
                        path: testInfo.outputPath('vhf-instructions.png'),
                        fullPage: true,
                        animations: 'disabled',
                    });
                }
                await proceed.click();

                await expect(instructions).toHaveCount(0);
                await expect(transcriptDialog).toBeVisible();
                await expectDialogFrame(page, transcriptDialog, viewport.split);
                await expectStableSelectors(page, transcriptDialog, selectorBaseline);
                await expect(close).toBeInViewport();
                await expect(transcript).toContainText('Northern Surveyor');
                await expect(transcript).toContainText('Call sign. V, H, Z. 1, 2, 3, 4.');
                await expect(transcript).toContainText('5, 0, 3. 1, 2, 3. 4, 5, 6');
                await expect(transcript).toContainText('2, 7, degrees. 3, 0, decimal, 0, minutes. South');
                await expect(transcript).toContainText('1, 5, 3, degrees. 3, 0, decimal, 0, minutes. East');
                await expect(transcript).toContainText(/this device['’]s GPS/);
                await expect(transcript).not.toContainText('Current vessel position');
                if (mode === 'routine') {
                    await expect(transcript).toContainText('Course. 0, 4, 5, degrees true.');
                } else {
                    await expect(transcript).toContainText(
                        mode === 'urgency' ? 'Pan-Pan, Pan-Pan, Pan-Pan.' : 'Mayday, Mayday, Mayday.',
                    );
                    await expect(transcript).toContainText('fire on board');
                    await expect(transcript).toHaveText(
                        mode === 'urgency'
                            ? /Requesting assistance\. Over\.$/
                            : /4 persons on board\. Requesting immediate assistance\. Over\.$/,
                    );
                }
                const body = transcriptDialog.getByTestId('radio-transcript-body');
                await expect.poll(async () => (await transcriptGeometry(body)).allLinesInside).toBe(true);
                const geometry = await transcriptGeometry(body);
                expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
                expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
                expect(geometry.fontSize).toBeGreaterThanOrEqual(14);
                await testInfo.attach(`transcript-${mode}-geometry`, {
                    body: JSON.stringify(geometry, null, 2),
                    contentType: 'application/json',
                });

                if (mode === 'distress') {
                    await page.screenshot({
                        path: testInfo.outputPath('complete-mayday.png'),
                        fullPage: true,
                        animations: 'disabled',
                    });
                    if (viewport.split) {
                        const glass = page.locator('[data-split-pane="glass"]');
                        await glass.getByRole('button', { name: /Choose forecast model/ }).click();
                        const modelPicker = page.getByRole('dialog', { name: 'Choose a forecast model', exact: true });
                        await expect(modelPicker).toBeVisible();
                        await expect(transcript).toHaveText(geometry.fullText!);
                        await modelPicker.getByRole('button', { name: 'Close', exact: true }).click();
                        await expect(modelPicker).toHaveCount(0);
                        await expectDialogFrame(page, transcriptDialog, true);
                    }
                    // The source continues updating, but the written call
                    // cannot move underneath someone reading coordinates.
                    await page.evaluate(() => {
                        const gps = (window as unknown as { __radioGps: RadioGpsControl }).__radioGps;
                        gps.latitude = -27.6;
                        gps.longitude = 153.6;
                    });
                    await expect(page.getByTestId('radio-position-status')).toContainText('27°36.000′S');
                    await expect(transcript).toHaveText(geometry.fullText!);
                    await transcriptDialog.getByRole('button', { name: 'Update position', exact: true }).click();
                    await expect(transcript).toContainText('2, 7, degrees. 3, 6, decimal, 0, minutes. South');
                    await expect(transcript).toContainText('1, 5, 3, degrees. 3, 6, decimal, 0, minutes. East');
                    await expect.poll(async () => (await transcriptGeometry(body)).allLinesInside).toBe(true);
                }
                if (mode === 'urgency') {
                    await transcriptDialog.getByRole('button', { name: 'VHF instructions', exact: true }).click();
                    await expect(instructions).toBeVisible();
                    await expect(transcriptDialog).toHaveCount(0);
                    await expectStableSelectors(page, instructions, selectorBaseline);
                    await expect(instructions.getByRole('button', { name: /^Urgency/ })).toHaveAttribute(
                        'aria-pressed',
                        'true',
                    );
                    await proceed.click();
                    await expect(transcriptDialog).toBeVisible();
                }
                if (mode === 'routine') {
                    // A mode switch must not silently rewrite an active readback.
                    await transcriptDialog.getByRole('button', { name: /^Urgency/ }).click();
                    await expect(instructions).toBeVisible();
                    await expect(transcriptDialog).toHaveCount(0);
                    await expect(instructions.getByRole('button', { name: /^Urgency/ })).toHaveAttribute(
                        'aria-pressed',
                        'true',
                    );
                    await expectStableSelectors(page, instructions, selectorBaseline);
                    await proceed.click();
                    await expect(transcript).toContainText('Pan-Pan, Pan-Pan, Pan-Pan.');
                    await expectStableSelectors(page, transcriptDialog, selectorBaseline);
                }

                await close.click();
                await expect(transcriptDialog).toHaveCount(0);
                await expect(instructions).toHaveCount(0);
                await expectStableSelectors(page, consolePage, selectorBaseline);
                await consolePage.getByTestId('radio-console-body').evaluate((element) => {
                    element.scrollTop = element.scrollHeight;
                });
                await expectStableSelectors(page, consolePage, selectorBaseline);
                await consolePage.getByTestId('radio-console-body').evaluate((element) => {
                    element.scrollTop = 0;
                });
                if (viewport.split) await expect(page.locator('[data-split-pane="page"]')).not.toHaveAttribute('inert');
                const reopen = page.getByRole('button', { name: /^Prepare voice call/ });
                await expect(reopen).toBeInViewport();
                if (mode !== 'distress') await reopen.click();
            });
        }
        if (!viewport.split) {
            // Reflow the actual page/portal origins, then compare the new exact slot.
            await page.setViewportSize({ width: viewport.width === 390 ? 430 : 390, height: viewport.height });
            // Fluid root type changes the pills' rem padding. Chromium animates
            // that transition (59.625 -> 61.375px at 390 -> 430), so record the
            // settled base rather than a 1.75px-short mid-transition height.
            // Keep the strict 1px comparisons; do not disable app animations.
            await consolePage.getByTestId('radio-call-selector').evaluate(async (selector) => {
                await Promise.all(
                    selector
                        .getAnimations({ subtree: true })
                        .filter((animation) => animation.pending || animation.playState === 'running')
                        .map((animation) => animation.finished.catch(() => undefined)),
                );
            });
            const resizedBaseline = await selectorGeometry(consolePage);
            await consolePage.getByRole('button', { name: /^Distress/ }).click();
            await expectStableSelectors(page, instructions, resizedBaseline);
            await instructions.getByRole('button', { name: 'Continue to voice transcript', exact: true }).click();
            await expectStableSelectors(page, transcriptDialog, resizedBaseline);
            await close.click();
            await expectStableSelectors(page, consolePage, resizedBaseline);
        }
    });
}
