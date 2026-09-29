import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * "Your draft is set at 2.40 m. Please confirm." (Shane 2026-09-29) — the one
 * shared DraftConfirmModal, real CSS and real settings store, on a fixture
 * page with the app's tab bar and a simulated keyboard
 * (e2e/fixtures/draft-confirm.tsx). House rules measured, not assumed:
 * centred, clear of the tab bar (and of the keyboard when it is up), buttons
 * and field fully visible and hit-testable, nothing overflowing.
 */

const sizes = [
    { name: '320x568', width: 320, height: 568, keyboard: 253, query: '' },
    { name: '390x844', width: 390, height: 844, keyboard: 344, query: '' },
    { name: '844x390 landscape', width: 844, height: 390, keyboard: 200, query: '' },
    { name: 'large text 390x844', width: 390, height: 844, keyboard: 344, query: 'largeText' },
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
    await page.goto(`/e2e/fixtures/draft-confirm.html${query ? `?${query}` : ''}`);
    await expect(page.getByRole('button', { name: 'Plan Your Day' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
}

/** Every geometric house rule, measured in the page. Returns what broke. */
function layoutIssues(page: Page, keyboardHeight: number) {
    return page.evaluate((kb) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const dialog = document.querySelector<HTMLElement>('[data-draft-confirm]');
        const card = dialog?.querySelector<HTMLElement>('[data-draft-confirm-card]');
        if (!dialog || !card) return ['no dialog'];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        // The keyboard covers the tab bar when it is up; otherwise the tab bar is the floor.
        const floor = kb ? H - kb : nav.top;
        const box = card.getBoundingClientRect();

        if (Math.abs(box.left - (W - box.right)) > 1)
            issues.push(`not centred across: ${box.left.toFixed(1)} vs ${(W - box.right).toFixed(1)}`);
        const style = getComputedStyle(dialog);
        const bandTop = parseFloat(style.paddingTop);
        const bandBottom = H - parseFloat(style.paddingBottom);
        const middle = (box.top + box.bottom) / 2;
        if (Math.abs(middle - (bandTop + bandBottom) / 2) > 1)
            issues.push(`not centred in its band: ${middle.toFixed(1)} vs ${((bandTop + bandBottom) / 2).toFixed(1)}`);
        if (box.top < 0) issues.push(`card starts above the screen (${box.top})`);
        if (box.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${box.bottom} > ${nav.top})`);
        if (box.bottom > floor + 0.5) issues.push(`card runs under the keyboard (${box.bottom} > ${floor})`);

        if (card.scrollWidth > card.clientWidth + 1) issues.push('card overflows sideways');
        if (card.scrollHeight > card.clientHeight + 1)
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
            if (element.tagName !== 'LABEL' && rect.height < 43.5) issues.push(`${name}: ${rect.height}px tall`);
            if (
                rect.top < Math.max(0, box.top) - 0.5 ||
                rect.bottom > Math.min(floor, box.bottom) + 0.5 ||
                rect.left < box.left - 0.5 ||
                rect.right > box.right + 0.5
            )
                issues.push(`${name} is not fully visible`);
            // Centre and just inside each edge's midpoint: inside the shape
            // even of the round Close button (hit-testing honours the radius).
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
                    issues.push(
                        `${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}.${String(hit?.className).slice(0, 40)}`,
                    );
            }
        }
        return issues;
    }, keyboardHeight);
}

async function expectLayout(page: Page, keyboardHeight: number) {
    // The keyboard guard settles over a few frames; the final geometry is what counts.
    await expect.poll(() => layoutIssues(page, keyboardHeight), { timeout: 3_000 }).toEqual([]);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    test(`draft confirmation fits ${size.name}, with Change focused above the keyboard`, async ({ page }, info) => {
        const errors = await open(page, size, size.query);
        await page.getByRole('button', { name: 'Plan Your Day' }).click();
        const dialog = page.getByRole('dialog', { name: 'Check your draft' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Your draft is set at 2.40 m. Please confirm.');
        await expect(page.getByRole('button', { name: 'Confirm 2.40 m' })).toBeVisible();
        await expectLayout(page, 0);
        await screenshot(page, info, `draft-confirm-${size.width}x${size.height}${size.query ? '-large-text' : ''}`);

        await page.getByRole('button', { name: 'Change' }).click();
        const field = page.getByRole('textbox', { name: 'Draft in metres' });
        await expect(field).toBeFocused();
        await expect(field).toHaveValue('2.40');
        await keyboard(page, size.keyboard);
        await expect(field).toBeFocused();
        await expectLayout(page, size.keyboard);
        await screenshot(
            page,
            info,
            `draft-change-keyboard-${size.width}x${size.height}${size.query ? '-large-text' : ''}`,
        );

        // A plain error keeps everything in reach.
        await field.fill('9');
        await page.getByRole('button', { name: 'Save and confirm' }).click();
        await expect(page.getByRole('alert')).toHaveText('Enter a draft between 0.30 m and 8.00 m.');
        await expectLayout(page, size.keyboard);

        await field.fill('2.1');
        await page.getByRole('button', { name: 'Save and confirm' }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('ran');
        await keyboard(page, 0);
        expect(errors).toEqual([]);
    });
}

for (const size of [sizes[0], sizes[2]]) {
    test(`no draft set shows the field straight away at ${size.name}`, async ({ page }) => {
        const errors = await open(page, size, 'draft=unset');
        await page.getByRole('button', { name: 'Plan Your Day' }).click();
        const dialog = page.getByRole('dialog', { name: 'Set your draft' });
        await expect(dialog).toContainText('No draft is set for your boat.');
        const field = page.getByRole('textbox', { name: 'Draft in metres' });
        await expect(field).toBeFocused();
        await keyboard(page, size.keyboard);
        await expectLayout(page, size.keyboard);
        await field.fill('1.8');
        await field.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(page.getByTestId('outcome')).toHaveText('ran');
        expect(errors).toEqual([]);
    });
}

test('imperial skippers see feet too; Escape closes and nothing runs', async ({ page }) => {
    await open(page, sizes[1], 'units=ft&draft=estimated');
    await page.getByRole('button', { name: 'Plan Your Day' }).click();
    const dialog = page.getByRole('dialog', { name: 'Check your draft' });
    await expect(dialog).toContainText('Your draft is set at 7.87 ft (2.40 m). Please confirm.');
    await expect(dialog).toContainText('This is an estimate, not a measurement.');
    await expectLayout(page, 0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('outcome')).toHaveText('did not run');
});
