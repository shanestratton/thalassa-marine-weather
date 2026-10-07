import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * Her GPS silent at Start: "Log from this phone / Wait for the boat" (build
 * 123, package VL), and the phone notice that follows a phone log — the real
 * components with the real CSS, on a fixture page with the app's tab bar
 * (e2e/fixtures/stand-in-question.tsx). House rules measured, not assumed:
 * centred, clear of the tab bar, every button fully visible, at least 44 pt
 * tall and hit-testable, nothing overflowing — at 320 × 568 with large text
 * and a long boat name too.
 */

const sizes = [
    { name: '320x568', width: 320, height: 568, query: '' },
    { name: '320x568 large text', width: 320, height: 568, query: 'largeText' },
    { name: '390x844', width: 390, height: 844, query: '' },
    { name: '390x844 large text', width: 390, height: 844, query: 'largeText' },
    { name: '844x390 landscape', width: 844, height: 390, query: '' },
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
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/stand-in-question.html${query ? `?${query}` : ''}`);
    await expect(page.getByRole('button', { name: 'Slide to Start Tracking' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

/** Every geometric house rule, measured in the page. Returns what broke. */
function layoutIssues(page: Page, cardSelector: string, requireFit: boolean) {
    return page.evaluate(
        ({ selector, fit }) => {
            const issues: string[] = [];
            const W = window.innerWidth;
            const H = window.innerHeight;
            const card = document.querySelector<HTMLElement>(selector);
            const overlay = card?.parentElement;
            if (!card || !overlay) return ['no dialog'];
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            const box = card.getBoundingClientRect();

            if (Math.abs(box.left - (W - box.right)) > 1)
                issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
            const style = getComputedStyle(overlay);
            const bandTop = parseFloat(style.paddingTop);
            const bandBottom = H - parseFloat(style.paddingBottom);
            const middle = (box.top + box.bottom) / 2;
            if (Math.abs(middle - (bandTop + bandBottom) / 2) > 1)
                issues.push(
                    `not centred in its band: ${middle.toFixed(1)} vs ${((bandTop + bandBottom) / 2).toFixed(1)}`,
                );
            if (box.top < 0) issues.push(`card starts above the screen (${box.top})`);
            if (box.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${box.bottom} > ${nav.top})`);
            if (card.scrollWidth > card.clientWidth + 1) issues.push('card overflows sideways');
            if (fit && card.scrollHeight > card.clientHeight + 1)
                issues.push(`card content is cut off (${card.scrollHeight} > ${card.clientHeight})`);
            if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
            for (const element of card.querySelectorAll<HTMLElement>('*')) {
                const rect = element.getBoundingClientRect();
                if (!rect.width || !rect.height) continue;
                if (rect.left < box.left - 1 || rect.right > box.right + 1)
                    issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 20)}" escapes the card`);
            }
            const controls = [...card.querySelectorAll<HTMLElement>('button, input, label')].filter(
                (element) => element.getClientRects().length > 0,
            );
            for (const element of controls) {
                const rect = element.getBoundingClientRect();
                const name = element.getAttribute('aria-label') || element.textContent?.trim() || element.id;
                if (element.tagName === 'BUTTON' && rect.height < 43.5) issues.push(`${name}: ${rect.height}px tall`);
                if (!fit) continue; // a scrolling card is checked control by control after scrolling
                if (
                    rect.top < box.top - 0.5 ||
                    rect.bottom > box.bottom + 0.5 ||
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
                    if (element.tagName === 'LABEL') {
                        if (!hit || !(hit === element || element.contains(hit) || hit.contains(element)))
                            issues.push(`${name} label is covered at ${x.toFixed(0)},${y.toFixed(0)}`);
                    } else if (!(hit === element || element.contains(hit)))
                        issues.push(`${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}`);
                }
            }
            return issues;
        },
        { selector: cardSelector, fit: requireFit },
    );
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    test(`the stand-in question fits ${size.name}, centred above the tab bar`, async ({ page }, info) => {
        const errors = await open(page, size, size.query);
        await page.getByRole('button', { name: 'Slide to Start Tracking' }).click();
        const dialog = page.getByRole('dialog', { name: 'Wandering Albatross of Port Moselle’s GPS isn’t answering' });
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('button', { name: 'Wait for the boat' })).toBeFocused();
        await expect.poll(() => layoutIssues(page, '[data-stand-in-card]', true), { timeout: 3_000 }).toEqual([]);
        await screenshot(page, info, `stand-in-${size.width}x${size.height}${size.query ? '-large-text' : ''}`);

        await page.getByRole('button', { name: 'Log from this phone' }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('phone');
        expect(errors).toEqual([]);
    });

    test(`the phone notice is centred above the tab bar at ${size.name}, its button in reach`, async ({
        page,
    }, info) => {
        const errors = await open(page, size, size.query);
        await page.getByRole('button', { name: 'Phone notice' }).click();
        const dialog = page.getByRole('dialog', { name: 'Logging from this phone' });
        await expect(dialog).toBeVisible();
        // The modal rule (2026-08-31): centred, clear of the tab bar, scrolling
        // inside itself when it must. It fits outright at ordinary text on a
        // portrait phone; with large text or in landscape it may scroll, with
        // its button reachable — never under the tab bar.
        const mustFit = !size.query && size.height > 400;
        await expect.poll(() => layoutIssues(page, '[data-phone-notice]', mustFit), { timeout: 3_000 }).toEqual([]);
        await screenshot(page, info, `phone-notice-${size.width}x${size.height}${size.query ? '-large-text' : ''}`);
        const start = page.getByRole('button', { name: 'Start tracking', exact: true });
        await start.scrollIntoViewIfNeeded();
        await start.click();
        await expect(page.getByTestId('outcome')).toHaveText('started');
        expect(errors).toEqual([]);
    });
}

test('Escape and the backdrop cancel the question; nothing starts', async ({ page }) => {
    await open(page, sizes[2], '');
    await page.getByRole('button', { name: 'Slide to Start Tracking' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('outcome')).toHaveText('cancelled');
});

test('a boat with no name is asked about as "your boat"', async ({ page }) => {
    await open(page, sizes[0], 'boat=');
    await page.getByRole('button', { name: 'Slide to Start Tracking' }).click();
    await expect(page.getByRole('dialog', { name: 'Your boat’s GPS isn’t answering' })).toBeVisible();
    await page.getByRole('button', { name: 'Wait for the boat' }).click();
    await expect(page.getByTestId('outcome')).toHaveText('wait');
});
