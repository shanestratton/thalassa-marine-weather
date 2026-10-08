import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The Log's "Following a route?" sheet with build 124's three-state rows
 * (green / amber "Check now" / red "Tap again to follow anyway"), measured
 * with the real components and CSS on a fixture page that carries the app's
 * header and tab bar (e2e/fixtures/follow-route-sheet.tsx). House rules,
 * measured rather than assumed: centred in the modal band below the status
 * bar and clear of the tab bar, the title and "Just recording" always in
 * view, every button at least 44 pt tall and hit-testable, nothing escaping
 * sideways — in wide fonts (Verdana here, DejaVu Sans on CI). A Solent
 * passage's three legs plus a day sail list WITHOUT scrolling from 375 × 667
 * up; at 320 × 568 the whole passage is in view and the day sail is one
 * scroll away inside the card (the house modal rule: internal scroll).
 *
 * Safe areas: test browsers report env() as 0, so ?safe= applies the insets
 * the phone each size stands for to the overlay's own formula.
 */

const sizes = [
    { name: '320x568 (SE, 1st gen)', width: 320, height: 568, safe: '20,0', listMayScroll: true },
    { name: '375x667 (SE)', width: 375, height: 667, safe: '20,0', listMayScroll: false },
    { name: '390x844 (notched)', width: 390, height: 844, safe: '47,34', listMayScroll: false },
];

async function open(page: Page, size: { width: number; height: number; safe: string }, extra = '') {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/follow-route-sheet.html?safe=${size.safe}${extra}`);
    const title = page.locator('#follow-route-prompt-title');
    await expect(title).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectWideFaceDrawn(title);
    return errors;
}

/** Every geometric rule, measured in the page. Returns what broke. */
function layoutIssues(page: Page, safe: string, listMayScroll: boolean, wholePassage = true) {
    return page.evaluate(
        ({ safeInsets, mayScroll, passage }) => {
            const [safeTop] = safeInsets.split(',').map(Number);
            const issues: string[] = [];
            const W = window.innerWidth;
            const card = document.querySelector<HTMLElement>('[role="dialog"]');
            const overlay = card?.parentElement;
            const list = card?.querySelector<HTMLElement>('.overflow-y-auto');
            if (!card || !overlay || !list) return ['no dialog'];
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            const box = card.getBoundingClientRect();
            const style = getComputedStyle(overlay);
            const bandTop = parseFloat(style.paddingTop);
            const bandBottom = window.innerHeight - parseFloat(style.paddingBottom);

            if (Math.abs(box.left - (W - box.right)) > 1) issues.push('not centred across');
            const middle = (box.top + box.bottom) / 2;
            if (Math.abs(middle - (bandTop + bandBottom) / 2) > 1) issues.push('not centred in its band');
            if (box.top < safeTop - 0.5) issues.push(`card under the status bar (${box.top} < ${safeTop})`);
            if (box.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${box.bottom} > ${nav.top})`);
            if (card.scrollWidth > card.clientWidth + 1) issues.push('card overflows sideways');
            if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
            const listBox = list.getBoundingClientRect();
            // One screen: the whole passage and the day sail, no scrolling — or,
            // at the smallest size, at least the whole passage.
            if (!mayScroll && list.scrollHeight > list.clientHeight + 1)
                issues.push(`the route list scrolls (${list.scrollHeight} > ${list.clientHeight})`);
            const lastLeg = [...list.querySelectorAll<HTMLElement>('[data-follow-tone]')].find((row) =>
                row.textContent?.includes('(3rd Leg)'),
            );
            if (passage && (!lastLeg || lastLeg.getBoundingClientRect().bottom > listBox.bottom + 0.5))
                issues.push('the passage does not fit without scrolling');
            for (const element of card.querySelectorAll<HTMLElement>('*')) {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height) continue;
                if (rect.left < box.left - 1 || rect.right > box.right + 1)
                    issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" escapes the card`);
            }
            for (const button of card.querySelectorAll<HTMLElement>('button')) {
                const rect = button.getBoundingClientRect();
                const name = button.getAttribute('aria-label') || button.textContent?.trim().slice(0, 30);
                // A row scrolled out of the card is measured when scrolled in.
                if (mayScroll && list.contains(button) && (rect.top < listBox.top || rect.bottom > listBox.bottom))
                    continue;
                // .hit-target-44 reaches 44 pt through its ::before, not its box.
                if (!button.classList.contains('hit-target-44') && rect.height < 43.5)
                    issues.push(`${name}: ${rect.height}px tall`);
                // (Its 44 pt ::before overflows on purpose.)
                if (!button.classList.contains('hit-target-44') && button.scrollWidth > button.clientWidth + 1)
                    issues.push(`${name}: its words overflow the button`);
                if (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5)
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
                    if (!(hit === button || button.contains(hit)))
                        issues.push(`${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}`);
                }
            }
            return issues;
        },
        { safeInsets: safe, mayScroll: listMayScroll, passage: wholePassage },
    );
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    test(`the follow sheet fits ${size.name} in one screen, centred in the modal band`, async ({ page }, info) => {
        const errors = await open(page, size);
        await expect(page.getByRole('button', { name: /^Check now — Hamble - Yarmouth/ })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Fix in tracer — Poole - Weymouth/ })).toBeVisible();
        await expect(page.getByText('checked 3 Oct')).toBeVisible();
        await expect.poll(() => layoutIssues(page, size.safe, size.listMayScroll), { timeout: 3_000 }).toEqual([]);
        await screenshot(page, info, `follow-sheet-${size.width}x${size.height}`);
        if (size.listMayScroll) {
            // The day sail, one scroll away inside the card, is whole and tappable.
            await page.getByRole('button', { name: /^Antibes - Îles de Lérins/ }).scrollIntoViewIfNeeded();
            await expect.poll(() => layoutIssues(page, size.safe, true), { timeout: 3_000 }).toEqual([]);
            await page.locator('[role="dialog"] .overflow-y-auto').evaluate((list) => list.scrollTo(0, 0));
        }

        // Red: the first tap arms, and the armed row still fits.
        const red = page.getByRole('button', { name: /^Poole - Weymouth/ });
        await red.click();
        await expect(red).toContainText('Tap again to follow anyway');
        await expect(page.getByTestId('outcome')).toHaveText('waiting');
        await expect.poll(() => layoutIssues(page, size.safe, size.listMayScroll), { timeout: 3_000 }).toEqual([]);
        await screenshot(page, info, `follow-sheet-armed-${size.width}x${size.height}`);
        await red.click();
        await expect(page.getByTestId('outcome')).toHaveText('follow v3');
        expect(errors).toEqual([]);
    });

    test(`amber follows on one tap and Check now is its own button at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size);
        await page.getByRole('button', { name: /^Check now — Hamble - Yarmouth/ }).click();
        await expect(page.getByTestId('outcome')).toHaveText('check t1');
        await page.getByRole('button', { name: /^Hamble - Yarmouth/ }).click();
        await expect(page.getByTestId('outcome')).toHaveText('follow v1');
        expect(errors).toEqual([]);
    });
}

test('a check in progress and a refusal notice still fit 320 × 568', async ({ page }, info) => {
    const size = sizes[0];
    const errors = await open(page, size, '&checking&notice');
    await expect(page.getByRole('button', { name: /^Stop — Yarmouth - Poole/ })).toBeVisible();
    await expect(page.getByText('Checking… 12 of 41')).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    // The refusal notice takes the room of one row: the passage scrolls
    // inside the card, everything in view still measures clean.
    await expect.poll(() => layoutIssues(page, size.safe, true, false), { timeout: 3_000 }).toEqual([]);
    await screenshot(page, info, 'follow-sheet-checking-notice-320x568');
    expect(errors).toEqual([]);
});
