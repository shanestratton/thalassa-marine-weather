import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The sign-in sheet with a failed Sign in with Apple on it (build 124, package
 * AC): the real SignInScreen and the real CSS on a fixture page with the app's
 * tab bar (e2e/fixtures/sign-in.tsx). The sheet now stays open until every
 * Apple step has finished and puts the failing step on screen, so its worst
 * case is three provider buttons, the longest caller prompt and the longest
 * failure banner together. House rules measured, not assumed: it covers the
 * tab bar, and at a phone's portrait sizes it fits one screen with every
 * button, the banner and the privacy line in view and hit-testable — at
 * 320 × 568 too. With large text or in landscape it may scroll inside itself,
 * every control reachable, never sideways.
 *
 * Every size is in wide fonts (Verdana on a Mac, DejaVu Sans on the Linux
 * runner), the house fit rule. The dev server for this suite turns the Apple
 * and Google buttons on (playwright.keyboard.config.ts), so the three-button
 * layout is the one measured.
 */

/**
 * A browser draws env(safe-area-inset-*) as 0, so `insets` is the height a
 * phone's own insets add to the sheet's padding, which must be spare here:
 * an SE's 20 pt status bar fits inside the padding already; a mini (375 × 812,
 * compact: 50 top, 34 bottom) adds 26 + 18; an iPhone 13–16 (390 × 844, the
 * full brand: 47 top, 34 bottom) adds 31 + 10.
 */
const sizes = [
    { name: '320x568', width: 320, height: 568, query: '', fit: true, insets: 0 },
    { name: '375x667', width: 375, height: 667, query: '', fit: true, insets: 0 },
    { name: '375x812', width: 375, height: 812, query: '', fit: true, insets: 44 },
    { name: '390x844', width: 390, height: 844, query: '', fit: true, insets: 41 },
    { name: '320x568 large text', width: 320, height: 568, query: 'largeText', fit: false, insets: 0 },
    { name: '844x390 landscape', width: 844, height: 390, query: '', fit: false, insets: 0 },
];

const BANNERS = {
    race: 'Another Apple sign-in for this account finished at the same moment. Try again.',
    offline: "Apple Sign-In couldn't reach Thalassa. Check your connection and try again.",
    apple1000: "Apple Sign-In didn't complete (Apple error 1000). Try again.",
};

async function open(page: Page, size: { width: number; height: number }, query: string) {
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
    await page.goto(`/e2e/fixtures/sign-in.html${query ? `?${query}` : ''}`);
    const dialog = page.getByRole('dialog', { name: 'Sign in to Thalassa' });
    await expect(dialog).toBeVisible();
    for (const name of ['Sign in with email', 'Sign in with Apple', 'Sign in with Google']) {
        await expect(page.getByRole('button', { name })).toBeVisible();
    }
    await page.evaluate(() => document.fonts.ready);
    await expectWideFaceDrawn(page.getByRole('button', { name: 'Sign in with Apple' }));
    return errors;
}

/** Every geometric house rule, measured in the page. Returns what broke. */
function sheetIssues(page: Page, mustFit: boolean, insets = 0) {
    return page.evaluate(
        ({ fit, insets }) => {
            const issues: string[] = [];
            const W = window.innerWidth;
            const H = window.innerHeight;
            const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="sign-in-title"]');
            if (!sheet) return ['no sheet'];
            const box = sheet.getBoundingClientRect();
            if (box.left > 0.5 || box.top > 0.5 || box.right < W - 0.5 || box.bottom < H - 0.5)
                issues.push(`sheet does not cover the screen: ${JSON.stringify(box)}`);
            // The sheet covers the app's tab bar; the tab bar never covers the sheet.
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            const overNav = document.elementFromPoint((nav.left + nav.right) / 2, (nav.top + nav.bottom) / 2);
            if (!overNav || !sheet.contains(overNav)) issues.push(`the tab bar shows through (${overNav?.tagName})`);
            if (fit && sheet.scrollHeight > sheet.clientHeight + 1)
                issues.push(`sheet must scroll to show everything (${sheet.scrollHeight} > ${sheet.clientHeight})`);
            if (fit) {
                // What the sheet needs: its flowing content plus its padding, plus
                // what the phone's own insets would add to that padding.
                const flowing = [...sheet.children].filter(
                    (child) => child.getClientRects().length > 0 && getComputedStyle(child).position === 'relative',
                );
                const top = Math.min(...flowing.map((child) => child.getBoundingClientRect().top));
                const bottom = Math.max(...flowing.map((child) => child.getBoundingClientRect().bottom));
                const style = getComputedStyle(sheet);
                const needed = bottom - top + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + insets;
                if (needed > sheet.clientHeight + 0.5)
                    issues.push(
                        `with the phone's insets the sheet needs ${needed.toFixed(0)} of ${sheet.clientHeight}`,
                    );
            }
            if (sheet.scrollWidth > sheet.clientWidth + 1) issues.push('sheet overflows sideways');
            if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');

            const targets = [...sheet.querySelectorAll<HTMLElement>('button, a[href], [role="alert"], footer')].filter(
                (element) => element.getClientRects().length > 0,
            );
            for (const element of targets) {
                const rect = element.getBoundingClientRect();
                const name =
                    element.getAttribute('aria-label') ||
                    element.getAttribute('role') ||
                    element.tagName.toLowerCase() + ':' + (element.textContent?.trim().slice(0, 24) ?? '');
                if (rect.left < -0.5 || rect.right > W + 0.5) issues.push(`${name} runs off the side`);
                if (element.tagName === 'BUTTON' && rect.height < 43.5) issues.push(`${name}: ${rect.height}px tall`);
                if (!fit) continue; // a scrolling sheet is checked control by control after scrolling
                if (rect.top < -0.5 || rect.bottom > H + 0.5) issues.push(`${name} is not fully on screen`);
                if (element.tagName !== 'BUTTON' && element.tagName !== 'A') continue;
                const inset = Math.min(4, rect.height / 3);
                const midX = (rect.left + rect.right) / 2;
                const midY = (rect.top + rect.bottom) / 2;
                for (const [x, y] of [
                    [midX, midY],
                    [midX, rect.top + inset],
                    [midX, rect.bottom - inset],
                ]) {
                    const hit = document.elementFromPoint(x, y);
                    if (!(hit === element || element.contains(hit)))
                        issues.push(`${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}`);
                }
            }
            return issues;
        },
        { fit: mustFit, insets },
    );
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    test(`a failed Sign in with Apple ${size.fit ? 'fits' : 'stays reachable on'} the sheet at ${size.name}`, async ({
        page,
    }, info) => {
        const errors = await open(page, size, size.query);
        const banner = page.getByRole('alert');
        await expect(banner).toHaveText(BANNERS.race);
        await expect.poll(() => sheetIssues(page, size.fit, size.insets), { timeout: 3_000 }).toEqual([]);
        await screenshot(page, info, `sign-in-failure-${size.width}x${size.height}${size.query ? '-large-text' : ''}`);

        if (!size.fit) {
            // Scrolling inside the sheet reaches every control, each one hit-testable.
            for (const control of [
                page.getByRole('button', { name: 'Sign in with Apple' }),
                page.getByRole('button', { name: 'Sign in with Google' }),
                page.getByRole('button', { name: 'Sign in with email' }),
                banner,
                page.getByRole('link', { name: 'Terms & Privacy' }),
            ]) {
                await control.scrollIntoViewIfNeeded();
                await expect(control).toBeInViewport({ ratio: 1 });
            }
            await page.getByRole('button', { name: 'Sign in with Google' }).click({ trial: true });
        }
        expect(errors).toEqual([]);
    });
}

for (const failure of Object.keys(BANNERS) as Array<keyof typeof BANNERS>) {
    test(`the ${failure} banner fits the smallest phone beside the longest prompt`, async ({ page }) => {
        const errors = await open(page, sizes[0], `failure=${failure}`);
        await expect(page.getByRole('alert')).toHaveText(BANNERS[failure]);
        await expect.poll(() => sheetIssues(page, true), { timeout: 3_000 }).toEqual([]);
        expect(errors).toEqual([]);
    });
}

test('with no failure and no prompt the sheet still fits, and closing it clears nothing it should keep', async ({
    page,
}) => {
    const errors = await open(page, sizes[0], 'failure=none&prompt=none');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => sheetIssues(page, true), { timeout: 3_000 }).toEqual([]);
    await page.getByRole('button', { name: 'Close sign-in' }).click();
    await expect(page.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeHidden();
    await page.getByRole('button', { name: 'Open sign-in' }).click();
    await expect(page.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeVisible();
    expect(errors).toEqual([]);
});

test('a failure seen and closed is gone when the sheet opens again', async ({ page }) => {
    const errors = await open(page, sizes[2], '');
    await expect(page.getByRole('alert')).toHaveText(BANNERS.race);
    await page.getByRole('button', { name: 'Close sign-in' }).click();
    await page.getByRole('button', { name: 'Open sign-in' }).click();
    await expect(page.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
});
