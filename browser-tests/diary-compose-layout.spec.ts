import { expect, test, type Locator, type Page } from '@playwright/test';

const SIZES = [
    { name: 'short phone', width: 390, height: 650, keyboard: 240 },
    { name: 'tall phone', width: 390, height: 844, keyboard: 344 },
    { name: 'small phone', width: 320, height: 568, keyboard: 220 },
    { name: 'tablet pane', width: 1024, height: 768, keyboard: 300, pane: true },
];

async function attachVideo(page: Page) {
    await page.locator('input[type="file"][accept="video/*"]').setInputFiles({
        name: 'local-layout-preview.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('Local layout fixture only; no media upload or playback is required.'),
    });
    await expect(page.locator('video')).toHaveAttribute('src', /^blob:/);
}

async function geometry(field: Locator) {
    return field.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const scroller = element.closest('.overflow-auto')!;
        const panel = scroller.getBoundingClientRect();
        return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            contentTop: rect.top - panel.top + scroller.scrollTop,
            panelTop: panel.top,
            panelBottom: panel.bottom,
        };
    });
}

async function keyboard(page: Page, height: number) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
    // The real global guard has focus settling passes at 0, 120 and 360 ms.
    // Check after those passes, so a transient correct position cannot pass.
    await page.waitForTimeout(420);
}

async function bodyAboveFooter(page: Page, field: Locator, keyboardHeight: number) {
    await expect(field).toBeFocused();
    await expect
        .poll(async () => {
            const body = await geometry(field);
            const save = await page.getByRole('button', { name: 'Save changes' }).boundingBox();
            const footerTop = await page
                .getByRole('button', { name: 'Save changes' })
                .evaluate((button) => button.parentElement!.parentElement!.getBoundingClientRect().top);
            const keyboardTop = page.viewportSize()!.height - keyboardHeight;
            return (
                !!save &&
                body.top >= body.panelTop &&
                body.bottom <= body.panelBottom + 1 &&
                body.bottom <= footerTop + 1 &&
                save.y + save.height <= keyboardTop + 1 &&
                body.height > 40
            );
        })
        .toBe(true);
    await expect
        .poll(() =>
            field.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].every((y) => {
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
                    return hit === element || element.contains(hit);
                });
            }),
        )
        .toBe(true);
}

for (const size of SIZES) {
    test(`diary video leaves text in place and keyboard focus visible on ${size.name}`, async ({ page }) => {
        await page.route('**/*', (route) =>
            new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
        );
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/e2e/fixtures/diary-compose.html${size.pane ? '?pane=true' : ''}`);
        const body = page.getByRole('textbox', { name: 'Diary entry text', exact: true });
        await expect(body).toHaveValue(/We tucked into the bay/);
        const draft = await body.inputValue();
        const before = await geometry(body);

        await attachVideo(page);
        const after = await geometry(body);
        expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.contentTop - before.contentTop)).toBeLessThanOrEqual(1);
        const preview = await page.locator('video').boundingBox();
        expect(preview).not.toBeNull();
        expect(preview!.y).toBeGreaterThanOrEqual(after.bottom + 1);
        await expect(body).toHaveValue(draft);
        await page.screenshot({ path: test.info().outputPath('diary-video-attached.png') });

        const remove = page.getByRole('button', { name: 'Remove the video', exact: true });
        await remove.scrollIntoViewIfNeeded();
        await remove.click();
        await expect(page.locator('video')).toHaveCount(0);
        await expect(body).toHaveValue(draft);

        await attachVideo(page);
        await body.focus();
        await keyboard(page, size.keyboard - 80);
        await bodyAboveFooter(page, body, size.keyboard - 80);
        await body.fill(`${draft}\nA dolphin followed us into the anchorage.`);
        await keyboard(page, size.keyboard);
        await bodyAboveFooter(page, body, size.keyboard);
        await expect(body).toHaveValue(`${draft}\nA dolphin followed us into the anchorage.`);
        await page.screenshot({ path: test.info().outputPath('diary-video-keyboard.png') });

        await keyboard(page, 0);
        await body.evaluate((element) => (element as HTMLTextAreaElement).blur());
        await remove.scrollIntoViewIfNeeded();
        await remove.click();
        await expect(page.locator('video')).toHaveCount(0);
        await expect(body).toHaveValue(`${draft}\nA dolphin followed us into the anchorage.`);
        await expect
            .poll(() =>
                page.evaluate(() =>
                    [document.documentElement, document.body, document.getElementById('root')!].every(
                        (element) => element.scrollTop === 0,
                    ),
                ),
            )
            .toBe(true);
    });
}
