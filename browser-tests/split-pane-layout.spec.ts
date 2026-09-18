import { expect, test, type Locator, type Page } from '@playwright/test';

async function inside(element: Locator, frame: Locator) {
    await expect
        .poll(async () => {
            const a = await element.boundingBox();
            const b = await frame.boundingBox();
            return (
                !!a &&
                !!b &&
                a.width > 0 &&
                a.height > 0 &&
                a.x >= b.x - 1 &&
                a.y >= b.y - 1 &&
                a.x + a.width <= b.x + b.width + 1 &&
                a.y + a.height <= b.y + b.height + 1
            );
        })
        .toBe(true);
}

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
}

test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto('/e2e/fixtures/split-panes.html');
});

for (const id of ['left', 'right']) {
    test(`${id} conditional dialog unmount restores its opener after releasing the pane lock`, async ({ page }) => {
        const opener = page.getByRole('button', { name: `Conditional ${id}`, exact: true });
        await opener.focus();
        await opener.press('Enter');
        const dialog = page.getByRole('dialog', { name: `${id} conditional confirmation` });
        await expect(page.getByTestId(`${id}-frame`)).toHaveAttribute('inert');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByTestId(`${id}-frame`)).not.toHaveAttribute('inert');
        await expect(opener).toBeFocused();
    });

    test(`${id} sheet, nested confirmation and fixed controls remain inside their frame after resize`, async ({
        page,
    }) => {
        const frame = page.getByTestId(`${id}-frame`);
        await inside(page.getByTestId(`${id}-fixed`), frame);
        await page.getByRole('button', { name: `Open ${id}`, exact: true }).click();
        const backdrop = page.locator(`[data-pane-portal="${id}"] [data-modal-sheet-backdrop]`);
        const panel = backdrop.locator('[data-modal-sheet]');
        await inside(backdrop, frame);
        await inside(panel, frame);
        const opener = page.getByRole('button', { name: `Nested ${id}`, exact: true });
        // Mobile Safari blurs even an already-focused button on pointerdown.
        // Use actual keyboard activation to test the trap's restore target.
        await opener.focus();
        await opener.press('Enter');
        const child = page.getByRole('dialog', { name: `${id} confirmation` });
        await inside(child, frame);
        await page.setViewportSize({ width: 1120, height: 820 });
        await inside(backdrop, frame);
        await inside(child.locator('[data-pane-dialog-panel]'), frame);
        await child.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('button', { name: `Nested ${id}`, exact: true })).toBeFocused();
    });

    test(`${id} modal keyboard scroll stays in the pane and other pane remains usable`, async ({ page }) => {
        const other = id === 'left' ? 'right' : 'left';
        await page.getByRole('button', { name: `Open ${id}`, exact: true }).click();
        await page.getByRole('textbox', { name: `${id} host`, exact: true }).fill('draft survives keyboard');
        await keyboard(page, 360);
        const panel = page.locator(`[data-pane-portal="${id}"] [data-modal-sheet]`);
        const notes = page.getByRole('textbox', { name: `${id} notes` });
        await notes.focus();
        await expect
            .poll(async () => {
                const box = await notes.boundingBox();
                return !!box && box.y >= 88 && box.y + box.height <= 664;
            })
            .toBe(true);
        await expect
            .poll(() =>
                notes.evaluate((element) => {
                    const box = element.getBoundingClientRect();
                    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
                }),
            )
            .toBe(true);
        await expect(page.getByTestId(`${other}-scroll`)).toHaveJSProperty('scrollTop', 0);
        const outside = page.getByRole('textbox', { name: `${other} page field` });
        await outside.fill('other pane still usable');
        await outside.press('Tab');
        await expect(page.getByRole('button', { name: `Slide ${other}` })).toBeFocused();
        await keyboard(page, 0);
        await inside(panel, page.getByTestId(`${id}-frame`));
        await expect(page.getByRole('textbox', { name: `${id} host`, exact: true })).toHaveValue(
            'draft survives keyboard',
        );
    });

    test(`${id} slide clamps to its own width, cancels on resize, and confirms once`, async ({ page }) => {
        const slider = page.getByRole('button', { name: `Slide ${id}` });
        const box = (await slider.boundingBox())!;
        const drag = async () => {
            await page.mouse.move(box.x + 28, box.y + 28);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width + 400, box.y + 28);
        };
        await drag();
        await inside(slider.locator('[class*="cursor-grab"]'), slider);
        await page.setViewportSize({ width: 1120, height: 820 });
        await page.mouse.up();
        await expect(page.getByTestId(`${id}-confirmed`)).toHaveText('0');
        const next = (await slider.boundingBox())!;
        await page.mouse.move(next.x + 28, next.y + 28);
        await page.mouse.down();
        await page.mouse.move(next.x + next.width - 8, next.y + 28);
        await page.mouse.up();
        await expect(page.getByTestId(`${id}-confirmed`)).toHaveText('1');
    });
}

test('legacy dialog keyboard padding is applied once and app alarms cover both panes', async ({ page }) => {
    await page.getByRole('button', { name: 'Legacy right', exact: true }).click();
    await keyboard(page, 360);
    const panel = page.getByRole('dialog', { name: 'right legacy' });
    await inside(panel, page.getByTestId('right-frame'));
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(480);
    await page.getByRole('button', { name: 'Global alarm', exact: true }).click();
    const alarm = page.getByRole('alertdialog');
    expect(await alarm.evaluate((element) => element.parentElement === document.body)).toBe(true);
    const bounds = (await alarm.boundingBox())!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(1366);
});

test('leaving split retains page state and restores full-viewport dialogs', async ({ page }) => {
    await page.getByRole('textbox', { name: 'right page field' }).fill('retain page instance');
    await page.getByRole('button', { name: 'Toggle split' }).click();
    await expect(page.getByRole('textbox', { name: 'right page field' })).toHaveValue('retain page instance');
    await page.getByRole('button', { name: 'Open right', exact: true }).click();
    const backdrop = page.locator('[data-modal-sheet-backdrop]');
    expect(await backdrop.evaluate((element) => element.parentElement === document.body)).toBe(true);
    const bounds = (await backdrop.boundingBox())!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(1366);
});
