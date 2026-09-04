import { test, expect, type Page, type Locator } from '@playwright/test';

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
}

async function visibleAboveKeyboard(page: Page, field: Locator, height: number) {
    const bottom = page.viewportSize()!.height - height;
    await expect
        .poll(async () => {
            const box = await field.boundingBox();
            return !!box && box.y >= 0 && box.y + box.height <= bottom;
        })
        .toBe(true);
    // A bounding box alone can pass for a field clipped by an inner panel or
    // covered by a sticky header. Verify it is actually hit-testable too.
    await expect
        .poll(() =>
            field.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return [rect.top + 4, rect.top + rect.height / 2, rect.bottom - 4].every((y) => {
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
                    return hit === element || element.contains(hit);
                });
            }),
        )
        .toBe(true);
}

for (const mode of ['short', 'long', 'legacy', 'bottom']) {
    for (const size of [
        { name: 'phone', width: 390, height: 844, keyboard: 344 },
        { name: 'landscape', width: 844, height: 390, keyboard: 200 },
    ]) {
        test(`${mode} ${size.name} form keeps the selected field visible and Next stays inside it`, async ({
            page,
        }) => {
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.goto(`/e2e/fixtures/keyboard.html?mode=${mode}`);
            await page.getByRole('button', { name: 'Edit settings' }).click();
            const host = page.getByRole('textbox', { name: 'Host', exact: true });
            const port = page.getByRole('textbox', { name: 'Port', exact: true });
            await expect(host).toBeFocused();
            await keyboard(page, size.keyboard);
            await visibleAboveKeyboard(page, host, size.keyboard);
            await host.press('Enter');
            await expect(port).toBeFocused();
            await visibleAboveKeyboard(page, port, size.keyboard);
            if (mode === 'short') await page.screenshot({ path: test.info().outputPath('keyboard-open.png') });
            await port.press('Enter');
            const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
            await expect(notes).toBeFocused();
            await visibleAboveKeyboard(page, notes, size.keyboard);
            await notes.fill('First line');
            await notes.press('Enter');
            await expect(notes).toHaveValue('First line\n');
            await keyboard(page, 0);
            await expect(page.getByRole('textbox', { name: 'Background search' })).not.toBeFocused();
        });
    }
}

test('playlist Name advances to Description without submitting, including landscape', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/e2e/fixtures/keyboard.html?mode=playlist');
    await page.getByRole('button', { name: 'Edit settings' }).click();
    const name = page.getByRole('textbox', { name: 'Playlist name' });
    await expect(name).toBeFocused();
    await name.fill('Whitsundays');
    await keyboard(page, 200);
    await visibleAboveKeyboard(page, name, 200);
    await name.press('Enter');
    const description = page.getByRole('textbox', { name: 'Playlist description' });
    await expect(description).toBeFocused();
    await visibleAboveKeyboard(page, description, 200);
    await description.press('Enter');
    await expect(description).not.toBeFocused();
    await expect(page.getByRole('dialog')).toBeVisible();
});

test('page fields clear the sticky header and the final field gets enough scroll travel', async ({ page }) => {
    await page.goto('/e2e/fixtures/keyboard.html?mode=page');
    const port = page.getByRole('textbox', { name: 'Port', exact: true });
    await port.focus();
    await keyboard(page, 344);
    await visibleAboveKeyboard(page, port, 344);
    const notes = page.getByRole('textbox', { name: 'Notes', exact: true });
    await port.press('Enter');
    await visibleAboveKeyboard(page, notes, 344);
});

for (const size of [
    { name: 'phone', width: 430, height: 932, keyboard: 406 },
    { name: 'small phone', width: 375, height: 667, keyboard: 336 },
    { name: 'landscape', width: 844, height: 390, keyboard: 200 },
]) {
    test(`current location note stays visible without blanking the chat in ${size.name}`, async ({ page }) => {
        // The real attachment component renders a map, but this regression
        // must not contact map providers, authentication or messaging APIs.
        await page.route('**/*', (route) =>
            new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
        );
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/e2e/fixtures/keyboard.html?mode=current-location');
        const note = page.getByRole('textbox', { name: 'Location note', exact: true });
        await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveCount(0);
        await note.click();
        await keyboard(page, size.keyboard);
        await expect(note).toBeFocused();
        await visibleAboveKeyboard(page, note, size.keyboard);
        await visibleAboveKeyboard(page, page.getByTestId('chat-header'), size.keyboard);
        await expect
            .poll(() =>
                page.evaluate(() =>
                    [document.documentElement, document.body, document.getElementById('root')!].every(
                        (element) => element.scrollTop === 0,
                    ),
                ),
            )
            .toBe(true);
        await note.fill('Anchored for the night');
        await expect(note).toHaveValue('Anchored for the night');
        await page.screenshot({ path: test.info().outputPath('location-note-keyboard.png') });
        await note.press('Enter');
        await expect(page.getByTestId('shared-note')).toHaveText('Anchored for the night');
        await keyboard(page, 0);
        await visibleAboveKeyboard(page, note, 0);
        await visibleAboveKeyboard(page, page.getByTestId('chat-header'), 0);
        await page.getByRole('button', { name: 'Close current location sheet' }).click();
        await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveValue(
            'Unsent channel draft',
        );
    });
}
