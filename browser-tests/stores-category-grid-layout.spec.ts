import { expect, test } from '@playwright/test';

for (const width of [320, 390, 430]) {
    test(`fifteen Store categories fit three columns and five rows at ${width}px`, async ({ page, baseURL }, info) => {
        const origin = new URL(baseURL!).origin;
        await page.route('**/*', (route) => {
            const request = route.request();
            return new URL(request.url()).origin === origin && ['GET', 'HEAD'].includes(request.method())
                ? route.continue()
                : route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        await page.goto('/e2e/fixtures/stores-category-grid.html');
        const grid = page.getByRole('group', { name: 'Store category', exact: true });
        await expect(grid).toBeVisible();
        await expect(grid.getByRole('button')).toHaveCount(15);
        await page.evaluate(() => document.fonts.ready);
        // The real ModalSheet enters at 95% scale. Measure its settled layout,
        // not a transient frame of the opening animation.
        await page.locator('[data-modal-sheet]').evaluate(async (element) => {
            await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
        });

        const geometry = await grid.evaluate((element) => {
            const problems: string[] = [];
            const buttons = [...element.querySelectorAll('button')];
            const buttonRects = buttons.map((button) => button.getBoundingClientRect());
            const within = (outer: DOMRect, inner: DOMRect) =>
                inner.left >= outer.left - 1 &&
                inner.right <= outer.right + 1 &&
                inner.top >= outer.top - 1 &&
                inner.bottom <= outer.bottom + 1;
            const gridRect = element.getBoundingClientRect();
            for (const parent of [
                document.documentElement,
                document.body,
                document.querySelector('[data-modal-sheet]')!,
                element,
            ]) {
                if (parent.scrollWidth > parent.clientWidth + 1) problems.push('Horizontal overflow');
            }
            for (const [index, button] of buttons.entries()) {
                const rect = buttonRects[index];
                const name = button.textContent!.trim();
                if (rect.width < 44 || rect.height < 56)
                    problems.push(`${name}: touch target too small (${rect.width} × ${rect.height})`);
                if (!within(gridRect, rect)) problems.push(`${name}: escapes grid`);
                if (rect.left < 0 || rect.right > innerWidth) problems.push(`${name}: escapes viewport width`);
                if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
                    problems.push(`${name}: button content overflows`);
                const label = button.querySelector('span')!;
                const labelRect = label.getBoundingClientRect();
                if (!within(rect, labelRect)) problems.push(`${name}: label escapes button`);
                const range = document.createRange();
                range.selectNodeContents(label);
                for (const textRect of range.getClientRects()) {
                    if (!within(rect, textRect) || !within(labelRect, textRect)) problems.push(`${name}: text clipped`);
                }
                const textNode = label.firstChild!;
                const lineLetters = new Map<number, string>();
                for (let offset = 0; offset < textNode.textContent!.length; offset++) {
                    const letter = textNode.textContent![offset];
                    if (!/[a-z]/i.test(letter)) continue;
                    range.setStart(textNode, offset);
                    range.setEnd(textNode, offset + 1);
                    const letterRect = range.getBoundingClientRect();
                    const line = Math.round(letterRect.top);
                    lineLetters.set(line, (lineLetters.get(line) ?? '') + letter);
                }
                if ([...lineLetters.values()].some((line) => line.length === 1))
                    problems.push(`${name}: single-letter line (${[...lineLetters.values()].join(' / ')})`);
            }
            return {
                columns: new Set(buttonRects.map((rect) => Math.round(rect.left))).size,
                rows: new Set(buttonRects.map((rect) => Math.round(rect.top))).size,
                rowSizes: [...new Set(buttonRects.map((rect) => Math.round(rect.top)))].map(
                    (top) => buttonRects.filter((rect) => Math.round(rect.top) === top).length,
                ),
                problems,
            };
        });
        expect(geometry).toEqual({ columns: 3, rows: 5, rowSizes: [3, 3, 3, 3, 3], problems: [] });

        // Five rows may scroll inside the real sheet on a short phone. Every
        // category must still be fully reachable, with no hidden last row.
        for (const button of await grid.getByRole('button').all()) {
            await button.scrollIntoViewIfNeeded();
            await expect
                .poll(() =>
                    button.evaluate((element) => {
                        const rect = element.getBoundingClientRect();
                        const panel = element.closest('[data-modal-sheet]')!.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        return (
                            rect.top >= panel.top &&
                            rect.bottom <= panel.bottom &&
                            rect.top >= 0 &&
                            rect.bottom <= innerHeight &&
                            (hit === element || element.contains(hit))
                        );
                    }),
                )
                .toBe(true);
        }

        await expect(grid.getByRole('button', { name: 'Provisions', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        for (const category of ['Electrical', 'Cleaning']) {
            await grid.getByRole('button', { name: category, exact: true }).click();
            await expect(grid.getByRole('button', { name: category, exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await expect(grid.locator('button[aria-pressed="true"]')).toHaveCount(1);
            await expect(page.getByLabel('Selected category', { exact: true })).toHaveText(category);
        }
        expect(pageErrors).toEqual([]);
        if (width === 390) {
            const path = info.outputPath('stores-category-grid-390.png');
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach('Stores category grid at 390px', { path, contentType: 'image/png' });
        }
    });
}
