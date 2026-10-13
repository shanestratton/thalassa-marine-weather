import { expect, test, type Page } from '@playwright/test';
import { expectPalette } from './helpers/palette';

/** The mean colour of a patch of the page as it is painted (a screenshot,
 *  decoded in the page), so a scrim over a card counts. */
async function painted(page: Page, clip: { x: number; y: number; width: number; height: number }) {
    const png = (await page.screenshot({ clip })).toString('base64');
    return page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { data: pixels } = context.getImageData(0, 0, canvas.width, canvas.height);
        const sum = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
        return sum.map((value) => value / (pixels.length / 4));
    }, png);
}

test('passage archive shows the exact count and confirmation fits a 390px phone', async ({ page, baseURL }, info) => {
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/functions/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/passage-log.html');
    const archive = page.getByRole('button', { name: 'Archive passage', exact: true });
    // Since 74111711 the Voyage stats and Archived voyages cards sit fixed above
    // the voyage list, so on a 390x844 phone the passage's Archive action can be
    // below the list's fold: reachable by scrolling the list, which is the point.
    await archive.scrollIntoViewIfNeeded();
    await expect(archive).toBeInViewport();
    expect((await archive.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('passage-archive-action.png') });
    // iOS touch taps do not focus buttons; seed keyboard focus to verify restoration.
    await archive.focus();
    await archive.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Archive this passage?' });
    await expect(dialog).toContainText('Move all 3 legs into Archived Voyages. Nothing is deleted');
    const confirm = dialog.getByRole('button', { name: 'Archive 3 legs', exact: true });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(confirm).toBeInViewport();
    await expect(cancel).toBeInViewport();
    await expect(cancel).toBeFocused();
    const panel = dialog.locator('[data-pane-dialog-panel]');
    await expect(panel).toHaveCSS('opacity', '1');
    // Capture the resting surface, not the intentionally translucent entrance animation.
    expect(
        await panel.evaluate((element) => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d')!;
            context.fillStyle = style.backgroundColor;
            context.fillRect(0, 0, 1, 1);
            return { opacity: style.opacity, backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3] };
        }),
    ).toEqual({ opacity: '1', backgroundAlpha: 255 });
    expect(
        await dialog.evaluate((element) => {
            const panel = element.querySelector('[data-pane-dialog-panel]')!;
            const bounds = panel.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && panel.scrollWidth <= panel.clientWidth;
        }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('passage-archive-confirm.png'), animations: 'disabled' });
    await cancel.click();
    await expect(dialog).not.toBeVisible();
    await expect(archive).toBeFocused();
    expect(
        await page.evaluate(
            () => (window as unknown as { __passageArchiveRequests: unknown[] }).__passageArchiveRequests,
        ),
    ).toEqual([]);
    await archive.click();
    await confirm.click();
    await expect(dialog).not.toBeVisible();
    expect(
        await page.evaluate(
            () => (window as unknown as { __passageArchiveRequests: unknown[] }).__passageArchiveRequests,
        ),
    ).toEqual([{ passageId: 'fixture-passage', voyageIds: ['fixture-0', 'fixture-1', 'fixture-2'] }]);
});

/*
 * A standalone voyage wears a hue of its own (128-HUES, Shane 2026-10-13: "can
 * we put a nice coloured hue around the single log items similar (but
 * different color) to the passage logs"): the one card hue in its nm chip's
 * sky, quieter than the passage's purple, which is unchanged; the passage's
 * legs stay inside the purple only. Dark, daylight and night (the fixture's
 * ?mode, as the app draws them).
 */
for (const mode of ['dark', 'light', 'night'] as const) {
    test(`a standalone voyage wears the sea hue and the passage its purple, in ${mode}`, async ({
        page,
        baseURL,
    }, info) => {
        const origin = new URL(baseURL!).origin;
        await page.route('**/*', (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/e2e/fixtures/passage-log.html?mode=${mode}`);
        await expect(page.getByRole('button', { name: 'Archive passage', exact: true })).toBeAttached();
        // The palette asked for is the one drawn: night's computed colours are
        // dark's, so only the scrim (and the pixels under it, below) differ.
        await expectPalette(page, mode);
        const m = await page.evaluate(() => {
            const parse = (colour: string) => {
                const slash = colour.match(/\/\s*([\d.]+)\s*\)$/);
                const rgba = colour.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
                return Number(slash?.[1] ?? rgba?.[1] ?? 1);
            };
            const passage = document.querySelector<HTMLElement>('section[aria-label^="Passage"]')!;
            const cards = [...document.querySelectorAll<HTMLElement>('button[aria-label="View on map"]')].map((map) => {
                const card = map.parentElement!.parentElement!;
                const slot = card.parentElement!;
                return {
                    inPassage: passage.contains(card),
                    hued: slot.classList.contains('card-hue-sea'),
                    halo: getComputedStyle(slot).boxShadow,
                    edge: getComputedStyle(card).borderTopColor,
                    edgeAlpha: parse(getComputedStyle(card).borderTopColor),
                    wash: getComputedStyle(card).backgroundImage,
                    height: card.getBoundingClientRect().height,
                };
            });
            const style = getComputedStyle(passage);
            return {
                cards,
                passage: {
                    classes: [...passage.classList],
                    edge: style.borderTopColor,
                    edgeAlpha: parse(style.borderTopColor),
                    halo: style.boxShadow,
                    wash: style.backgroundImage,
                },
            };
        });
        const standalone = m.cards.filter((card) => !card.inPassage);
        const legs = m.cards.filter((card) => card.inPassage);
        expect(standalone).toHaveLength(2);
        expect(legs).toHaveLength(3);
        for (const card of standalone) {
            expect(card.hued).toBe(true);
            expect(card.halo, 'its halo, on the slot').toMatch(/0px 0px 22px -8px/);
            expect(card.wash, 'a wash on its back').toContain('gradient');
            // Quieter than the passage's 40 % edge, but drawn.
            expect(card.edgeAlpha).toBeGreaterThan(0.2);
            expect(card.edgeAlpha).toBeLessThan(m.passage.edgeAlpha);
            expect(card.edge, 'not the passage purple').not.toBe(m.passage.edge);
        }
        for (const leg of legs) {
            expect(leg.hued, 'a leg wears only the passage hue').toBe(false);
            expect(leg.halo).toBe('none');
        }
        // The passage keeps its purple, now from the one class.
        expect(m.passage.classes).toEqual(expect.arrayContaining(['card-hue', 'card-hue-passage']));
        expect(m.passage.edgeAlpha).toBeCloseTo(0.4, 2);
        expect(m.passage.halo).toMatch(/0px 0px 22px -8px/);
        expect(m.passage.wash).toContain('gradient');
        if (mode === 'night') {
            // The scrim lies over the hued cards, not under them: a standalone
            // card's top band (its wash, under its title row) paints redder
            // and less blue with the scrim than with it lifted.
            const box = (await page
                .getByRole('button', { name: 'View on map' })
                .first()
                .evaluate((map) => {
                    const card = map.parentElement!.parentElement!.getBoundingClientRect();
                    return { x: card.left + card.width * 0.3, y: card.top + 2, width: card.width * 0.4, height: 3 };
                }))!;
            const night = await painted(page, box);
            await page.getByTestId('night-scrim').evaluate((scrim) => (scrim.style.display = 'none'));
            const lifted = await painted(page, box);
            await page.getByTestId('night-scrim').evaluate((scrim) => (scrim.style.display = ''));
            expect(night[0], `red under the scrim ${night} vs ${lifted}`).toBeGreaterThan(lifted[0] + 3);
            expect(night[2], `blue under the scrim ${night} vs ${lifted}`).toBeLessThan(lifted[2] - 3);
        }
        await page.screenshot({ path: info.outputPath(`log-hues-${mode}.png`) });
    });
}
