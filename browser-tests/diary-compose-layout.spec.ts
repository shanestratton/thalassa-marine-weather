import { expect, test, type Locator, type Page } from '@playwright/test';

const SIZES = [
    { name: 'short phone', width: 390, height: 650, keyboard: 240 },
    { name: 'tall phone', width: 390, height: 844, keyboard: 344 },
    { name: 'small phone', width: 320, height: 568, keyboard: 220 },
    { name: 'tablet pane', width: 1024, height: 768, keyboard: 300, pane: true },
];

async function attachVideo(page: Page) {
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
        name: 'local-layout-preview.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('Local layout fixture only; no media upload or playback is required.'),
    });
    await expect(page.locator('video')).toHaveAttribute('src', /^blob:/);
}

async function geometry(field: Locator) {
    return field.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const scroller = element.closest('.overflow-auto')!;
        const panel = scroller.getBoundingClientRect();
        return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            contentTop: rect.top - panel.top + scroller.scrollTop,
            panelTop: panel.top,
            panelBottom: panel.bottom,
        };
    });
}

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
    // The real global guard has focus settling passes at 0, 120 and 360 ms.
    // Check after those passes, so a transient correct position cannot pass.
    await page.waitForTimeout(420);
}

async function bodyAboveFooter(page: Page, field: Locator, keyboardHeight: number) {
    await expect(field).toBeFocused();
    await expect
        .poll(async () => {
            const body = await geometry(field);
            const save = await page.getByRole('button', { name: 'Save changes' }).boundingBox();
            const footerTop = await page
                .getByRole('button', { name: 'Save changes' })
                .evaluate((button) => button.parentElement!.parentElement!.getBoundingClientRect().top);
            const keyboardTop = page.viewportSize()!.height - keyboardHeight;
            return (
                !!save &&
                body.top >= body.panelTop &&
                body.bottom <= body.panelBottom + 1 &&
                body.bottom <= footerTop + 1 &&
                save.y + save.height <= keyboardTop + 1 &&
                body.height > 40
            );
        })
        .toBe(true);
    await expect
        .poll(() =>
            field.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].every((y) => {
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
                    return hit === element || element.contains(hit);
                });
            }),
        )
        .toBe(true);
}

for (const size of SIZES) {
    test(`diary video leaves text in place and keyboard focus visible on ${size.name}`, async ({ page }) => {
        await page.route('**/*', (route) =>
            new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
        );
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/e2e/fixtures/diary-compose.html${size.pane ? '?pane=true' : ''}`);
        const body = page.getByRole('textbox', { name: 'Diary entry text', exact: true });
        await expect(body).toHaveValue(/We tucked into the bay/);
        const draft = await body.inputValue();
        const before = await geometry(body);

        await attachVideo(page);
        const after = await geometry(body);
        expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.contentTop - before.contentTop)).toBeLessThanOrEqual(1);
        const preview = await page.locator('video').boundingBox();
        expect(preview).not.toBeNull();
        expect(preview!.y).toBeGreaterThanOrEqual(after.bottom + 1);
        await expect(body).toHaveValue(draft);
        await page.screenshot({ path: test.info().outputPath('diary-video-attached.png') });

        const remove = page.getByRole('button', { name: 'Remove the video', exact: true });
        await remove.scrollIntoViewIfNeeded();
        await remove.click();
        await expect(page.locator('video')).toHaveCount(0);
        await expect(body).toHaveValue(draft);

        await attachVideo(page);
        await body.focus();
        await keyboard(page, size.keyboard - 80);
        await bodyAboveFooter(page, body, size.keyboard - 80);
        await body.fill(`${draft}\nA dolphin followed us into the anchorage.`);
        await keyboard(page, size.keyboard);
        await bodyAboveFooter(page, body, size.keyboard);
        await expect(body).toHaveValue(`${draft}\nA dolphin followed us into the anchorage.`);
        await page.screenshot({ path: test.info().outputPath('diary-video-keyboard.png') });

        await keyboard(page, 0);
        await body.evaluate((element) => (element as HTMLTextAreaElement).blur());
        await remove.scrollIntoViewIfNeeded();
        await remove.click();
        await expect(page.locator('video')).toHaveCount(0);
        await expect(body).toHaveValue(`${draft}\nA dolphin followed us into the anchorage.`);
        await expect
            .poll(() =>
                page.evaluate(() =>
                    [document.documentElement, document.body, document.getElementById('root')!].every(
                        (element) => element.scrollTop === 0,
                    ),
                ),
            )
            .toBe(true);
    });
}

// The new look (Shane 2026-10-06, "more in line with our new look"): the
// cards, the one-row mood selector and the six photo tiles keep 44 px targets
// and one row at 320, and the place and title fields, like the text, stay
// above the keyboard and the footer.
for (const size of SIZES.filter((s) => !s.pane)) {
    test(`diary place and title fields stay above the keyboard on ${size.name}`, async ({ page }) => {
        await page.route('**/*', (route) =>
            new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
        );
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/e2e/fixtures/diary-compose.html?scenario=new');
        for (const name of ['Where', 'Title']) {
            const field = page.getByRole('textbox', { name, exact: true });
            await field.focus();
            await keyboard(page, size.keyboard);
            await bodyAboveFooter(page, field, size.keyboard);
            await keyboard(page, 0);
            await field.evaluate((element) => (element as HTMLInputElement).blur());
        }
    });
}

test('diary new look: one mood row, six photo tiles and 44 px targets at 320', async ({ page }) => {
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/e2e/fixtures/diary-compose.html?scenario=new');
    await expect(page.getByRole('combobox', { name: 'Diary trip' })).toBeVisible();
    const layout = await page.evaluate(() => {
        const box = (el: Element) => el.getBoundingClientRect();
        const moods = [...document.querySelectorAll('[aria-label^="Set mood to"]')].map(box);
        const tiles = [...document.querySelectorAll('[aria-label^="Add diary photo"]')].map(box);
        const controls = [...document.querySelectorAll('button, select, input:not([type="file"]), textarea')].filter(
            (el) => getComputedStyle(el).opacity !== '0' || el.tagName === 'SELECT',
        );
        const save = box(document.querySelector('[aria-label="Save changes"]')!);
        const nav = box(document.querySelector('[data-testid="app-bottom-nav"]')!);
        return {
            moodTops: [...new Set(moods.map((b) => Math.round(b.top)))],
            moodMin: Math.min(...moods.map((b) => Math.min(b.width, b.height))),
            tileTops: [...new Set(tiles.map((b) => Math.round(b.top)))],
            tileMin: Math.min(...tiles.map((b) => Math.min(b.width, b.height))),
            tileCount: tiles.length,
            small: controls
                .map((el) => ({ name: el.getAttribute('aria-label') ?? el.getAttribute('placeholder'), b: box(el) }))
                .filter(({ b }) => b.height < 43.5)
                .map(({ name, b }) => `${name}: ${Math.round(b.width)}x${Math.round(b.height)}`),
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            saveClearOfNav: nav.top - save.bottom,
            moodLabels: [...document.querySelectorAll('[aria-label^="Set mood to"]')].map((b) => b.textContent),
        };
    });
    expect(layout.moodTops).toHaveLength(1);
    expect(layout.moodMin).toBeGreaterThanOrEqual(44);
    expect(layout.moodLabels).toEqual(['🌅Epic', '⛵Good', '🌊Neutral', '💨Rough']);
    expect(layout.tileCount).toBe(6);
    expect(layout.tileTops).toHaveLength(1);
    expect(layout.tileMin).toBeGreaterThanOrEqual(44);
    expect(layout.small).toEqual([]);
    expect(layout.overflowX).toBe(0);
    expect(layout.saveClearOfNav).toBeGreaterThanOrEqual(0);
});

test('diary Save is the emerald primary by day and the soft one by night', async ({ page }) => {
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    for (const mode of ['light', 'dark', 'night']) {
        await page.goto(`/e2e/fixtures/diary-compose.html?scenario=edit&mode=${mode}`);
        const save = page.getByRole('button', { name: 'Save changes' });
        await expect(save).toHaveText('Update Entry');
        const paint = await save.evaluate((el) => {
            const style = getComputedStyle(el);
            return { color: style.color, bg: style.backgroundColor, image: style.backgroundImage };
        });
        if (mode === 'light') {
            // emerald-700 under a white label.
            expect(paint.color).toBe('rgb(255, 255, 255)');
            expect(paint.image).toBe('none');
            expect(paint.bg).toMatch(/^(rgb\(4, 120, 87\)|oklch\(0\.508 0\.118 165\.612\))$/);
        } else {
            // The 'Start plotting' track: an emerald wash under an emerald-300 label.
            expect(paint.color).toBe('rgb(110, 231, 183)');
            expect(paint.image).toContain('linear-gradient');
        }
    }
});

// Review fixes (2026-10-06). The fixture page only: no request leaves 127.0.0.1.
async function localOnly(page: Page) {
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
}

/** Each photo tile: is its centre the remove control, is its dot, and is the dot shown. */
async function photoTiles(page: Page) {
    return page.evaluate(() =>
        [...document.querySelectorAll('.diary-photo')].map((tile) => {
            const remove = tile.querySelector('[aria-label="Remove this item"]')!;
            const r = tile.getBoundingClientRect();
            const d = remove.querySelector('.diary-photo-remove-dot')!.getBoundingClientRect();
            const isRemove = (x: number, y: number) => {
                const hit = document.elementFromPoint(x, y);
                return !!hit && (hit === remove || remove.contains(hit));
            };
            return {
                centreRemoves: isRemove(r.left + r.width / 2, r.top + r.height / 2),
                dotRemoves: isRemove(d.left + d.width / 2, d.top + d.height / 2),
                dotShown: getComputedStyle(remove).opacity === '1',
            };
        }),
    );
}

// A tap in the middle of a photo removed it: the remove control's 44 px hit
// box covered half the tile, and a tap beside it was moved onto it (touch
// adjustment). Only the corner dot removes now, and on a phone it shows.
test.describe('diary photos on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true });

    for (const width of [320, 390]) {
        test(`only the corner dot removes a photo at ${width}`, async ({ page }) => {
            await localOnly(page);
            await page.setViewportSize({ width, height: 844 });
            await page.goto('/e2e/fixtures/diary-compose.html?scenario=edit');
            const count = page.locator('.diary-count');
            await expect(count).toHaveText('2 of 6');
            const tile = page.locator('.diary-photo').nth(1);
            await tile.scrollIntoViewIfNeeded();
            expect(await photoTiles(page)).toEqual([
                { centreRemoves: false, dotRemoves: true, dotShown: true },
                { centreRemoves: false, dotRemoves: true, dotShown: true },
            ]);

            const box = (await tile.boundingBox())!;
            for (const [fx, fy] of [
                [0.5, 0.5],
                [0.35, 0.6],
                [0.5, 0.2],
                [0.8, 0.7],
                [0.25, 0.25],
            ]) {
                await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
                await expect(count).toHaveText('2 of 6');
            }
            const dot = (await tile.locator('.diary-photo-remove-dot').boundingBox())!;
            await page.touchscreen.tap(dot.x + dot.width / 2, dot.y + dot.height / 2);
            await expect(count).toHaveText('1 of 6');
        });
    }
});

test('diary photos with a mouse: the dot shows on hover, a click on the photo keeps it', async ({ page }) => {
    await localOnly(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/diary-compose.html?scenario=edit');
    const count = page.locator('.diary-count');
    await expect(count).toHaveText('2 of 6');
    const tile = page.locator('.diary-photo').first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click({
        position: { x: (await tile.boundingBox())!.width / 2, y: (await tile.boundingBox())!.height / 2 },
    });
    await expect(count).toHaveText('2 of 6');
    const remove = tile.getByRole('button', { name: 'Remove this item' });
    await expect.poll(() => remove.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    expect((await photoTiles(page)).map((t) => t.centreRemoves)).toEqual([false, false]);
    await remove.click();
    await expect(count).toHaveText('1 of 6');
});

// 'Neutral' was cut to 'Neut…' at 375 and 380 (and 370-372 in Chromium).
test('diary mood labels stay whole in one row at every phone width', async ({ page }) => {
    await localOnly(page);
    await page.goto('/e2e/fixtures/diary-compose.html?scenario=new');
    await expect(page.getByRole('group', { name: 'Mood' })).toBeVisible();
    for (const width of [320, 340, 360, 368, 370, 372, 375, 380, 383, 385, 390, 414, 430]) {
        await page.setViewportSize({ width, height: 667 });
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const options = [...document.querySelectorAll('.diary-mood-option')];
                    return {
                        rows: new Set(options.map((o) => Math.round(o.getBoundingClientRect().top))).size,
                        cut: options
                            .map((o) => o.querySelector('.diary-mood-label')!)
                            .filter((label) => label.scrollWidth > label.clientWidth)
                            .map((label) => label.textContent),
                    };
                }),
            )
            .toEqual({ rows: 1, cut: [] });
    }
});

// The default title's longest form fits its field at 320, 375 and 390.
test('diary default title fits its field on the longest day', async ({ page }) => {
    await localOnly(page);
    await page.goto('/e2e/fixtures/diary-compose.html?scenario=new');
    const title = page.getByRole('textbox', { name: 'Title', exact: true });
    await title.fill('Wednesday 30 September 2026 · 08:48');
    for (const width of [320, 375, 390]) {
        await page.setViewportSize({ width, height: 667 });
        await expect
            .poll(() =>
                title.evaluate((el) => {
                    const style = getComputedStyle(el);
                    const ctx = document.createElement('canvas').getContext('2d')!;
                    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                    return ctx.measureText((el as HTMLInputElement).value).width <= el.clientWidth;
                }),
            )
            .toBe(true);
    }
});

// A text field always matches :focus-visible, so the app's ring drew tight
// round the bare field and through its TITLE / WHERE eyebrow. The card
// carries the focus instead, as a 2 px sky ring at its edge.
test('diary focus: the card carries the ring, not the field inside it', async ({ page }) => {
    await localOnly(page);
    for (const [mode, accent] of [
        ['dark', 'rgb(125, 211, 252)'],
        ['light', 'rgb(3, 105, 161)'],
    ]) {
        await page.goto(`/e2e/fixtures/diary-compose.html?scenario=edit&mode=${mode}`);
        for (const name of ['Title', 'Where']) {
            const field = page.getByRole('textbox', { name, exact: true });
            await field.click();
            await expect(field).toBeFocused();
            const paint = await field.evaluate((el) => {
                const card = getComputedStyle(el.closest('.diary-card')!);
                return {
                    outline: getComputedStyle(el).outlineStyle,
                    shadow: getComputedStyle(el).boxShadow,
                    ring: card.boxShadow,
                };
            });
            expect(paint.outline).toBe('none');
            expect(paint.shadow).toBe('none');
            expect(paint.ring.startsWith(`${accent} 0px 0px 0px 1px`)).toBe(true);
        }
        const body = page.getByRole('textbox', { name: 'Diary entry text', exact: true });
        await body.click();
        await expect(body).toBeFocused();
        const box = await body.evaluate((el) => {
            const style = getComputedStyle(el);
            return { outline: style.outlineStyle, radius: style.borderTopLeftRadius };
        });
        expect(box).toEqual({ outline: 'none', radius: '16px' });
    }
});
