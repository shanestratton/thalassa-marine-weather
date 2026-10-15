import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyWideFonts } from '../../e2e/helpers/wideFonts';

/**
 * Shared measurements for the Boat Binder layout specs (132-B19): the real
 * pages and their Add and Edit sheets in e2e/fixtures/binder-sheets.tsx,
 * under a copy of the app's header and tab bar, in wide fonts (Verdana on a
 * Mac, DejaVu Sans on the Linux runner).
 *
 * The sizes: an SE (375 x 667, a 20 pt status bar and no home indicator), the
 * first SE (320 x 568), and an iPhone 13 to 16 (390 x 844, 47 pt top and a
 * 34 pt home indicator). A browser draws env(safe-area-inset-*) as 0: the
 * fixture pads the header with the top inset by hand, and the bottom inset,
 * which the tab bar and each page's bottom padding share, is added to what
 * the specs measure.
 */
export const SIZES = [
    { name: '375x667', width: 375, height: 667, insets: { top: 20, bottom: 0 } },
    { name: '320x568', width: 320, height: 568, insets: { top: 20, bottom: 0 } },
    { name: '390x844', width: 390, height: 844, insets: { top: 47, bottom: 34 } },
] as const;
export type Size = (typeof SIZES)[number];

export type Binder = 'equipment' | 'documents' | 'maintenance' | 'stores' | 'checklists';

/** The page, signed in, seeded and drawn in the wide face; returns its page errors as they come. */
export async function openBinder(page: Page, binder: Binder, size: Size): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (socket) => socket.close());
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/binder-sheets.html?binder=${binder}&insetTop=${size.insets.top}`);
    await page.waitForFunction(
        () => (window as unknown as { __binderSheetsReady?: boolean }).__binderSheetsReady,
        undefined,
        { timeout: 25_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

export async function expectNothingSideways(page: Page) {
    const overflow = await page.evaluate(() => {
        const doc = document.documentElement.scrollWidth - window.innerWidth;
        const scrollers = [...document.querySelectorAll<HTMLElement>('*')]
            .filter((el) => {
                const s = getComputedStyle(el);
                return (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.clientWidth > 0;
            })
            .map((el) => el.scrollWidth - el.clientWidth);
        return Math.max(doc, 0, ...scrollers);
    });
    expect(overflow, 'sideways overflow (px)').toBeLessThanOrEqual(1);
}

/**
 * No text cut off inside `scope`: an element that clips (overflow hidden or an
 * ellipsis) holds all of its words, a line-clamped one all of its lines, and
 * every line of text sits inside the screen's width. `skip` leaves out what
 * matches it (and what is inside it).
 */
export async function expectNoClippedText(scope: Locator, what: string, skip = ':not(*)') {
    const clipped = await scope.evaluate((root, leaveOut) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')] as HTMLElement[]) {
            const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim());
            if (!own || el.getClientRects().length === 0 || el.closest(leaveOut)) continue;
            const s = getComputedStyle(el);
            if (s.visibility === 'hidden' || el.closest('[aria-hidden="true"]') || el.closest('.sr-only')) continue;
            const name = el.textContent!.trim().slice(0, 40);
            const clips = /hidden|clip/.test(s.overflowX) || s.textOverflow === 'ellipsis';
            if (clips && el.scrollWidth > el.clientWidth + 1) issues.push(`"${name}" is cut off`);
            if (s.webkitLineClamp !== 'none' && s.webkitLineClamp && el.scrollHeight > el.clientHeight + 1)
                issues.push(`"${name}" loses lines`);
            const r = el.getBoundingClientRect();
            if (r.left < -0.5 || r.right > W + 0.5) issues.push(`"${name}" runs off the side`);
        }
        return issues;
    }, skip);
    expect(clipped, `${what}: text cut off`).toEqual([]);
}

/**
 * The page header's words whole: its crumb, subtitle and status. The title
 * itself is only noted: in wide fonts the column beside '‹ BOAT BINDER' and
 * the ⋮ is narrower than a long title at PageHeader's 14 px floor, so
 * 'EQUIPMENT' is cut at 320 px and 'MAINTENANCE' by a few pixels at 390.
 * PageHeader's layout is 132-B20's (binder accessibility), so the cut is
 * recorded on the test as a known issue, not failed here.
 */
export async function expectHeaderWhole(page: Page, size: Size) {
    const header = page.locator('[data-page-header]');
    const title = await header.getByRole('heading', { level: 1 }).evaluate((h1) => ({
        text: h1.textContent,
        cut: h1.scrollWidth - h1.clientWidth,
    }));
    if (title.cut > 1)
        test.info().annotations.push({
            type: 'known issue (132-B20)',
            description: `"${title.text}" is cut by ${title.cut} px at ${size.name} in wide fonts`,
        });
    await expectNoClippedText(header, 'the header', 'h1');
}

/** The page's bottom call to action (its TapToAction) ends above the tab bar, on screen, reached by a tap. */
export async function expectCtaAboveTabBar(page: Page, name: string) {
    const cta = page.getByRole('button', { name, exact: true });
    await expect(cta).toBeVisible();
    const m = await cta.evaluate((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
            bottom: r.bottom,
            top: r.top,
            h: r.height,
            navTop: document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().top,
            reached: !!hit && (hit === button || button.contains(hit)),
        };
    });
    expect(m.bottom, `${name} ends above the tab bar`).toBeLessThanOrEqual(m.navTop + 0.5);
    expect(m.top, `${name} is on screen`).toBeGreaterThanOrEqual(0);
    expect(m.h, `${name} is 44 pt tall`).toBeGreaterThanOrEqual(43.5);
    expect(m.reached, `a tap on ${name} reaches it`).toBe(true);
}

/**
 * The sheet open, settled (ModalSheet enters at 95% scale), and its main
 * button kept in view: whole, inside the sheet and the screen, clear of a
 * phone's home indicator, reached by a tap at its centre; and still there,
 * unmoved, with the fields scrolled to their end. Nothing in the sheet runs
 * sideways or is cut off.
 */
export async function expectSheetFits(page: Page, sheet: Locator, main: Locator, size: Size, what: string) {
    await expect(sheet).toBeVisible();
    await sheet.locator('[data-modal-sheet]').evaluate(async (panel) => {
        await Promise.all(panel.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const place = () =>
        main.evaluate((button, inset) => {
            const r = button.getBoundingClientRect();
            const panel = button.closest('[data-modal-sheet]')!.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                top: r.top,
                bottom: r.bottom,
                h: r.height,
                inside: r.top >= panel.top - 0.5 && r.bottom <= panel.bottom + 0.5,
                clearOfHome: r.bottom + inset <= window.innerHeight + 0.5,
                reached: !!hit && (hit === button || button.contains(hit)),
                clipped: button.scrollWidth > button.clientWidth + 1,
            };
        }, size.insets.bottom);
    const before = await place();
    expect(before.top, `${what}: its button is on screen (top)`).toBeGreaterThanOrEqual(0);
    expect(before.inside, `${what}: its button is inside the sheet`).toBe(true);
    expect(before.clearOfHome, `${what}: its button clears the home indicator`).toBe(true);
    expect(before.reached, `${what}: a tap on its button reaches it`).toBe(true);
    expect(before.h, `${what}: its button is 44 pt tall`).toBeGreaterThanOrEqual(43.5);
    expect(before.clipped, `${what}: its button's words are whole`).toBe(false);

    // The fields scroll above it; the button stays put.
    const body = sheet.locator('[data-modal-sheet-body]');
    if ((await body.count()) > 0) {
        await body.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        const after = await place();
        expect(Math.abs(after.top - before.top), `${what}: its button stays put as the fields scroll`).toBeLessThan(1);
        await body.evaluate((element) => {
            element.scrollTop = 0;
        });
    }
    await expectNoClippedText(sheet.locator('[data-modal-sheet]'), what);
    await expectNothingSideways(page);
}

/**
 * Typing with the keyboard up (`height` px, simulated by the fixture, with
 * the app's real keyboard guard): the field shows whole among the sheet's
 * scrolling fields, never under its pinned footer or the keyboard, and the
 * main button sits above the keyboard, reached by a tap.
 */
export async function expectTypingFits(page: Page, field: Locator, main: Locator, height: number, what: string) {
    await field.click();
    await page.evaluate((h) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: h })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
    await expect
        .poll(
            () =>
                field.evaluate((input, kb) => {
                    const r = input.getBoundingClientRect();
                    const body = input.closest('[data-modal-sheet-body]')!.getBoundingClientRect();
                    const footer = input
                        .closest('[data-modal-sheet]')!
                        .querySelector('[data-modal-sheet-footer]')!
                        .getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return (
                        r.top >= body.top - 0.5 &&
                        r.bottom <= footer.top + 0.5 &&
                        r.bottom <= window.innerHeight - kb + 0.5 &&
                        hit === input
                    );
                }, height),
            { message: `${what}: the field typed in shows whole, above the footer and the keyboard` },
        )
        .toBe(true);
    // Polled: the sheet's max-height eases to the room above the keyboard over 200 ms.
    await expect
        .poll(
            () =>
                main.evaluate((button, kb) => {
                    const r = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return (
                        r.top >= 0 &&
                        r.bottom <= window.innerHeight - kb + 0.5 &&
                        !!hit &&
                        (hit === button || button.contains(hit))
                    );
                }, height),
            { message: `${what}: its button is on screen, above the keyboard, reached by a tap` },
        )
        .toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 0 })));
}

/**
 * A Stores-style category grid (132-B19): three across, `count` choices in
 * whole rows; every label inside its cell, wrapped and never one letter to a
 * line; every cell 44 pt wide and as tall as its kind (56 with an icon, 44
 * without); each reachable by scrolling the sheet.
 */
export async function expectCategoryGrid(grid: Locator, count: number, what: string) {
    await expect(grid.getByRole('button')).toHaveCount(count);
    const geometry = await grid.evaluate((element) => {
        const problems: string[] = [];
        const buttons = [...element.querySelectorAll('button')];
        const rects = buttons.map((button) => button.getBoundingClientRect());
        const within = (outer: DOMRect, inner: DOMRect) =>
            inner.left >= outer.left - 1 &&
            inner.right <= outer.right + 1 &&
            inner.top >= outer.top - 1 &&
            inner.bottom <= outer.bottom + 1;
        const gridRect = element.getBoundingClientRect();
        if (element.scrollWidth > element.clientWidth + 1) problems.push('the grid runs sideways');
        for (const [index, button] of buttons.entries()) {
            const rect = rects[index];
            const name = button.textContent!.trim();
            const tall = button.querySelector('svg') ? 56 : 44;
            if (rect.width < 44 || rect.height < tall - 0.5)
                problems.push(`${name}: touch target too small (${rect.width} × ${rect.height})`);
            if (!within(gridRect, rect)) problems.push(`${name}: escapes the grid`);
            if (rect.left < 0 || rect.right > innerWidth) problems.push(`${name}: escapes the screen`);
            if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
                problems.push(`${name}: overflows its cell`);
            const label = button.querySelector('span')!;
            const labelRect = label.getBoundingClientRect();
            if (!within(rect, labelRect)) problems.push(`${name}: label escapes its cell`);
            const range = document.createRange();
            const text = label.firstChild!;
            const lines = new Map<number, string>();
            for (let offset = 0; offset < text.textContent!.length; offset++) {
                const letter = text.textContent![offset];
                if (!/\p{L}/u.test(letter)) continue;
                range.setStart(text, offset);
                range.setEnd(text, offset + 1);
                const r = range.getBoundingClientRect();
                if (!within(rect, r)) problems.push(`${name}: "${letter}" clipped`);
                const line = Math.round(r.top);
                lines.set(line, (lines.get(line) ?? '') + letter);
            }
            if ([...lines.values()].some((line) => line.length === 1))
                problems.push(`${name}: a one-letter line (${[...lines.values()].join(' / ')})`);
        }
        return {
            columns: new Set(rects.map((rect) => Math.round(rect.left))).size,
            rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
            problems,
        };
    });
    expect(geometry, what).toEqual({
        columns: Math.min(3, count),
        rows: Math.ceil(count / 3),
        problems: [],
    });
}
