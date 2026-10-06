import { expect, test, type Locator, type Page } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDeviceKey } from '../e2e/fixtures/diary-compose-devices';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';
import { DIARY_LONG_TITLE_MIN_WIDTH, formatEntryTitleDefault } from '../utils/diaryTitle';

const SIZES = [
    { name: 'short phone', width: 390, height: 650, keyboard: 240 },
    { name: 'tall phone', width: 390, height: 844, keyboard: 344 },
    { name: 'small phone', width: 320, height: 568, keyboard: 220 },
    { name: 'tablet pane', width: 1024, height: 768, keyboard: 300, pane: true },
];

/** A real clip: one second of plain blue, 64x36, no sound (ffmpeg's colour
 *  source), served beside the fixture. */
const CLIP = 'e2e/fixtures/diary-compose-clip.mp4';

/** Attach the clip from the picker. The fixture holds it as a local blob, as the
 *  app does: the pill's words change, and nothing joins the page. */
async function attachVideo(page: Page) {
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles(CLIP);
    await expect(page.getByRole('button', { name: 'Your video', exact: true })).toBeVisible();
    await expect(page.locator('.diary-video-player')).toHaveCount(0);
}

/** Open the clip's sheet from the pill. */
async function openVideo(page: Page) {
    await page.getByRole('button', { name: 'Your video', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Your video' });
    await expect(sheet).toBeVisible();
    return sheet;
}

/** The sheet's player has really loaded its clip (a dead source now says so in words). */
async function expectClipPlays(sheet: Locator) {
    await expect
        .poll(() =>
            sheet
                .locator('video')
                .evaluate((video) => (video as HTMLVideoElement).readyState)
                .catch(() => -1),
        )
        .toBeGreaterThanOrEqual(1);
    await expect(sheet.getByRole('status')).toHaveCount(0);
}

/** Can this browser play a clip from a blob: URL? Playwright's WebKit cannot
 *  (MEDIA_ERR_SRC_NOT_SUPPORTED for the very bytes it plays over http); Chromium
 *  and the phone can. */
async function blobClipsPlay(page: Page) {
    return page.evaluate(async (path) => {
        const bytes = await (await fetch(`/${path}`)).blob();
        const url = URL.createObjectURL(bytes);
        const video = document.createElement('video');
        video.preload = 'metadata';
        const ok = await new Promise<boolean>((resolve) => {
            video.onloadedmetadata = () => resolve(true);
            video.onerror = () => resolve(false);
            setTimeout(() => resolve(false), 4000);
            video.src = url;
        });
        URL.revokeObjectURL(url);
        return ok;
    }, CLIP);
}

/** A clip attached from the picker (a local blob): it plays where the browser
 *  can play a blob, and elsewhere the sheet says so in words, in the player's
 *  own footprint, rather than showing a dead black player. */
async function expectAttachedClip(page: Page, sheet: Locator) {
    if (await blobClipsPlay(page)) {
        await expectClipPlays(sheet);
    } else {
        await expect(sheet.getByRole('status')).toHaveText("This video can't be loaded right now.");
    }
}

/** Take the clip off from its sheet: the sheet closes and the pill offers it again. */
async function removeVideo(page: Page) {
    const sheet = await openVideo(page);
    await sheet.getByRole('button', { name: 'Remove the video', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add video · 1 min', exact: true })).toBeVisible();
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
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        await expect(body).toHaveValue(draft);

        // The clip plays in the sheet, whole on screen.
        const sheet = await openVideo(page);
        await expectAttachedClip(page, sheet);
        const preview = await sheet.locator('.diary-video-player').boundingBox();
        expect(preview).not.toBeNull();
        expect(preview!.y).toBeGreaterThanOrEqual(0);
        expect(preview!.y + preview!.height).toBeLessThanOrEqual(size.height);
        await page.screenshot({ path: test.info().outputPath('diary-video-attached.png') });
        await page.getByRole('button', { name: 'Remove the video', exact: true }).click();
        await expect(page.locator('.diary-video-player')).toHaveCount(0);
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
        await removeVideo(page);
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

    // 375x667 is the compact tier, where a tile is 44 px tall.
    for (const [width, height] of [
        [320, 844],
        [390, 844],
        [375, 667],
    ]) {
        test(`only the corner dot removes a photo at ${width}x${height}`, async ({ page }) => {
            await localOnly(page);
            await page.setViewportSize({ width, height });
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

// The default title fits its field on the longest day at the widest minute.
// Every field is 16 px on the phone (styles/ios-input-zoom.css, which the
// fixture loads as index.html does; under 16 px iOS zooms the page), and at
// 16 px the long form ('Wednesday 30 September 2026 · 08:48') did not fit at
// 375 or 320, so under 390 the default is the short form (utils/diaryTitle.ts).
const pad2 = (n: number) => String(n).padStart(2, '0');
const TITLE_DAYS = (compact: boolean) =>
    Array.from({ length: 365 }, (_, i) =>
        formatEntryTitleDefault(new Date(2026, 0, 1 + i, 0, 0), compact).replace(/ · \d\d:\d\d$/, ''),
    );
const TITLE_TIMES = Array.from({ length: 1440 }, (_, m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);

test('diary default title fits its field on the longest day, in the field size the phone draws', async ({ page }) => {
    await localOnly(page);
    for (const width of [320, 375, 389, 390, 393, 430]) {
        const compact = width < DIARY_LONG_TITLE_MIN_WIDTH;
        await page.setViewportSize({ width, height: 844 });
        await page.goto('/e2e/fixtures/diary-compose.html?scenario=new');
        const title = page.getByRole('textbox', { name: 'Title', exact: true });
        // The fixture's own default is the form this screen takes.
        await expect(title).toHaveValue(formatEntryTitleDefault(new Date(2026, 9, 6, 14, 32), compact));
        const measured = await title.evaluate(
            async (el, { days, times }) => {
                await document.fonts.ready;
                const style = getComputedStyle(el);
                const ctx = document.createElement('canvas').getContext('2d')!;
                ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                const widest = (list: string[]) =>
                    list.reduce((a, b) => (ctx.measureText(b).width > ctx.measureText(a).width ? b : a));
                const longest = `${widest(days)} · ${widest(times)}`;
                return {
                    fontSize: style.fontSize,
                    longest,
                    width: ctx.measureText(longest).width,
                    field: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                };
            },
            { days: TITLE_DAYS(compact), times: TITLE_TIMES },
        );
        expect(measured.fontSize, `title size at ${width}`).toBe('16px');
        expect(measured.width, `'${measured.longest}' at ${width}`).toBeLessThanOrEqual(measured.field);
    }
});

// A text field always matches :focus-visible, so the app's ring drew tight
// round the bare field and through its TITLE / WHERE eyebrow. Its row carries
// the focus instead, as a 2 px sky ring inside its edge, and the text box's
// card carries the text box's, rounded, with no ring on the field itself.
test('diary focus: the row or card carries the ring, not the field inside it', async ({ page }) => {
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
                const row = getComputedStyle(el.closest('.diary-row')!);
                return {
                    outline: getComputedStyle(el).outlineStyle,
                    shadow: getComputedStyle(el).boxShadow,
                    ring: row.boxShadow,
                };
            });
            expect(paint.outline).toBe('none');
            expect(paint.shadow).toBe('none');
            expect([`inset ${accent} 0px 0px 0px 2px`, `${accent} 0px 0px 0px 2px inset`]).toContain(paint.ring);
        }
        const body = page.getByRole('textbox', { name: 'Diary entry text', exact: true });
        await body.click();
        await expect(body).toBeFocused();
        // The card's border eases to the accent (150 ms).
        await expect
            .poll(() => body.evaluate((el) => getComputedStyle(el.closest('.diary-write')!).borderTopColor))
            .toBe(accent);
        const box = await body.evaluate((el) => {
            const style = getComputedStyle(el);
            const card = getComputedStyle(el.closest('.diary-write')!);
            return {
                outline: style.outlineStyle,
                shadow: style.boxShadow,
                ring: card.boxShadow,
                border: card.borderTopColor,
                radius: card.borderTopLeftRadius,
            };
        });
        expect(box.ring.startsWith(`${accent} 0px 0px 0px 1px`)).toBe(true);
        expect({ ...box, ring: undefined }).toEqual({
            outline: 'none',
            shadow: 'none',
            ring: undefined,
            border: accent,
            radius: '16px',
        });
    }
});

// ── The page fits its screen ──────────────────────────────────────────────
// Shane 2026-10-06: "could we make the diary page just fit the area. I hate
// scrolling it looks terrible. Use your banging new boxes Claude." Measured
// inside the real chrome: the THALASSA header, the tab bar and each device's
// insets (e2e/fixtures/diary-compose-devices.ts), with the app's iOS
// no-zoom rule (16 px in every field) loaded as index.html loads it. Before
// the fit, New Entry's column showed 473 px of 707 on a 390x844 iPhone 14
// (234 px of scroll) and 381 of 714 on an SE. A standard iPhone with Display
// Zoom (320x693) must fit too: before its narrow tier it scrolled 23 px with a
// GPS fix and 36 px with no recent trips.

async function openOn(page: Page, device: DiaryDeviceKey, query: string) {
    const { width, height } = DIARY_DEVICES[device];
    await page.setViewportSize({ width, height });
    await page.goto(`/e2e/fixtures/diary-compose.html?device=${device}&${query}`);
    await expect(page.locator('.diary-compose-body')).toBeVisible();
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

/** Everything the fit promises, measured in one pass. */
async function fit(page: Page) {
    return page.evaluate(() => {
        const column = document.querySelector<HTMLElement>('.diary-compose-body')!;
        const box = column.getBoundingClientRect();
        const name = (el: Element) =>
            el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? el.tagName.toLowerCase();
        const controls = [
            ...column.querySelectorAll<HTMLElement>('button, input:not([type="file"]), select, textarea'),
        ];
        const outside = controls
            .filter((el) => {
                const r = el.getBoundingClientRect();
                return (
                    r.top < box.top - 0.5 ||
                    r.bottom > box.bottom + 0.5 ||
                    r.left < box.left - 0.5 ||
                    r.right > box.right + 0.5
                );
            })
            .map(name);
        // The photo's corner dot keeps its own 32 px hit area (see the
        // touch-screen tests above); everything else is 44 at the least.
        const small = [...document.querySelectorAll<HTMLElement>('.diary-compose :is(button, input, select, textarea)')]
            .filter((el) => (el as HTMLInputElement).type !== 'file' && !el.matches('.diary-photo-remove'))
            .filter((el) => el.getBoundingClientRect().height < 43.5)
            .map((el) => `${name(el)}: ${Math.round(el.getBoundingClientRect().height)}`);
        const cut = [
            ...document.querySelectorAll<HTMLElement>(
                '.diary-compose :is(h1, .diary-eyebrow, .diary-count, .diary-mood-label, .diary-video-pill-text, .diary-trip-value, .diary-trip-status, .diary-position, .diary-style-value, .diary-foot-button)',
            ),
        ]
            .filter((el) => el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 1)
            .map(name);
        // The page, and the video sheet when it is open (it is portalled
        // outside the page).
        const tiny = [...document.querySelectorAll<HTMLElement>('.diary-compose *, [data-modal-sheet] *')]
            // Words, not the photo dot's ✕ glyph.
            .filter((el) => !el.matches('.diary-photo-remove-dot'))
            .filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()))
            .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12)
            .map(name);
        const write = document.querySelector('.diary-write')!.getBoundingClientRect();
        const save = document.querySelector('[aria-label="Save changes"]')!.getBoundingClientRect();
        // The tab bar, or on a phone on its side the toggle it folds into.
        const nav = document.querySelector('nav[aria-label="Main"] > :is(div, button)')!.getBoundingClientRect();
        const pane = document.querySelector('[data-split-pane="page"]')?.getBoundingClientRect();
        return {
            clientHeight: column.clientHeight,
            scrollHeight: column.scrollHeight,
            outside,
            small,
            cut,
            tiny,
            // The writing card reaches the column's foot: it took what was left.
            fillGap: box.bottom - parseFloat(getComputedStyle(column).paddingBottom) - write.bottom,
            text: document.querySelector('textarea')!.getBoundingClientRect().height,
            saveClear: (pane ? pane.bottom : nav.top) - save.bottom,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
    });
}

/** A column that scrolls still reaches every control: scrolled to its top the
 *  Title row is whole, to its foot the whole writing card and its polish row. */
async function reachable(page: Page) {
    return page.locator('.diary-compose-body').evaluate((column) => {
        const misses: string[] = [];
        const inside = (el: Element) => {
            const c = column.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
        };
        column.scrollTop = 0;
        if (!inside(column.querySelector('.diary-row')!)) misses.push('the Title row is out of reach');
        column.scrollTop = column.scrollHeight;
        if (!inside(column.querySelector('.diary-write')!)) misses.push('the writing card is out of reach');
        column.scrollTop = 0;
        return misses;
    });
}

const FIT_STATES = [
    '',
    'photos=0',
    'photos=2',
    'photos=6',
    'video=clip',
    'trips=loading',
    'gps=acquiring',
    'busy=polishing',
    'mode=light',
    'offline=true',
    'photos=6&video=clip&trips=loading&gps=acquiring&busy=polishing&mode=light&offline=true',
    // The two long notes, wrapped: no fix and not looking, no recent trips.
    'photos=6&video=clip&trips=none&gps=none&offline=true',
];

for (const [key, device] of Object.entries(DIARY_DEVICES).filter(([, d]) => d.mustFit)) {
    test(`diary fits ${device.name} (${device.width}x${device.height}) with no scroll, new and edit, in every state`, async ({
        page,
    }) => {
        await localOnly(page);
        const misfits: string[] = [];
        for (const scenario of ['new', 'edit']) {
            for (const state of FIT_STATES) {
                await openOn(page, key as DiaryDeviceKey, `scenario=${scenario}&${state}`);
                const f = await fit(page);
                const where = `${scenario}${state ? ` + ${state}` : ''}`;
                // A 320 pt screen with both long notes wrapped may scroll a
                // little; everything else fits.
                const longNotes = state.includes('trips=none') && state.includes('gps=none');
                const allowed = longNotes ? (device.longNotesScroll ?? 0) : 0;
                if (f.scrollHeight > f.clientHeight + 1 + allowed)
                    misfits.push(`${where}: scrolls ${f.scrollHeight - f.clientHeight}px`);
                // Scrolled or not, every control lies inside the column.
                if (f.outside.length && !allowed) misfits.push(`${where}: outside the column ${f.outside.join(', ')}`);
                if (allowed) misfits.push(...(await reachable(page)).map((miss) => `${where}: ${miss}`));
                if (f.small.length) misfits.push(`${where}: under 44 px ${f.small.join(', ')}`);
                if (f.cut.length) misfits.push(`${where}: cut ${f.cut.join(', ')}`);
                if (f.tiny.length) misfits.push(`${where}: under 12 px ${f.tiny.join(', ')}`);
                const scrolls = f.scrollHeight > f.clientHeight + 1;
                if (!scrolls && Math.abs(f.fillGap) > 1)
                    misfits.push(`${where}: the text card stops ${f.fillGap}px short`);
                // A few lines to write in; the least when both long notes wrap.
                if (f.text < Math.min(device.textMin ?? 72, state.includes('=none') ? 44 : 72))
                    misfits.push(`${where}: text box only ${f.text}px`);
                if (f.saveClear < 0) misfits.push(`${where}: Save under the tab bar by ${-f.saveClear}px`);
                if (f.overflowX > 0) misfits.push(`${where}: ${f.overflowX}px wider than the screen`);
            }
        }
        expect(misfits).toEqual([]);
    });
}

// 320x568 (a zoomed SE) and a phone on its side may scroll as a last resort;
// they stay fully usable.
for (const key of ['iphone-se-zoomed', 'iphone-14-landscape'] as const) {
    test(`diary on ${DIARY_DEVICES[key].name} (${DIARY_DEVICES[key].width}x${DIARY_DEVICES[key].height}): it may scroll, and every control is whole and reachable`, async ({
        page,
    }) => {
        await localOnly(page);
        for (const scenario of ['new', 'edit']) {
            await openOn(page, key, `scenario=${scenario}&photos=6&video=clip`);
            const f = await fit(page);
            expect(f.small).toEqual([]);
            expect(f.cut).toEqual([]);
            expect(f.tiny).toEqual([]);
            expect(f.overflowX).toBe(0);
            expect(f.saveClear).toBeGreaterThanOrEqual(0);
            // The column scrolls to the whole text box and its polish row.
            await page.locator('.diary-compose-body').evaluate((column) => (column.scrollTop = column.scrollHeight));
            const reach = await page.evaluate(() => {
                const column = document.querySelector('.diary-compose-body')!.getBoundingClientRect();
                const write = document.querySelector('.diary-write')!.getBoundingClientRect();
                return { top: write.top - column.top, bottom: column.bottom - write.bottom, height: write.height };
            });
            expect(reach.top).toBeGreaterThanOrEqual(0);
            expect(reach.bottom).toBeGreaterThanOrEqual(0);
            // It scrolls anyway, so the text box keeps room for a few lines: on
            // its side three (the whole card must still fit the short column).
            const landscape = !!DIARY_DEVICES[key].landscape;
            expect(
                await page.locator('textarea').evaluate((el) => el.getBoundingClientRect().height),
            ).toBeGreaterThanOrEqual(landscape ? 72 : 96);
            expect(reach.height).toBeGreaterThanOrEqual(landscape ? 116 : 140);
        }
        // The video sheet's words keep the 12 px floor here too: a clip that
        // plays, one that will not resolve, and the edit's caption.
        for (const query of ['scenario=new&video=clip', 'scenario=edit&video=missing', 'scenario=edit&video=clip']) {
            await openOn(page, key, query);
            const sheet = await openVideo(page);
            if (query.endsWith('missing')) {
                await expect(sheet.getByRole('status')).toHaveText("This video can't be loaded right now.");
            } else {
                await expectClipPlays(sheet);
            }
            expect((await fit(page)).tiny, query).toEqual([]);
        }
    });
}

// The video: the pill on the Photos line, its words its name; a clip going on
// changes only those words, so the text box never moves (the 2026-09-09
// rule); the clip plays in the app's centred sheet, clear of the tab bar.
for (const key of ['iphone-se', 'iphone-14', 'tablet-pane'] as const) {
    test(`diary video on ${DIARY_DEVICES[key].name}: the pill changes its words, the text never moves, the clip plays in a centred sheet`, async ({
        page,
    }) => {
        await localOnly(page);
        await openOn(page, key, 'scenario=new');
        const add = page.getByRole('button', { name: 'Add video · 1 min', exact: true });
        await expect(add).toHaveText('Add video · 1 min');
        const line = await add.evaluate((pill) => {
            const head = pill.closest('.diary-media-head')!.getBoundingClientRect();
            const photos = pill.closest('.diary-media')!.querySelector('.diary-eyebrow')!.getBoundingClientRect();
            const r = pill.getBoundingClientRect();
            return {
                rightGap: head.right - r.right,
                photosLeft: photos.left < r.left,
                sameLine: Math.abs((photos.top + photos.bottom) / 2 - (r.top + r.bottom) / 2) <= 14,
            };
        });
        expect(line.rightGap).toBeLessThanOrEqual(1);
        expect(line.photosLeft).toBe(true);
        expect(line.sameLine).toBe(true);

        const body = page.getByRole('textbox', { name: 'Diary entry text', exact: true });
        const before = await body.boundingBox();
        await attachVideo(page);
        const after = await body.boundingBox();
        expect(after).toEqual(before);
        expect((await fit(page)).scrollHeight - (await fit(page)).clientHeight).toBeLessThanOrEqual(1);

        const sheet = await openVideo(page);
        await expectAttachedClip(page, sheet);
        const geometry = await sheet.evaluate((dialog) => {
            const panel = dialog.querySelector('[data-modal-sheet]')!.getBoundingClientRect();
            const video = dialog.querySelector('.diary-video-player')!.getBoundingClientRect();
            const frame = (
                document.querySelector('[data-split-pane="page"]') ?? document.documentElement
            ).getBoundingClientRect();
            const nav = document.querySelector('nav[aria-label="Main"] > div')!.getBoundingClientRect();
            return {
                centre: (panel.left + panel.right) / 2 - (frame.left + frame.right) / 2,
                top: panel.top - frame.top,
                clearOfBar: Math.min(nav.top, frame.bottom) - panel.bottom,
                videoInside: video.top >= panel.top && video.bottom <= panel.bottom,
            };
        });
        expect(Math.abs(geometry.centre)).toBeLessThanOrEqual(1);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.clearOfBar).toBeGreaterThanOrEqual(0);
        expect(geometry.videoInside).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`diary-video-sheet-${key}.png`) });
        await sheet.getByRole('button', { name: 'Close' }).click();
        await expect(sheet).toHaveCount(0);

        await removeVideo(page);
        expect(await body.boundingBox()).toEqual(before);
        expect(
            await page.evaluate(() =>
                [document.documentElement, document.body, document.getElementById('root')!].every(
                    (element) => element.scrollTop === 0,
                ),
            ),
        ).toBe(true);
    });
}

test('diary edit: no video add, a saved clip plays with the honest caption, and a lost one says so', async ({
    page,
}) => {
    await localOnly(page);
    await openOn(page, 'iphone-14', 'scenario=edit');
    const note = page.getByText('Video: new entries', { exact: true });
    await expect(note).toBeVisible();
    expect(await note.evaluate((el) => el.closest('button, [role="button"], a'))).toBeNull();
    // A label at full strength, so it keeps its contrast.
    expect(
        await note.evaluate((el) => {
            let opacity = 1;
            for (let node: Element | null = el; node; node = node.parentElement)
                opacity *= Number(getComputedStyle(node).opacity);
            return opacity;
        }),
    ).toBe(1);
    await expect(page.getByRole('button', { name: /video/i })).toHaveCount(0);

    await openOn(page, 'iphone-14', 'scenario=edit&video=clip');
    let sheet = await openVideo(page);
    await expect(sheet.locator('video')).toHaveCount(1);
    await expectClipPlays(sheet);
    await expect(sheet.getByText("A saved entry's video can't be changed yet.", { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Remove the video' })).toHaveCount(0);

    await openOn(page, 'iphone-14', 'scenario=edit&video=missing');
    sheet = await openVideo(page);
    const lost = sheet.getByRole('status');
    await expect(lost).toHaveText("This video can't be loaded right now.");
    expect((await lost.boundingBox())!.height).toBeGreaterThanOrEqual(100);
});

// With the keyboard up the column may scroll; each field stays above the
// keyboard and the foot inside the real chrome.
for (const [key, keyboardHeight] of [
    ['iphone-se', 260],
    ['iphone-14', 336],
    // On its side the keyboard takes more than half the screen; the page's
    // head steps aside while it is up.
    ['iphone-14-landscape', 200],
    ['iphone-14-zoomed', 280],
    ['tablet-pane', 300],
] as const) {
    test(`diary fields stay above the keyboard inside the real chrome on ${DIARY_DEVICES[key].name}`, async ({
        page,
    }) => {
        await localOnly(page);
        await openOn(page, key, 'scenario=new&photos=6&video=clip');
        for (const name of ['Title', 'Where', 'Diary entry text']) {
            const field = page.getByRole('textbox', { name, exact: true });
            await field.focus();
            await keyboard(page, keyboardHeight);
            await bodyAboveFooter(page, field, keyboardHeight);
            if (name === 'Diary entry text') {
                await field.fill('Wind backed to the north-east after lunch, so we reefed early.');
                await bodyAboveFooter(page, field, keyboardHeight);
            }
            await keyboard(page, 0);
            await field.evaluate((element) => (element as HTMLElement).blur());
        }
        // Keyboard down, the head is back and the page fits again (where it
        // must fit at all).
        await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible();
        if (DIARY_DEVICES[key].mustFit) {
            await expect
                .poll(async () => {
                    const f = await fit(page);
                    return f.scrollHeight - f.clientHeight;
                })
                .toBeLessThanOrEqual(1);
        }
    });
}

// The header stand-in is App.tsx's header, measured against the real app at
// each width it changes at (the 48 px mark under 390, the fluid root font).
test.describe('diary fixture chrome', () => {
    test.use({
        serviceWorkers: 'block',
        storageState: async ({ baseURL }, provide) => {
            await provide({
                ...ONBOARDED_STORAGE,
                origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
            });
        },
    });

    test('the fixture header is the real app header at every phone width, and on its side', async ({
        page,
        context,
        baseURL,
    }) => {
        const origin = new URL(baseURL!).origin;
        await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await context.routeWebSocket('**/*', (socket) => socket.close());
        // The fixture on a page of its own: early in a cold run the dev server
        // reloads the app once while it optimises the app's dependencies.
        const stand = await context.newPage();
        for (const [width, height] of [
            [320, 844],
            [375, 844],
            [390, 844],
            [430, 844],
            // A phone on its side: the one-row header.
            [844, 390],
        ]) {
            await page.setViewportSize({ width, height });
            // Every page but the chart wears this header; the diary opens from Vessel.
            await page.goto('/?view=vessel');
            const measure = () =>
                page
                    .evaluate(async () => {
                        await document.fonts.ready;
                        const header = document.querySelector('header')?.getBoundingClientRect();
                        const main = document.querySelector('#main-content')?.getBoundingClientRect();
                        return header && main ? { height: header.height, page: main.top } : null;
                    })
                    .catch(() => null);
            await expect.poll(measure).not.toBeNull();
            const real = (await measure())!;
            await stand.setViewportSize({ width, height });
            await stand.goto(
                `/e2e/fixtures/diary-compose.html?scenario=new&device=${height < 500 ? 'iphone-14-landscape' : 'iphone-14'}&top=0&bottom=0`,
            );
            const header = await stand.locator('[data-testid="app-header"]').evaluate(async (element) => {
                await document.fonts.ready;
                return element.getBoundingClientRect().height;
            });
            expect(Math.abs(header - real.height), `header at ${width}`).toBeLessThanOrEqual(0.5);
            // Nothing else sits between the header and the page.
            expect(Math.abs(real.page - real.height), `page top at ${width}`).toBeLessThanOrEqual(0.5);
        }
    });
});
