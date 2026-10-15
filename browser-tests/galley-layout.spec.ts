import { expect, test, type Locator, type Page } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { expectNoClippedText, expectNothingSideways, pageSettled } from './helpers/binderLayout';

/**
 * The Galley fits every phone (132-B17, binder audit GAL-17: no browser spec
 * covered the Galley page, the Grocery list, the Recipe editor or Cooking
 * Mode).
 *
 * The real GalleyPage and index.css under a copy of the app's header and tab
 * bar (e2e/fixtures/galley-layout.tsx), and from it, by the taps a skipper
 * makes, the real Grocery list, Recipe editor and Cooking Mode. In wide fonts
 * (Verdana on a Mac, DejaVu Sans on the Linux runner) at 375 x 667 (an SE:
 * 20 pt status bar, no home indicator; the clean-up's fit size), 320 x 568
 * and 390 x 844 (an iPhone 13–16: 47 pt top, 34 pt home indicator):
 *
 *  - Active meals: Today (the pot on the stove first), Next, Later, Earlier,
 *    in the order they are eaten, under plain dates, with no 112 px hero
 *    (GAL-11); "Open shopping list", and a meal's Share brought into view,
 *    clear the tab bar; the header's words stay on the screen;
 *  - the Grocery list covers the tab bar, pads its top with the status-bar
 *    inset and its Add item bar with the home-indicator inset (GAL-10), keeps
 *    a working list on an SE with its status bar, wraps long names instead of
 *    clipping them, wears no emoji, and writes each price in its row's
 *    currency the phone's way (GAL-09); its ticks, tabs, shop picks and aisle
 *    choices are 44 pt targets; the price sheet and the Add form fit, and a
 *    name typed into the Add form is filed in its aisle (GAL-15);
 *  - the Recipe editor's title, Cancel and Continue are on screen;
 *  - Cooking Mode's title and Close clear the status bar, and Complete &
 *    Subtract clears the home indicator (GAL-10);
 *  - nothing scrolls sideways anywhere.
 *
 * A browser draws env(safe-area-inset-*) as 0, so the insets are checked two
 * ways: the padding that must carry them names them, and what a phone's own
 * insets would add still leaves room (`insets` below), with a bottom control
 * placed where the phone draws it (`bottomOnPhone`).
 */

const SIZES = [
    { name: '375x667', width: 375, height: 667, insets: { top: 20, bottom: 0 } },
    { name: '320x568', width: 320, height: 568, insets: { top: 20, bottom: 0 } },
    { name: '390x844', width: 390, height: 844, insets: { top: 47, bottom: 34 } },
];

async function open(page: Page, size: { width: number; height: number }) {
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
    await page.setViewportSize(size);
    await page.goto('/e2e/fixtures/galley-layout.html');
    await page.waitForFunction(
        () => (window as unknown as { __galleyLayoutReady?: boolean }).__galleyLayoutReady,
        undefined,
        { timeout: 25_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { level: 1, name: 'Galley' })).toBeVisible({ timeout: 25_000 });
    return errors;
}

// No text cut off, and nothing scrolling sideways, by the Boat Binder specs'
// own rules (helpers/binderLayout.ts; the Galley is a binder page). The copy
// that stood here counted spoken-only text as cut: an .sr-only element is a
// 1 px box with its overflow hidden on purpose, so VoiceOver reads it and the
// screen does not. That failed the Grocery list on its header's crumb for the
// page's own name ('Grocery list', PageHeader) and the price sheet on the
// price's currency, read with the field ('In Pacific franc …').

/**
 * Where `target`'s bottom edge sits on a phone with a home indicator `inset` px
 * tall. A browser draws env(safe-area-inset-bottom) as 0, so the padding on
 * `bar` that carries the inset is drawn at its floor here (the Grocery list's
 * max(0.75rem, inset): 11.7 px at 390 pt); on the phone it is that padding
 * with the inset put in (34 px), and what sits above it rises by the
 * difference. Adding the whole inset to the browser's figure instead, as this
 * spec first did, put the button where neither a browser nor a phone draws it
 * (Add item at 866 px on an 844 px screen); with the inset put in it ends at
 * 810, on the home indicator's edge, where Chromium's own safe-area emulation
 * (Emulation.setSafeAreaInsetsOverride, 34 px) draws it too.
 */
async function bottomOnPhone(target: Locator, bar: Locator, inset: number): Promise<number> {
    const padded = await bar.elementHandle();
    return target.evaluate(
        (element, { bar, inset }) => {
            const declared = (bar as HTMLElement).style.paddingBottom;
            const probe = document.createElement('div');
            probe.style.paddingBottom = declared.replaceAll('env(safe-area-inset-bottom)', `${inset}px`);
            document.body.append(probe);
            const onPhone = parseFloat(getComputedStyle(probe).paddingBottom);
            probe.remove();
            const here = parseFloat(getComputedStyle(bar as HTMLElement).paddingBottom);
            return element.getBoundingClientRect().bottom - (onPhone - here);
        },
        { bar: padded, inset },
    );
}

/** A 44 pt target (its ::before counts, index.css .hit-target-44), on screen, that a tap at its centre reaches. */
async function expectTapTarget(target: Locator, what: string) {
    await target.scrollIntoViewIfNeeded();
    const m = await target.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const before = getComputedStyle(element, '::before');
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
            w: Math.max(r.width, parseFloat(before.width) || 0),
            h: Math.max(r.height, parseFloat(before.height) || 0),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            W: window.innerWidth,
            H: window.innerHeight,
            reached: !!hit && (hit === element || element.contains(hit)),
        };
    });
    expect(m.w, `${what}: 44 pt wide`).toBeGreaterThanOrEqual(43.5);
    expect(m.h, `${what}: 44 pt tall`).toBeGreaterThanOrEqual(43.5);
    expect(m.left, `${what}: on screen (left)`).toBeGreaterThanOrEqual(-0.5);
    expect(m.right, `${what}: on screen (right)`).toBeLessThanOrEqual(m.W + 0.5);
    expect(m.top, `${what}: on screen (top)`).toBeGreaterThanOrEqual(-0.5);
    expect(m.bottom, `${what}: on screen (bottom)`).toBeLessThanOrEqual(m.H + 0.5);
    expect(m.reached, `a tap on ${what} reaches it`).toBe(true);
}

/** The inline padding that must carry a safe-area inset names it (a browser draws env() as 0). */
async function expectInsetPadding(target: Locator, side: 'top' | 'bottom', what: string) {
    const padding = await target.evaluate(
        (element, edge) => (edge === 'top' ? element.style.paddingTop : element.style.paddingBottom),
        side,
    );
    expect(padding, `${what} pads for the ${side} inset`).toContain(`safe-area-inset-${side}`);
}

async function openGroceryList(page: Page) {
    await page.getByRole('button', { name: /^Open shopping list/ }).click();
    const list = page.getByRole('dialog', { name: 'Shopping list' });
    await expect(list.getByRole('heading', { level: 1, name: 'Grocery list' })).toBeVisible();
    return list;
}

for (const size of SIZES) {
    test(`Galley at ${size.name}: Today and Next first, in eating order, under plain dates`, async ({ page }) => {
        const errors = await open(page, size);
        const panel = page.getByRole('tabpanel', { name: /Active meals/ });
        await expectWideFaceDrawn(panel.getByRole('heading', { level: 3 }).first());

        const sections = await panel.getByRole('heading', { level: 2 }).allTextContents();
        expect(sections.map((text) => text.replace(/\(\d+\)$/, '').trim())).toEqual([
            'Today',
            'Next',
            'Later',
            'Earlier',
        ]);
        const meals = await panel.getByRole('heading', { level: 3 }).allTextContents();
        expect(meals).toEqual([
            'Chowder',
            'Kedgeree',
            'Lentil dal with coconut, lime and far too many chillies for the crew',
            'Porridge',
            'Wraps',
            'Paella for the cockpit',
            'Pasta puttanesca',
        ]);
        await expect(panel.getByText('Yesterday · Lunch · 4 serves')).toBeVisible();
        await expect(panel.getByText('Tomorrow · Breakfast · 4 serves')).toBeAttached();
        expect(await panel.textContent()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        await expect(panel.locator('.h-28')).toHaveCount(0);

        await expectNoClippedText(panel, 'Active meals');
        // And its header: '1 reserved from stores', kept on one line, ran 15 to 74 px off the screen.
        await expectNoClippedText(page.locator('[data-page-header]'), 'the Galley header');
        await expectTapTarget(panel.getByRole('button', { name: 'Resume cooking' }), 'Resume cooking');
        await expectTapTarget(panel.getByRole('button', { name: 'Share Kedgeree' }), 'Share Kedgeree');
        for (const tab of await page.getByRole('tab').all()) await expectTapTarget(tab, 'a Galley tab');

        // GAL-01 still holds: the way into the grocery list ends clear of the tab bar.
        const opener = page.getByRole('button', { name: /^Open shopping list/ });
        await opener.scrollIntoViewIfNeeded();
        const m = await opener.evaluate((button) => ({
            bottom: button.getBoundingClientRect().bottom,
            navTop: document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().top,
        }));
        expect(m.bottom, 'Open shopping list ends above the tab bar').toBeLessThanOrEqual(m.navTop);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Grocery list at ${size.name}: clears the insets, fits, and prices in each row's currency`, async ({
        page,
    }) => {
        const errors = await open(page, size);
        const list = await openGroceryList(page);
        await expectWideFaceDrawn(list.getByRole('heading', { level: 1, name: 'Grocery list' }));

        // Covers the app's tab bar: a full-screen page with its own bottom bar.
        const covers = await page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            const hit = document.elementFromPoint((nav.left + nav.right) / 2, (nav.top + nav.bottom) / 2);
            return !!hit?.closest('[role="dialog"][aria-label="Shopping list"]');
        });
        expect(covers, 'the Grocery list covers the tab bar').toBe(true);

        // GAL-10: the top pads for the status bar, the Add item bar for the home indicator.
        await expectInsetPadding(list, 'top', 'the Grocery list');
        const add = list.getByRole('button', { name: 'Add item' });
        const bar = add.locator('xpath=ancestor::div[contains(@class,"shrink-0")][1]');
        await expectInsetPadding(bar, 'bottom', 'its bottom bar');
        await expectTapTarget(add, 'Add item');
        // Measured once the page has slid into place (index.css .slide-up-enter, 12 px over 350 ms).
        await pageSettled(page);
        const room = await list.evaluate((dialog, insets) => {
            const panel = dialog.querySelector('#grocery-filter-panel')!.getBoundingClientRect();
            return {
                H: window.innerHeight,
                // The status bar's inset pushes the page down by up to max(0, inset - 1rem).
                listHeight: panel.height - Math.max(0, insets.top - 16) - insets.bottom,
            };
        }, size.insets);
        const addBottom = await bottomOnPhone(add, bar, size.insets.bottom);
        expect(addBottom + size.insets.bottom, 'Add item stays above the home indicator').toBeLessThanOrEqual(
            room.H + 0.5,
        );
        expect(room.listHeight, 'the list keeps room for rows').toBeGreaterThanOrEqual(150);

        for (const tab of await list.getByRole('tab').all()) await expectTapTarget(tab, 'a list filter');
        await list.getByRole('tab', { name: /All/ }).click();

        // Names wrap, never clip; every tick is a 44 pt target.
        await expect(list.getByText('Raw-water impeller for the Yanmar 3YM30')).toBeAttached();
        await expectNoClippedText(list, 'the Grocery list');
        for (const name of ['Limes', 'Raw-water impeller for the Yanmar 3YM30', 'Breadcrumbs']) {
            await expectTapTarget(
                list.getByRole('button', { name: `Mark ${name} as purchased` }),
                `the tick for ${name}`,
            );
        }
        await expectTapTarget(list.getByRole('button', { name: 'Undo Milk' }), 'the tick for Milk');

        // GAL-15: the audit's words in the right aisles, as the service files a row given no
        // aisle (the fixture's seeds). A name typed into the Add form is checked in the next test.
        const aisleOf = (name: string) =>
            list
                .getByText(name, { exact: true })
                .evaluate((element) => element.closest('section')!.querySelector('h2')!.textContent);
        expect(await aisleOf('Breadcrumbs')).toMatch(/^Bakery/);
        expect(await aisleOf('Eggplant')).toMatch(/^Produce/);
        expect(await aisleOf('Toilet roll')).toMatch(/^General/);
        expect(await aisleOf('Extra virgin olive oil, cold pressed, the big tin')).toMatch(/^General/);

        // GAL-09: each price in its own row's currency, written the phone's way.
        const written = await page.evaluate(() => ({
            francs: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'XPF' }).format(450),
            dollars: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'AUD' }).format(18.5),
        }));
        const text = (await list.textContent())!.replace(/\s+/g, ' ');
        expect(text).toContain(written.francs.replace(/\s+/g, ' '));
        expect(text).toContain(written.dollars.replace(/\s+/g, ' '));
        expect(text, 'no emoji: line icons').not.toMatch(/\p{Extended_Pictographic}/u);

        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Grocery list at ${size.name}: the price sheet and the Add form fit`, async ({ page }) => {
        const errors = await open(page, size);
        const list = await openGroceryList(page);

        await list.getByRole('button', { name: 'Mark Limes as purchased' }).click();
        const sheet = page.getByRole('dialog', { name: /Mark as purchased/ });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole('spinbutton', { name: 'Price (optional)' })).toBeFocused();
        // Quick picks are the shops this phone has used, latest first: never Coles for everyone.
        const shops = sheet.getByRole('group', { name: 'Shops used lately' });
        await expect(shops.getByRole('button')).toHaveText(['Talamahu Market', 'Countdown Westhaven']);
        for (const shop of await shops.getByRole('button').all()) await expectTapTarget(shop, 'a shop pick');
        await expectTapTarget(
            sheet.getByRole('button', { name: 'Skip price and mark Limes as purchased' }),
            'Skip price',
        );
        await expectTapTarget(sheet.getByRole('button', { name: 'Confirm purchase of Limes' }), 'Confirm');
        await expectTapTarget(sheet.getByRole('button', { name: 'Cancel marking Limes as purchased' }), 'Close');
        await expectNoClippedText(sheet, 'the price sheet');
        await expectNothingSideways(page);
        await sheet.getByRole('button', { name: 'Cancel marking Limes as purchased' }).click();
        await expect(sheet).toHaveCount(0);

        await list.getByRole('button', { name: 'Add item' }).click();
        const form = page.getByRole('dialog', { name: /Add to shopping list/ });
        await expect(form).toBeVisible();
        const aisles = form.getByRole('group', { name: 'Aisle' });
        await expect(aisles.getByRole('button')).toHaveCount(9);
        for (const aisle of await aisles.getByRole('button').all()) await expectTapTarget(aisle, 'an aisle choice');
        await expectTapTarget(form.getByRole('button', { name: 'Add item to grocery list' }), 'Add to list');
        await expectNoClippedText(form, 'the Add form');
        expect((await form.textContent()) ?? '', 'no emoji: line icons').not.toMatch(/\p{Extended_Pictographic}/u);
        await expectNothingSideways(page);

        // GAL-15 by the skipper's own hand: a typed name lights its aisle and is filed there.
        await form.getByRole('textbox', { name: 'Item name' }).fill('Japanese eggplants');
        await expect(aisles.getByRole('button', { name: 'Produce' })).toHaveAttribute('aria-pressed', 'true');
        await expect(aisles.getByRole('button', { name: 'Dairy' })).toHaveAttribute('aria-pressed', 'false');
        await form.getByRole('button', { name: 'Add item to grocery list' }).click();
        await expect(form).toHaveCount(0);
        const added = list.getByText('Japanese eggplants', { exact: true });
        await expect(added).toBeVisible();
        expect(await added.evaluate((element) => element.closest('section')!.querySelector('h2')!.textContent)).toMatch(
            /^Produce/,
        );
        expect(errors).toEqual([]);
    });

    test(`Recipe editor at ${size.name}: its title, Cancel and Continue are on screen`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('tab', { name: /Saved recipes/ }).click();
        await page.getByRole('button', { name: 'New recipe' }).click();
        const editor = page.getByRole('dialog', { name: 'NEW RECIPE' });
        await expect(editor).toBeVisible();
        await expectNoClippedText(editor.getByRole('heading', { name: 'NEW RECIPE' }), 'the editor title');
        await expectTapTarget(editor.getByRole('button', { name: 'Cancel recipe creation' }), 'Cancel');
        const go = editor.getByRole('button', { name: 'Continue to step 2' });
        const m = await go.evaluate((button) => {
            const r = button.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, H: window.innerHeight, h: r.height };
        });
        expect(m.top, 'Continue is on screen').toBeGreaterThanOrEqual(0);
        expect(m.bottom, 'Continue is on screen').toBeLessThanOrEqual(m.H + 0.5);
        expect(m.h, 'Continue is 44 pt tall').toBeGreaterThanOrEqual(43.5);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Cooking Mode at ${size.name}: clear of the status bar and the home indicator`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: 'Cook now' }).first().click();
        const cooking = page.getByRole('dialog', { name: /Cooking Mode/ });
        await expect(cooking).toBeVisible();

        const close = cooking.getByRole('button', { name: 'Close cooking mode' });
        await expectInsetPadding(
            close.locator('xpath=ancestor::div[contains(@class,"border-b")][1]'),
            'top',
            'its header',
        );
        await expectTapTarget(close, 'Close');
        await expectNoClippedText(close.locator('xpath=ancestor::div[contains(@class,"border-b")][1]'), 'its header');

        await cooking.getByRole('button', { name: /Start Cooking/ }).click();
        const steps = cooking.getByRole('button', { name: /^Mark complete:/ });
        await expect(steps.first()).toBeVisible();
        await expectInsetPadding(steps.first().locator('xpath=..'), 'bottom', 'the steps');
        while ((await steps.count()) > 0) await steps.first().click();

        const complete = cooking.getByRole('button', { name: /Complete & Subtract from Stores/ });
        await expect(complete).toBeVisible();
        const panel = complete.locator('xpath=..');
        await expectInsetPadding(panel, 'bottom', 'the Complete & Subtract panel');
        const bottom = await bottomOnPhone(complete, panel, size.insets.bottom);
        expect(bottom + size.insets.bottom, 'Complete & Subtract stays above the home indicator').toBeLessThanOrEqual(
            await page.evaluate(() => window.innerHeight + 0.5),
        );
        await expectTapTarget(cooking.getByRole('button', { name: 'Decrease servings consumed' }), 'Fewer servings');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });
}
