import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * Move anchor (build 123, must-do #3): "Anchor is [33] m from the boat,
 * bearing [212] °T", on a fixture page with the app's tab bar, real CSS and a
 * simulated keyboard (e2e/fixtures/move-anchor.tsx). House rules measured, not
 * assumed: a centred card, clear of the tab bar (and of the keyboard when it is
 * up), with both fields, the live check and both buttons whole and tappable.
 *
 * Wide fonts throughout (Verdana on a Mac, DejaVu Sans on the Linux runner, the
 * face CI actually draws system-ui with), so a Mac run wraps text no narrower
 * than CI does. At ordinary text the card fits one screen outright at 320 px,
 * at 390 px and in landscape. At large text it may scroll inside itself as a
 * last resort (the modal rule, 2026-08-31), and then every field, the live
 * check and both buttons must still be reachable, never clipped or under the
 * tab bar or the keyboard.
 *
 * Build 125 (125-03): the same sheet opened from the ALARM screen
 * (?alarm). It opens over the real alarm overlay (both on the critical layer),
 * carries one more line ("Only move it if you're sure the anchor hasn't
 * moved") and a longer button, and must still fit 320 x 568 in wide fonts with
 * the keyboard up, with nothing of the alarm screen covering its controls.
 * So must its longest refusal (&restarted: the app restarted, so the phone has
 * only minutes of her track before the alarm).
 *
 * Build 126 (126-07b): the Position tab, one field for a typed position and a
 * readback under it, at every size, keyboard up and down, from the alarm too;
 * the tab row steps aside while the keyboard is up. And a real drag of the
 * anchor on the preview, which fills Position and moves nothing until Move.
 *
 * Build 126 (126-07c): a watch marked by the boat's own GPS with its antenna
 * 12 m aft of the bow (&antenna): a longer prefill and one more clause in the
 * hint, at 320 x 568, ordinary and large text.
 *
 * Build 126 (126-07d): one more line under the live check, from the real
 * chart-area check. With no chart cell (every case below, the network off) it
 * says "No chart areas loaded here…" where there is room (not on a short
 * portrait screen), so the From the boat, Position and Pi cases are measured
 * with it; from the alarm it says nothing. &area=cable charts
 * a fictional cable area at the point: "That point is inside a submarine cable
 * area (official chart).", shown with the keyboard down, stepped aside with it
 * up, and Move still moves. &area=worst is the longest line the sheet can say
 * (the short form: "a submarine cable area: anchoring prohibited (official
 * chart). And 1 more."), and &area=park the atlas path with a name and clause
 * as long as any shipped, which the sheet leaves to the page's note ("a
 * no-anchoring area (GBRMPA, CC BY)"): each fits 320 x 568 and 844 x 390
 * landscape outright at ordinary text (126-07d review: the full wording did
 * not).
 */

const sizes = [
    { name: '320x568', width: 320, height: 568, keyboard: 253, query: '', mayScroll: false },
    { name: '390x844', width: 390, height: 844, keyboard: 344, query: '', mayScroll: false },
    { name: '844x390 landscape', width: 844, height: 390, keyboard: 200, query: '', mayScroll: false },
    { name: 'large text 390x844', width: 390, height: 844, keyboard: 344, query: 'largeText', mayScroll: true },
    { name: 'large text 320x568', width: 320, height: 568, keyboard: 253, query: 'largeText', mayScroll: true },
];

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    // The house wide-font rule: the Linux CI runner draws the app's sans face
    // as DejaVu Sans, far wider than a Mac's; Verdana stands in for it here.
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/move-anchor.html${query ? `?${query}` : ''}`);
    await expect(page.getByRole('button', { name: 'Open Move anchor' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Open Move anchor' }).click();
    await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeVisible();
    // 126-07d: the chart-area line lands once the point has settled (400 ms and
    // the check): every case is measured with it there.
    await expect(page.getByTestId('move-anchor-area')).toBeAttached();
    return errors;
}

/** The sheet's live check (the fixture's own <output> is a status too). */
const liveCheck = (page: Page) => page.getByRole('dialog', { name: 'Move anchor' }).getByRole('status');

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
}

/**
 * Every geometric house rule, measured in the page. Returns what broke.
 * `mayScroll`: the card may scroll inside itself (large text); each control is
 * then scrolled into view in turn, as a skipper would, and must be whole there.
 */
function layoutIssues(page: Page, keyboardHeight: number, mayScroll = false, fields = 2) {
    return page.evaluate(
        ({ kb, mayScroll, fields }) => {
            const issues: string[] = [];
            const W = window.innerWidth;
            const H = window.innerHeight;
            const card = document.querySelector<HTMLElement>('[data-move-anchor-sheet]');
            const overlay = card?.parentElement;
            if (!card || !overlay) return ['no dialog'];
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            // The keyboard covers the tab bar when it is up; otherwise the tab bar is the floor.
            const floor = kb ? H - kb : nav.top;
            const box = card.getBoundingClientRect();

            if (Math.abs(box.left - (W - box.right)) > 1)
                issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
            const style = getComputedStyle(overlay);
            const bandTop = parseFloat(style.paddingTop);
            const bandBottom = H - parseFloat(style.paddingBottom) - kb;
            const middle = (box.top + box.bottom) / 2;
            if (Math.abs(middle - (bandTop + bandBottom) / 2) > 1)
                issues.push(
                    `not centred in its band: ${middle.toFixed(1)} vs ${((bandTop + bandBottom) / 2).toFixed(1)}`,
                );
            if (box.top < 0) issues.push(`card starts above the screen (${box.top})`);
            if (box.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${box.bottom} > ${nav.top})`);
            if (box.bottom > floor + 0.5) issues.push(`card runs under the keyboard (${box.bottom} > ${floor})`);

            // One screen: nothing inside the card is scrolled out of sight. Where it
            // may scroll, the scroller must be the card itself, never clipping.
            if (!mayScroll && card.scrollHeight > card.clientHeight + 1)
                issues.push(`card content is cut off (${card.scrollHeight} > ${card.clientHeight})`);
            if (mayScroll && card.scrollHeight > card.clientHeight + 1 && getComputedStyle(card).overflowY !== 'auto')
                issues.push(`card content is clipped, not scrollable (${getComputedStyle(card).overflowY})`);
            // The field being typed in is in view above the keyboard without the
            // skipper scrolling for it (the app-wide keyboard guard's job).
            const focused = document.activeElement as HTMLElement | null;
            if (kb && focused?.tagName === 'INPUT') {
                const rect = focused.getBoundingClientRect();
                if (rect.top < box.top - 0.5 || rect.bottom > Math.min(floor, box.bottom) + 0.5)
                    issues.push('the focused field is not in view above the keyboard');
            }
            // Measuring scrolls the card; put it back after, so the next look sees
            // what the skipper sees.
            const scrolledTo = card.scrollTop;
            /** In view, scrolling the card to it first where the card may scroll. */
            const reach = (element: HTMLElement) => {
                if (mayScroll) element.scrollIntoView({ block: 'nearest' });
                return element.getBoundingClientRect();
            };
            if (card.scrollWidth > card.clientWidth + 1) issues.push('card overflows sideways');
            if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
            for (const element of card.querySelectorAll<HTMLElement>('*')) {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height) continue;
                if (rect.left < box.left - 1 || rect.right > box.right + 1)
                    issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 20)}" escapes the card`);
            }

            const status = card.querySelector<HTMLElement>('[role="status"]')!;
            const statusBox = reach(status);
            if (statusBox.top < box.top - 0.5 || statusBox.bottom > Math.min(floor, box.bottom) + 0.5)
                issues.push('the live check is not fully visible');
            // 126-07d: the chart-area line, where it is shown, is read whole.
            const area = card.querySelector<HTMLElement>('[data-testid="move-anchor-area"]');
            if (area && area.getClientRects().length > 0 && getComputedStyle(area).visibility !== 'hidden') {
                const areaBox = reach(area);
                if (areaBox.top < box.top - 0.5 || areaBox.bottom > Math.min(floor, box.bottom) + 0.5)
                    issues.push('the chart-area line is not fully visible');
                if (areaBox.left < box.left - 0.5 || areaBox.right > box.right + 0.5)
                    issues.push('the chart-area line runs out of the card');
            }
            // 126-07b: a typed position's readback is read with the field, keyboard up or down.
            const readback = card.querySelector<HTMLElement>('[data-testid="move-anchor-readback"]');
            if (readback) {
                const readbackBox = reach(readback);
                if (readbackBox.top < box.top - 0.5 || readbackBox.bottom > Math.min(floor, box.bottom) + 0.5)
                    issues.push('the readback is not fully visible');
            }

            const controls = [...card.querySelectorAll<HTMLElement>('button, input')].filter(
                (element) => element.getClientRects().length > 0,
            );
            if (controls.filter((element) => element.tagName === 'INPUT').length !== fields)
                issues.push(`${fields} fields expected`);
            for (const element of controls) {
                const rect = reach(element);
                const name = element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName;
                if (rect.height < 43.5) issues.push(`${name}: ${rect.height}px tall`);
                // A button's own words stay inside it (126-07b: the tabs, at large text).
                if (element.tagName === 'BUTTON' && element.scrollWidth > element.clientWidth + 1)
                    issues.push(`${name}: its label runs out of the button`);
                if (
                    rect.top < Math.max(0, box.top) - 0.5 ||
                    rect.bottom > Math.min(floor, box.bottom) + 0.5 ||
                    rect.left < box.left - 0.5 ||
                    rect.right > box.right + 0.5
                )
                    issues.push(`${name} is not fully visible`);
                const inset = Math.min(4, rect.height / 3);
                const midX = (rect.left + rect.right) / 2;
                const midY = (rect.top + rect.bottom) / 2;
                for (const [x, y] of [
                    [midX, midY],
                    [midX, rect.top + inset],
                    [midX, rect.bottom - inset],
                    [rect.left + inset, midY],
                    [rect.right - inset, midY],
                ]) {
                    const hit = document.elementFromPoint(x, y);
                    if (!(hit === element || element.contains(hit)))
                        issues.push(
                            `${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}.${String(hit?.className).slice(0, 40)}`,
                        );
                }
            }
            card.scrollTop = scrolledTo;
            return issues;
        },
        { kb: keyboardHeight, mayScroll, fields },
    );
}

async function expectLayout(page: Page, keyboardHeight: number, mayScroll = false, fields = 2) {
    // The keyboard guard settles over a few frames; the final geometry is what counts.
    await expect.poll(() => layoutIssues(page, keyboardHeight, mayScroll, fields), { timeout: 3_000 }).toEqual([]);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    test(`Move anchor fits ${size.name}, with the fields above the keyboard`, async ({ page }, info) => {
        const errors = await open(page, size, size.query);
        const label = `${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        const bearing = page.getByRole('textbox', { name: /bearing from the boat to the anchor/i });
        // 40 m of chain in 8 m: a 39 m reach less its sag, 33 m, inside the 43 m circle.
        await expect(distance).toHaveValue('33');
        await expect(bearing).toHaveValue('212');
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        // No chart cell here (126-07d): said, so a silence is never read as clear,
        // where there is room; a short portrait screen (320 x 568) has none.
        const coverage = page.getByTestId('move-anchor-area');
        await expect(coverage).toHaveText('No chart areas loaded here to check the point against.');
        if (size.height > 600 || size.width > size.height) await expect(coverage).toBeVisible();
        else await expect(coverage).toBeHidden();
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll);

        await distance.click();
        await keyboard(page, size.keyboard);
        await expect(distance).toBeFocused();
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll);

        // Outside the circle: the refusal is in reach with the keyboard still up.
        await distance.focus();
        await distance.fill('60');
        await expect(liveCheck(page)).toContainText('outside your 43 m circle');
        await expect(page.getByRole('button', { name: 'Move anchor', exact: true })).toBeDisabled();
        await expectLayout(page, size.keyboard, size.mayScroll);

        await distance.fill('25');
        await page.getByRole('button', { name: 'Move anchor', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('moved');
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __moveAnchorFixture: { moves: unknown[] } }).__moveAnchorFixture.moves
                        .length,
            ),
        ).toBe(1);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

// 126-07c: marked by the boat's own GPS, its antenna 12 m aft of the bow. The
// distance is her lie plus the 12 m, and the hint says so in one more clause:
// the sheet still fits 320 x 568 outright, keyboard up and down, and at large
// text it scrolls inside itself with everything in reach.
for (const size of sizes.filter((entry) => entry.width === 320)) {
    test(`A boat GPS 12 m aft of the bow: the longer prefill and hint fit ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, `antenna${size.query ? `&${size.query}` : ''}`);
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        await expect(distance).toHaveValue('45');
        await expect(page.getByTestId('move-anchor-hint')).toContainText('plus 12 m from the GPS to the bow.');
        await expect(liveCheck(page)).toContainText('inside your 55 m circle');
        await expectLayout(page, 0, size.mayScroll);
        await distance.click();
        await keyboard(page, size.keyboard);
        await expectLayout(page, size.keyboard, size.mayScroll);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

// 126-07d: a charted area at the new point (a synthetic cell, or the atlas's
// files stood in for, on the fixture page, through the real check, store and
// index). One line under the live check, the sheet still fits 320 x 568 and
// 844 x 390 landscape (outright at ordinary text), the line steps aside while
// the keyboard is up and comes back with it down, and Move still moves: it is
// said, never a block.
const areaLines = {
    cable: 'That point is inside a submarine cable area (official chart).',
    worst: 'That point is inside a submarine cable area: anchoring prohibited (official chart). And 1 more.',
    park: 'That point is inside a no-anchoring area (GBRMPA, CC BY).',
} as const;
for (const size of sizes.filter((entry) => entry.width === 320 || entry.height === 390)) {
    for (const [area, words] of Object.entries(areaLines)) {
        test(`A ${area} area at the point: one line, and the sheet fits ${size.name}, keyboard up and down`, async ({
            page,
        }, info) => {
            const errors = await open(page, size, [`area=${area}`, size.query].filter(Boolean).join('&'));
            const label = `${area}-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
            const line = page.getByTestId('move-anchor-area');
            await expect(line).toHaveText(words);
            await expect(line).toBeVisible();
            const move = page.getByRole('button', { name: 'Move anchor', exact: true });
            await expect(move).toBeEnabled();
            await screenshot(page, info, `move-anchor-area-${label}`);
            await expectLayout(page, 0, size.mayScroll);

            const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
            await distance.click();
            await keyboard(page, size.keyboard);
            await expect(line).toBeHidden();
            await screenshot(page, info, `move-anchor-area-keyboard-${label}`);
            await expectLayout(page, size.keyboard, size.mayScroll);

            await keyboard(page, 0);
            await expect(line).toBeVisible();
            await expectLayout(page, 0, size.mayScroll);
            await move.click();
            await expect(page.getByTestId('outcome')).toHaveText('moved');
            expect(errors).toEqual([]);
        });
    }
}

test('feet skippers see feet, and Escape closes without moving anything', async ({ page }) => {
    await open(page, sizes[1], 'units=ft');
    // 33.3 m = 109 ft, inside the 43.3 m = 142 ft circle.
    await expect(page.getByRole('textbox', { name: /in feet/i })).toHaveValue('109');
    await expect(liveCheck(page)).toContainText('inside your 142 ft circle');
    await expectLayout(page, 0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
    await expect(page.getByTestId('outcome')).toHaveText('waiting');
});

const alarmSizes = sizes.filter((size) => size.width === 320 || size.name === '844x390 landscape');

/** The alarm screen's own two buttons, whole and tappable, before the sheet opens. */
function alarmButtonsIssues(page: Page) {
    return page.evaluate(() => {
        const issues: string[] = [];
        const overlay = document.querySelector<HTMLElement>('[role="alertdialog"]');
        if (!overlay) return ['no alarm screen'];
        for (const name of ['Acknowledge Alarm', 'Move anchor']) {
            const button = [...overlay.querySelectorAll<HTMLElement>('button')].find(
                (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === name,
            );
            if (!button) {
                issues.push(`${name}: missing`);
                continue;
            }
            const rect = button.getBoundingClientRect();
            if (rect.height < 43.5) issues.push(`${name}: ${rect.height}px tall`);
            if (rect.top < 0 || rect.bottom > window.innerHeight + 0.5) issues.push(`${name} is off screen`);
            const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
            if (!(hit === button || button.contains(hit))) issues.push(`${name} is covered by ${hit?.tagName}`);
        }
        return issues;
    });
}

async function openFromAlarm(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/move-anchor.html?alarm${query ? `&${query}` : ''}`);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => alarmButtonsIssues(page), { timeout: 3_000 }).toEqual([]);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Move anchor', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeVisible();
    return errors;
}

for (const size of alarmSizes) {
    test(`From the alarm: Move anchor fits ${size.name} over the alarm screen, keyboard up and down`, async ({
        page,
    }, info) => {
        const errors = await openFromAlarm(page, size, size.query);
        const label = `alarm-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        const stop = page.getByRole('button', { name: 'Move and stop alarm', exact: true });
        await expect(distance).toHaveValue('33');
        await expect(page.getByTestId('move-anchor-caution')).toContainText(/sure the anchor hasn.t moved/i);
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        await expect(liveCheck(page)).toContainText(/fits a swing/i);
        await expect(stop).toBeEnabled();
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll);

        await distance.click();
        await keyboard(page, size.keyboard);
        await expect(distance).toBeFocused();
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll);

        await distance.fill('60');
        await expect(liveCheck(page)).toContainText('outside your 43 m circle');
        await expect(stop).toBeDisabled();
        await expectLayout(page, size.keyboard, size.mayScroll);

        // 13 m short of the real anchor: her distance from that point changed
        // through the swing, as a drag's would. The verdict's first sentence
        // stays on screen with the keyboard up.
        await distance.fill('20');
        await expect(liveCheck(page)).toContainText(/has been changing, the way a drag does/i);
        await expect(stop).toBeDisabled();
        await expectLayout(page, size.keyboard, size.mayScroll);
        await keyboard(page, 0);
        await expect(liveCheck(page)).toContainText(/re-anchor/i);
        await expectLayout(page, 0, size.mayScroll);
        await distance.click();
        await keyboard(page, size.keyboard);

        await distance.fill('33');
        await expect(stop).toBeEnabled();
        await stop.click();
        await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('moved');
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __moveAnchorFixture: { moves: unknown[] } }).__moveAnchorFixture.moves
                        .length,
            ),
        ).toBe(1);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

for (const size of alarmSizes.filter((s) => s.width === 320)) {
    test(`From the alarm: the longest refusal fits ${size.name}, keyboard up and down`, async ({ page }, info) => {
        const errors = await openFromAlarm(page, size, ['restarted', size.query].filter(Boolean).join('&'));
        const label = `alarm-refused-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        const stop = page.getByRole('button', { name: 'Move and stop alarm', exact: true });
        await expect(distance).toHaveValue('33');
        await expect(liveCheck(page)).toContainText(/only 4 min of her track before the alarm/i);
        await expect(liveCheck(page)).toContainText(/re-anchor/i);
        await expect(stop).toBeDisabled();
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll);

        await distance.click();
        await keyboard(page, size.keyboard);
        await expect(distance).toBeFocused();
        await expect(liveCheck(page)).toContainText(/only 4 min/i);
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __moveAnchorFixture: { moves: unknown[] } }).__moveAnchorFixture.moves
                        .length,
            ),
        ).toBe(0);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

// 126-07a: the same sheet for the watch the PI keeps (?mode=pi), opened from
// Shore Watch on the phone that handed the watch over. Filled from the Pi's
// report (the same Marseille watch: 40 m in 8 m, a 43 m circle), with the same
// sizes, keyboard up and down. Move hands the point to the Pi; the fixture's
// Pi says yes and its report shows the new point a second later.
for (const size of sizes) {
    test(`Pi watch: Move anchor fits ${size.name}, with the fields above the keyboard`, async ({ page }, info) => {
        const errors = await open(page, size, ['mode=pi', size.query].filter(Boolean).join('&'));
        const label = `pi-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        const bearing = page.getByRole('textbox', { name: /bearing from the boat to the anchor/i });
        await expect(distance).toHaveValue('33');
        await expect(bearing).toHaveValue('212');
        await expect(page.getByTestId('move-anchor-hint')).toContainText('via the Pi');
        await expect(page.getByTestId('move-anchor-caution')).toHaveCount(0);
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll);

        await distance.click();
        await keyboard(page, size.keyboard);
        await expect(distance).toBeFocused();
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll);

        await distance.fill('60');
        await expect(liveCheck(page)).toContainText('outside your 43 m circle');
        await expect(page.getByRole('button', { name: 'Move anchor', exact: true })).toBeDisabled();
        await expectLayout(page, size.keyboard, size.mayScroll);

        await distance.fill('25');
        await page.getByRole('button', { name: 'Move anchor', exact: true }).click();
        await expect(liveCheck(page)).toContainText('Sent to the Pi…');
        await expectLayout(page, size.keyboard, size.mayScroll);
        // The Pi's next report shows the new point: moved, and the sheet closes.
        await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('moved');
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __moveAnchorFixture: { moves: unknown[] } }).__moveAnchorFixture.moves
                        .length,
            ),
        ).toBe(1);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

// From ashore (&ashore=1) the sheet adds 125-03's caution, and the heading
// comes via the cloud: it must still fit the smallest phone, keyboard up and down.
for (const size of sizes.filter((s) => s.width === 320)) {
    test(`Pi watch from ashore: the caution fits ${size.name}, keyboard up and down`, async ({ page }, info) => {
        const errors = await open(page, size, ['mode=pi&ashore=1', size.query].filter(Boolean).join('&'));
        const label = `pi-ashore-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        await expect(page.getByTestId('move-anchor-caution')).toContainText(/sure the anchor hasn.t moved/i);
        await expect(page.getByTestId('move-anchor-hint')).toContainText('via the cloud');
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll);
        const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
        await distance.click();
        await keyboard(page, size.keyboard);
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll);
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

// The longest lines the sheet says after Move: no answer at all, and a refusal.
for (const answer of ['unknown', 'refused']) {
    for (const size of sizes.filter((s) => s.width === 320)) {
        test(`Pi watch: "${answer}" fits ${size.name}, keyboard up and down`, async ({ page }) => {
            const errors = await open(
                page,
                size,
                [`mode=pi&ashore=1&piAnswer=${answer}`, size.query].filter(Boolean).join('&'),
            );
            const distance = page.getByRole('textbox', { name: /distance from the boat to the anchor/i });
            await distance.click();
            await keyboard(page, size.keyboard);
            await page.getByRole('button', { name: 'Move anchor', exact: true }).click();
            await expect(liveCheck(page)).toContainText(
                answer === 'unknown' ? /didn.t answer/ : /still watching the old point/,
            );
            await expectLayout(page, size.keyboard, size.mayScroll);
            await keyboard(page, 0);
            await expect(liveCheck(page)).toContainText(
                answer === 'unknown' ? /Shore Watch will show which within a minute/ : /Nothing was moved/,
            );
            await expectLayout(page, 0, size.mayScroll);
            // Still open, nothing claimed: the skipper can try again or close it.
            await expect(page.getByTestId('outcome')).toHaveText('waiting');
            expect(errors).toEqual([]);
        });
    }
}

// 126-07b: the Position tab (the fixture's ?how=position, opened by its tab, as
// a skipper would). The position typed is the real anchor's, 33 m at 212° from
// the boat, as a plotter shows it.
const ANCHOR_HERE = '43 17.685 N 5 21.587 E';
const movesMade = (page: Page) =>
    page.evaluate(
        () =>
            (window as unknown as { __moveAnchorFixture: { moves: Array<[number, number]> } }).__moveAnchorFixture
                .moves,
    );
const positionTab = (page: Page) => page.getByRole('button', { name: 'Position', exact: true });
const positionField = (page: Page) => page.getByRole('textbox', { name: /^anchor at/i });

for (const size of sizes) {
    test(`Position: Move anchor fits ${size.name}, with the field and its readback above the keyboard`, async ({
        page,
    }, info) => {
        const errors = await open(page, size, size.query);
        const label = `position-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        await positionTab(page).click();
        await expect(positionTab(page)).toHaveAttribute('aria-pressed', 'true');
        await expect(liveCheck(page)).toContainText(/type the anchor.s position/i);
        await expectLayout(page, 0, size.mayScroll, 1);

        await positionField(page).click();
        await keyboard(page, size.keyboard);
        await expect(positionField(page)).toBeFocused();
        // The choice was made before typing: the tab row steps aside for the keyboard.
        await expect(positionTab(page)).toBeHidden();
        await positionField(page).fill(ANCHOR_HERE);
        await expect(page.getByTestId('move-anchor-readback')).toHaveText('Reads as 43°17.685′N 005°21.587′E');
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll, 1);

        // The longest thing it says to an entry it cannot read.
        await positionField(page).fill('48,85,2,35');
        await expect(liveCheck(page)).toContainText(/isn.t a position I can read: try 16 46\.8 S 179 20\.1 E/);
        await expect(page.getByRole('button', { name: 'Move anchor', exact: true })).toBeDisabled();
        await expectLayout(page, size.keyboard, size.mayScroll, 1);

        await positionField(page).fill(ANCHOR_HERE);
        await keyboard(page, 0);
        await expect(positionTab(page)).toBeVisible();
        await screenshot(page, info, `move-anchor-${label}`);
        await expectLayout(page, 0, size.mayScroll, 1);
        await page.getByRole('button', { name: 'Move anchor', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Move anchor' })).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('moved');
        const moves = await movesMade(page);
        expect(moves).toHaveLength(1);
        expect(moves[0][0]).toBeCloseTo(43 + 17.685 / 60, 9);
        expect(moves[0][1]).toBeCloseTo(5 + 21.587 / 60, 9);
        expect(errors).toEqual([]);
    });
}

test('A real drag of the anchor on the preview fills Position, and nothing moves until Move', async ({
    page,
}, info) => {
    const errors = await open(page, sizes[1], '');
    const preview = page.getByRole('img', { name: /preview of the swing circle/i });
    const box = (await preview.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // A touch beside the anchor, not on it, does nothing.
    await page.mouse.move(cx + 60, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy, { steps: 4 });
    await page.mouse.up();
    await expect(positionTab(page)).toHaveAttribute('aria-pressed', 'false');

    // On the anchor, 30 px east: about 19 m on this preview's 43 m circle.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy, { steps: 6 });
    await expect(liveCheck(page)).toContainText('inside your 43 m circle');
    await page.mouse.up();

    await expect(positionTab(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('move-anchor-readback')).toHaveText(/^Reads as 43°17\.\d{3}′N 005°21\.\d{3}′E$/);
    await expect(positionField(page)).toHaveValue(/^43°17\.\d{3}′N 005°21\.\d{3}′E$/);
    await expect(liveCheck(page)).toContainText('inside your 43 m circle');
    await screenshot(page, info, 'move-anchor-dragged-390x844');
    await expectLayout(page, 0, false, 1);
    expect(await movesMade(page)).toHaveLength(0);

    await page.getByRole('button', { name: 'Move anchor', exact: true }).click();
    await expect(page.getByTestId('outcome')).toHaveText('moved');
    const moves = await movesMade(page);
    expect(moves).toHaveLength(1);
    // East of where From the boat had it (33 m at 212° from the boat), by the drag.
    const [lat, lon] = moves[0];
    const was = { lat: 43.294745931763735, lon: 5.359781874760074 };
    const eastM = (lon - was.lon) * 111_320 * Math.cos((was.lat * Math.PI) / 180);
    const northM = (lat - was.lat) * 110_540;
    expect(eastM).toBeGreaterThan(12);
    expect(eastM).toBeLessThan(26);
    expect(Math.abs(northM)).toBeLessThan(3);
    expect(errors).toEqual([]);
});

for (const size of alarmSizes.filter((s) => s.width === 320)) {
    test(`From the alarm: Position fits ${size.name}, keyboard up and down`, async ({ page }, info) => {
        const errors = await openFromAlarm(page, size, size.query);
        const label = `alarm-position-${size.width}x${size.height}${size.query ? '-large-text' : ''}`;
        await positionTab(page).click();
        await expect(page.getByTestId('move-anchor-caution')).toContainText(/sure the anchor hasn.t moved/i);
        await expectLayout(page, 0, size.mayScroll, 1);
        await positionField(page).click();
        await keyboard(page, size.keyboard);
        await positionField(page).fill(ANCHOR_HERE);
        await expect(page.getByTestId('move-anchor-readback')).toHaveText('Reads as 43°17.685′N 005°21.587′E');
        await expect(liveCheck(page)).toContainText('inside your 43 m circle');
        await screenshot(page, info, `move-anchor-keyboard-${label}`);
        await expectLayout(page, size.keyboard, size.mayScroll, 1);
        await keyboard(page, 0);
        await expectLayout(page, 0, size.mayScroll, 1);
        expect(await movesMade(page)).toHaveLength(0);
        expect(errors).toEqual([]);
    });
}

// 126-07d: the longest area line where the sheet is fullest: from the alarm
// (its caution and longer button), From the boat and then on the Position tab,
// at 320 x 568 and in a short landscape band, where the hint gives the warning
// its place (from the alarm at 320 x 568 the sheet had none to spare).
for (const size of alarmSizes.filter((s) => !s.query)) {
    test(`The longest area line fits ${size.name} from the alarm, From the boat and on Position`, async ({
        page,
    }, info) => {
        const errors = await openFromAlarm(page, size, 'area=worst');
        const label = `${size.width}x${size.height}`;
        const line = page.getByTestId('move-anchor-area');
        await expect(line).toHaveText(areaLines.worst);
        await expect(line).toBeVisible();
        await expect(page.getByTestId('move-anchor-caution')).toBeVisible();
        await screenshot(page, info, `move-anchor-area-alarm-${label}`);
        await expectLayout(page, 0, size.mayScroll);

        await positionTab(page).click();
        await positionField(page).click();
        await keyboard(page, size.keyboard);
        await positionField(page).fill(ANCHOR_HERE);
        await expect(page.getByTestId('move-anchor-readback')).toHaveText('Reads as 43°17.685′N 005°21.587′E');
        await expect(line).toBeHidden();
        await expectLayout(page, size.keyboard, size.mayScroll, 1);
        await keyboard(page, 0);
        await expect(line).toHaveText(areaLines.worst);
        await expect(line).toBeVisible();
        await screenshot(page, info, `move-anchor-area-alarm-position-${label}`);
        await expectLayout(page, 0, size.mayScroll, 1);
        expect(await movesMade(page)).toHaveLength(0);
        expect(errors).toEqual([]);
    });
}
