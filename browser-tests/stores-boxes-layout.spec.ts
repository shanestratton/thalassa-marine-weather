import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Boxes in Ship's Stores (126-11a): the Boxes list and the box page.
 *
 * The real InventoryList, ModalSheet and index.css under a copy of the app's
 * header and tab bar (e2e/fixtures/stores-boxes.tsx), over the real local
 * database, with no network: eight boxes in five languages, eleven spares in
 * the engine-room box. In wide fonts (Verdana on a Mac, DejaVu Sans on the
 * Linux runner), at 320 x 568, 390 x 844, 430 x 932 and the iPad split pane
 * (1024 x 768, the Stores pane 507 x 640), both sheets:
 *
 *   - are centred (in the pane, in split view) and end above the tab bar;
 *   - scroll inside themselves, never the page;
 *   - keep their footer buttons reachable;
 *   - have every button at least 44 pt, and nothing scrolls sideways.
 *
 * And the New box name field stays in view above a 300 px keyboard, Delete
 * box asks first in a centred dialog clear of the tab bar, and an empty
 * Stores still shows Boxes (?empty=true), so boxes can be set up first.
 *
 * Set STORES_BOXES_SHOTS_DIR to save the screenshots for Shane.
 */

const SHOTS = process.env.STORES_BOXES_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SIZES = [
    { name: '320x568', width: 320, height: 568, pane: false },
    { name: '390x844', width: 390, height: 844, pane: false },
    { name: '430x932', width: 430, height: 932, pane: false },
    { name: 'iPad split 1024x768', width: 1024, height: 768, pane: true },
];

async function open(page: Page, size: (typeof SIZES)[number], empty = false) {
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
    const query = [size.pane && 'pane=true', empty && 'empty=true'].filter(Boolean).join('&');
    await page.goto(`/e2e/fixtures/stores-boxes.html${query ? `?${query}` : ''}`);
    await page.waitForFunction(
        () => (window as unknown as { __storesBoxesFixtureReady?: boolean }).__storesBoxesFixtureReady,
        undefined,
        { timeout: 25_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText(empty ? 'Nothing in stores yet' : 'Raw-water impeller')).toBeVisible({
        timeout: 25_000,
    });
    return errors;
}

async function shot(page: Page, name: string) {
    if (!SHOTS) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, `${name}-${test.info().project.name}.png`) });
}

/** The real ModalSheet enters at 95% scale: measure its settled layout. */
async function settled(dialog: Locator) {
    await dialog.locator('[data-modal-sheet]').evaluate(async (element) => {
        await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
}

/** Every geometric house rule for an open sheet, measured in the page. Returns what broke. */
function sheetIssues(dialog: Locator) {
    return dialog.locator('[data-modal-sheet]').evaluate((panel) => {
        const issues: string[] = [];
        const r = panel.getBoundingClientRect();
        const pane = document.querySelector('[data-split-pane]');
        const frame = pane ? pane.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const leftGap = r.left - frame.left;
        const rightGap = frame.right - r.right;
        if (Math.abs(leftGap - rightGap) > 1) issues.push(`not centred (${leftGap} | ${rightGap})`);
        if (r.top < frame.top - 0.5) issues.push(`starts above its frame (${r.top} < ${frame.top})`);
        if (r.bottom > frame.bottom + 0.5) issues.push(`ends below its frame (${r.bottom} > ${frame.bottom})`);
        if (r.bottom > nav.top + 0.5) issues.push(`runs under the tab bar (${r.bottom} > ${nav.top})`);
        const style = getComputedStyle(panel);
        if (!/(auto|scroll)/.test(style.overflowY)) issues.push(`does not scroll inside itself (${style.overflowY})`);
        const page = document.scrollingElement!;
        if (page.scrollHeight > page.clientHeight + 1) issues.push('the page scrolls');
        if (page.scrollWidth > page.clientWidth + 1) issues.push('the page scrolls sideways');
        if (panel.scrollWidth > panel.clientWidth + 1) issues.push('the sheet scrolls sideways');
        for (const button of panel.querySelectorAll('button')) {
            const b = button.getBoundingClientRect();
            const name = button.getAttribute('aria-label') || button.textContent?.trim() || '?';
            if (b.height < 43.5 || b.width < 43.5) issues.push(`${name}: under 44 pt (${b.width} x ${b.height})`);
            if (b.left < r.left - 0.5 || b.right > r.right + 0.5) issues.push(`${name}: escapes the sheet sideways`);
            if (button.scrollWidth > button.clientWidth + 1) issues.push(`${name}: words clipped`);
        }
        return issues;
    });
}

/** Scrolled to as a skipper would, the button is whole, in the sheet, above the tab bar, and a tap reaches it. */
async function expectReachable(button: Locator) {
    await button.scrollIntoViewIfNeeded();
    await expect
        .poll(() =>
            button.evaluate((element) => {
                const b = element.getBoundingClientRect();
                const panel = element.closest('[data-modal-sheet]')!.getBoundingClientRect();
                const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
                const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                return (
                    b.top >= panel.top - 0.5 &&
                    b.bottom <= panel.bottom + 0.5 &&
                    b.bottom <= nav.top + 0.5 &&
                    !!hit &&
                    (hit === element || element.contains(hit))
                );
            }),
        )
        .toBe(true);
}

for (const size of SIZES) {
    test(`Boxes list, ${size.name}: centred, above the tab bar, scrolls inside itself, 44 pt rows`, async ({
        page,
    }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Boxes', exact: true }).click();
        const list = page.getByRole('dialog', { name: 'Boxes' });
        await expect(list).toBeVisible();
        await settled(list);
        const engine = list.getByRole('button', { name: /^Engine room spares 3/ });
        await expect(engine).toContainText('Engine room · 9 items · 2 low');
        await expectWideFaceDrawn(engine);
        await shot(page, `boxes-list-${size.width}x${size.height}`);

        expect(await sheetIssues(list)).toEqual([]);
        await expectReachable(list.getByRole('button', { name: 'New box' }));
        await expectReachable(list.getByRole('button', { name: /^Under-berth starboard/ }));
        if (size.width === 320) {
            const scrolls = await list
                .locator('[data-modal-sheet]')
                .evaluate((panel) => panel.scrollHeight > panel.clientHeight);
            expect(scrolls, 'eight boxes scroll inside the sheet at 320 x 568').toBe(true);
        }
        expect(errors).toEqual([]);
    });

    test(`Box page, ${size.name}: centred, above the tab bar, scrolls inside itself, 44 pt − and +`, async ({
        page,
    }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Boxes', exact: true }).click();
        await page
            .getByRole('dialog', { name: 'Boxes' })
            .getByRole('button', { name: /^Engine room spares 3/ })
            .click();
        const box = page.getByRole('dialog', { name: 'Engine room spares 3' });
        await expect(box).toBeVisible();
        await settled(box);
        await expect(box.getByRole('button', { name: /^Take one / })).toHaveCount(9);
        await expect(box.getByRole('button', { name: /^Add one / })).toHaveCount(9);
        await shot(page, `box-page-${size.width}x${size.height}`);

        expect(await sheetIssues(box)).toEqual([]);
        await expectReachable(box.getByRole('button', { name: 'Take one Hose clamp 40 mm' }));
        await expectReachable(box.getByRole('button', { name: 'Put items in this box' }));
        await expectReachable(box.getByRole('button', { name: 'New item here' }));

        // −1 the impeller: one tap, the count moves, the sheet stays put.
        await box.getByRole('button', { name: 'Take one Raw-water impeller' }).scrollIntoViewIfNeeded();
        await box.getByRole('button', { name: 'Take one Raw-water impeller' }).click();
        await expect(box.getByLabel('Raw-water impeller: 2')).toBeVisible();
        if (size.width === 390) await shot(page, `box-page-after-take-${size.width}x${size.height}`);
        expect(await sheetIssues(box)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test(`Delete box, ${size.name}: asks first, in a centred dialog above the tab bar`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Boxes', exact: true }).click();
        await page
            .getByRole('dialog', { name: 'Boxes' })
            .getByRole('button', { name: /^Engine room spares 3/ })
            .click();
        await page
            .getByRole('dialog', { name: 'Engine room spares 3' })
            .getByRole('button', { name: 'Edit box' })
            .click();
        const form = page.getByRole('dialog', { name: 'Edit box' });
        await settled(form);
        await form.getByRole('button', { name: 'Delete box (its items stay in Stores)' }).click();
        const ask = page.getByRole('dialog', { name: 'Delete Engine room spares 3?' });
        await expect(ask).toBeVisible();
        await ask.locator('[data-pane-dialog-panel]').evaluate(async (element) => {
            await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
        });
        await shot(page, `delete-box-${size.width}x${size.height}`);
        const issues = await ask.locator('[data-pane-dialog-panel]').evaluate((panel) => {
            const found: string[] = [];
            const r = panel.getBoundingClientRect();
            const pane = document.querySelector('[data-split-pane]');
            const frame = pane ? pane.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight);
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            if (Math.abs(r.left - frame.left - (frame.right - r.right)) > 1) found.push('not centred');
            if (r.top < frame.top - 0.5 || r.bottom > frame.bottom + 0.5) found.push('leaves its frame');
            if (r.bottom > nav.top + 0.5) found.push('runs under the tab bar');
            if (panel.scrollWidth > panel.clientWidth + 1) found.push('scrolls sideways');
            for (const button of panel.querySelectorAll('button')) {
                const b = button.getBoundingClientRect();
                if (b.height < 43.5) found.push(`${button.textContent?.trim()}: under 44 pt`);
                const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                if (!hit || !(hit === button || button.contains(hit)))
                    found.push(`${button.textContent?.trim()}: covered`);
            }
            return found;
        });
        expect(issues).toEqual([]);
        // Cancel keeps the box.
        await ask.getByRole('button', { name: 'Cancel' }).click();
        await expect(ask).toHaveCount(0);
        await expect(form).toBeVisible();
        expect(errors).toEqual([]);
    });

    test(`New item here, ${size.name}: the Add form opens in the box, at its place, and fits`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Boxes', exact: true }).click();
        await page
            .getByRole('dialog', { name: 'Boxes' })
            .getByRole('button', { name: /^Εργαλειοθήκη κόκπιτ/ })
            .click();
        await page
            .getByRole('dialog', { name: 'Εργαλειοθήκη κόκπιτ' })
            .getByRole('button', { name: 'New item here' })
            .click();
        const form = page.getByRole('dialog', { name: 'Add to Εργαλειοθήκη κόκπιτ' });
        await expect(form).toBeVisible();
        await settled(form);
        await expect(form.getByLabel('Zone')).toHaveValue('Κόκπιτ');
        await expect(form.getByLabel('Exact spot')).toHaveValue('Εργαλειοθήκη κόκπιτ');
        await shot(page, `new-item-here-${size.width}x${size.height}`);
        expect(await sheetIssues(form)).toEqual([]);
        await expectReachable(form.getByRole('button', { name: 'Add item' }));
        expect(errors).toEqual([]);
    });

    test(`Empty Stores, ${size.name}: Boxes is there before any item, 44 pt, and the page still fits`, async ({
        page,
    }) => {
        const errors = await open(page, size, true);
        const boxes = page.getByRole('button', { name: 'Boxes', exact: true });
        await expect(boxes).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Search stores' })).toHaveCount(0);
        await shot(page, `empty-stores-${size.width}x${size.height}`);
        const issues = await boxes.evaluate((button) => {
            const found: string[] = [];
            const b = button.getBoundingClientRect();
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            if (b.height < 43.5 || b.width < 43.5) found.push(`under 44 pt (${b.width} x ${b.height})`);
            if (b.bottom > nav.top) found.push('under the tab bar');
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            if (!hit || !(hit === button || button.contains(hit))) found.push('covered');
            const page = document.scrollingElement!;
            if (page.scrollHeight > page.clientHeight + 1) found.push('the page scrolls');
            if (page.scrollWidth > page.clientWidth + 1) found.push('the page scrolls sideways');
            return found;
        });
        expect(issues).toEqual([]);
        await expect(page.getByRole('button', { name: /Add item/ }).first()).toBeInViewport();
        await boxes.click();
        const list = page.getByRole('dialog', { name: 'Boxes' });
        await settled(list);
        expect(await sheetIssues(list)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test(`New box, ${size.name}: the name field stays in view above a 300 px keyboard`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Boxes', exact: true }).click();
        await page.getByRole('dialog', { name: 'Boxes' }).getByRole('button', { name: 'New box' }).click();
        const form = page.getByRole('dialog', { name: 'New box' });
        await expect(form).toBeVisible();
        await settled(form);
        const name = form.getByLabel('Box name');
        await name.click();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 300 })));
        await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
        await name.fill('Coffre arrière, bac 2');
        await expect
            .poll(() =>
                name.evaluate((input) => {
                    const r = input.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                    return r.top >= 0 && r.bottom <= innerHeight - 300 && hit === input;
                }),
            )
            .toBe(true);
        await shot(page, `new-box-keyboard-${size.width}x${size.height}`);
        const sideways = await form
            .locator('[data-modal-sheet]')
            .evaluate((panel) => panel.scrollWidth > panel.clientWidth + 1);
        expect(sideways).toBe(false);
        expect(errors).toEqual([]);
    });
}
