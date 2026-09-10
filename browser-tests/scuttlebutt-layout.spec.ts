import { expect, test, type Locator, type Page } from '@playwright/test';

const SIZES = [
    { name: 'small phone', width: 320, height: 568, keyboard: 220 },
    { name: 'iPhone', width: 390, height: 844, keyboard: 344 },
    { name: 'landscape phone with navigation open', width: 844, height: 390, keyboard: 150 },
    { name: 'iPad pane', width: 1024, height: 768, keyboard: 300, pane: true },
    { name: 'desktop pane', width: 1440, height: 900, keyboard: 300, pane: true },
];

async function open(page: Page, size: (typeof SIZES)[number], history: 'empty' | 'long', model = 'native', extra = '') {
    await page.route('**/*', (route) =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(
        `/e2e/fixtures/scuttlebutt-layout.html?pane=${!!size.pane}&history=${history}&keyboard=${model}${extra}`,
    );
    await expect(page.getByRole('button', { name: 'General', exact: true })).toBeVisible();
    if (model === 'native') await expect(page.locator('html')).toHaveAttribute('data-native-keyboard-ready', 'true');
}

async function keyboard(page: Page, height: number, native = true) {
    await page.evaluate((value) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: value })), height);
    await expect
        .poll(() => page.locator('html').evaluate((element) => element.dataset.keyboardOpen === 'true'))
        .toBe(height > 0);
    if (native) {
        expect(await page.evaluate(() => window.visualViewport!.height)).toBe(page.viewportSize()!.height);
        expect(await page.evaluate(() => window.innerHeight)).toBe(page.viewportSize()!.height);
    }
    // Let the scheduled guard (0/120/360ms) and scroll-to-latest (500ms) run.
    // Their timers alone do not prove React and the height transition have
    // committed/painted, especially on a loaded WebKit runner.
    await page.waitForTimeout(550);
    const chat = page.locator('[data-chat-page]');
    await expect
        .poll(() =>
            chat.evaluate((element, keyboardHeight) => {
                const expected = element.parentElement!.clientHeight - keyboardHeight;
                const finalHeight = Math.abs(element.getBoundingClientRect().height - expected) < 1;
                const animating = element.getAnimations().some((animation) => {
                    const end = animation.effect?.getComputedTiming().endTime;
                    return (
                        typeof end === 'number' &&
                        Number.isFinite(end) &&
                        (animation.playState === 'running' || animation.pending)
                    );
                });
                return finalHeight && !animating;
            }, height),
        )
        .toBe(true);
    // A paint between frames also lets compositor hit regions catch up with
    // the finished geometry. The separate four-point hit assertion remains
    // strict: a genuinely covered or clipped composer still fails.
    await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
}

async function hitTarget(page: Page, target: Locator, keyboardHeight: number, minWidth = 44) {
    await expect(target).toBeVisible();
    const geometry = await target.evaluate((element, height) => {
        const rect = element.getBoundingClientRect();
        const frame = document.querySelector('[data-testid="page-frame"]')!.getBoundingClientRect();
        const nav = document.querySelector('[data-testid="app-bottom-nav"]')!.getBoundingClientRect();
        const bottom = Math.min(frame.bottom, height ? innerHeight - height : nav.top);
        const points = [
            [rect.left + 3, rect.top + rect.height / 2],
            [rect.right - 3, rect.top + rect.height / 2],
            [rect.left + rect.width / 2, rect.top + 3],
            [rect.left + rect.width / 2, rect.bottom - 3],
        ];
        const hits = points.map(([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            return {
                x,
                y,
                tag: hit?.tagName,
                label: hit?.getAttribute('aria-label'),
                testid: (hit as HTMLElement)?.dataset?.testid,
                className: hit?.className,
                accepted: hit === element || element.contains(hit),
            };
        });
        const chat = element.closest('[data-chat-page]');
        return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            frameLeft: frame.left,
            frameRight: frame.right,
            frameTop: frame.top,
            visibleBottom: bottom,
            hittable: hits.every((hit) => hit.accepted),
            hits,
            chat: chat
                ? {
                      rect: chat.getBoundingClientRect().toJSON(),
                      style: chat.getAttribute('style'),
                      animations: chat.getAnimations().map((animation) => ({
                          state: animation.playState,
                          currentTime: animation.currentTime,
                          timing: animation.effect?.getComputedTiming(),
                      })),
                  }
                : null,
        };
    }, keyboardHeight);
    expect(
        geometry,
        `Visible, unclipped hit target: ${await target.getAttribute('aria-label')} ${JSON.stringify(geometry)}`,
    ).toMatchObject({
        hittable: true,
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.width).toBeGreaterThanOrEqual(minWidth);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.frameTop - 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.visibleBottom + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.frameLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.frameRight);
}

async function stationaryHost(page: Page) {
    expect(
        await page.getByTestId('route-wrapper').evaluate((element) => ({
            scroll: element.scrollTop,
            extraPadding: element.style.paddingBottom,
            overflow: getComputedStyle(element).overflowY,
        })),
    ).toEqual({ scroll: 0, extraPadding: '', overflow: 'hidden' });
    expect(await page.locator('#app-scroll-container').evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.getByTestId('page-frame').evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const header = await page.getByTestId('app-brand-header').boundingBox();
    expect(header!.y).toBe(0);
    const heading = page.getByRole('heading', { level: 1 });
    const frame = await page.getByTestId('page-frame').boundingBox();
    const title = await heading.boundingBox();
    const ancestors = await heading.evaluate((element) => {
        const values = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            values.push({ class: parent.className, scroll: parent.scrollTop, top: parent.getBoundingClientRect().top });
        }
        return values;
    });
    expect(title!.y, `Conversation header ancestors: ${JSON.stringify(ancestors)}`).toBeGreaterThanOrEqual(frame!.y);
}

for (const size of SIZES) {
    test(`Scuttlebutt channel history and native keyboard stay within the app host on ${size.name}`, async ({
        page,
    }) => {
        await open(page, size, 'long');
        await page.getByRole('button', { name: 'General', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Type a message', exact: true });
        const send = page.getByRole('button', { name: 'Send message', exact: true });
        await expect(input).toBeVisible();
        await keyboard(page, 0);
        await hitTarget(page, input, 0, 60);
        await hitTarget(page, send, 0);
        await stationaryHost(page);
        const scroll = page.locator('[data-testid="route-wrapper"] .overscroll-contain');
        expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
        await scroll.evaluate((element) => {
            element.scrollTop = 0;
        });
        await input.click();
        await keyboard(page, size.keyboard);
        await hitTarget(page, input, size.keyboard, 60);
        await hitTarget(page, send, size.keyboard);
        await stationaryHost(page);
        if (size.name === 'iPhone')
            await page.screenshot({ path: test.info().outputPath('channel-native-keyboard-open.png') });
        await input.fill('The harbour is ready for our arrival.');
        await send.click();
        await expect(input).toHaveValue('');
        await expect(page.getByText('The harbour is ready for our arrival.', { exact: true })).toBeVisible();
        await keyboard(page, 0);
        await hitTarget(page, input, 0, 60);
        await stationaryHost(page);
    });

    test(`Scuttlebutt empty DM composer and block confirmation stay reachable on ${size.name}`, async ({ page }) => {
        await open(page, size, 'empty');
        await page.getByRole('button', { name: 'Open direct messages', exact: true }).click();
        await page.getByRole('listitem', { name: 'Message Sparrow', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'Message Sparrow', exact: true });
        const send = page.getByRole('button', { name: 'Send direct message', exact: true });
        await expect(input).toBeVisible();
        await keyboard(page, 0);
        await hitTarget(page, input, 0, 60);
        await hitTarget(page, send, 0);
        await stationaryHost(page);
        if (size.name === 'iPhone') await page.screenshot({ path: test.info().outputPath('dm-keyboard-closed.png') });
        await page.getByRole('button', { name: 'Block user', exact: true }).click();
        const block = page.getByRole('button', { name: 'Block Sparrow', exact: true });
        const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
        await hitTarget(page, block, 0);
        await hitTarget(page, cancel, 0);
        await stationaryHost(page);
        if (size.name === 'iPhone')
            await page.screenshot({ path: test.info().outputPath('dm-block-confirmation.png') });
        await cancel.click();
        await input.click();
        await keyboard(page, size.keyboard);
        await hitTarget(page, input, size.keyboard, 60);
        await hitTarget(page, send, size.keyboard);
        await stationaryHost(page);
        if (size.name === 'iPhone')
            await page.screenshot({ path: test.info().outputPath('dm-native-keyboard-open.png') });
        await input.fill('Good morning Sparrow, see you at the marina.');
        await send.click();
        await expect(input).toHaveValue('');
        await expect(page.getByText('Good morning Sparrow, see you at the marina.', { exact: true })).toBeVisible();
        await keyboard(page, 0);
        await hitTarget(page, input, 0, 60);
        await hitTarget(page, send, 0);
        await stationaryHost(page);
    });
}

test('Scuttlebutt populated DM also supports browser visual-viewport keyboard resizing', async ({ page }) => {
    const size = SIZES[1];
    await open(page, size, 'long', 'web');
    await page.getByRole('button', { name: 'Open direct messages', exact: true }).click();
    await page.getByRole('listitem', { name: 'Message Sparrow', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Sparrow', exact: true });
    await input.click();
    await keyboard(page, size.keyboard, false);
    expect(await page.evaluate(() => window.visualViewport!.height)).toBe(size.height - size.keyboard);
    await hitTarget(page, input, size.keyboard, 60);
    await hitTarget(page, page.getByRole('button', { name: 'Send direct message', exact: true }), size.keyboard);
    await stationaryHost(page);
});

test('Scuttlebutt pane hit checks wait for a delayed keyboard layout transition', async ({ page }) => {
    const size = SIZES[3];
    await open(page, size, 'empty');
    await page.getByRole('button', { name: 'Open direct messages', exact: true }).click();
    await page.getByRole('listitem', { name: 'Message Sparrow', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Sparrow', exact: true });
    await keyboard(page, 0);
    // A pending rendering transition is a valid intermediate state, not the
    // settled keyboard layout. Keep the same geometry and four edge-hit
    // assertions; the helper must wait for the real final layout to exist.
    await page.addStyleTag({ content: '[data-chat-page] { transition-delay: 700ms !important; }' });
    await input.click();
    await keyboard(page, size.keyboard);
    await hitTarget(page, input, size.keyboard, 60);
    await hitTarget(page, page.getByRole('button', { name: 'Send direct message', exact: true }), size.keyboard);
    await stationaryHost(page);
    // Negative control: waiting for settled layout must never accept an
    // actually covered input. Cover its already-settled hit region and prove
    // the same strict assertion still rejects it.
    await input.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const cover = document.createElement('div');
        cover.dataset.testid = 'intentional-hit-obstruction';
        Object.assign(cover.style, {
            position: 'fixed',
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            zIndex: '2147483647',
        });
        document.body.append(cover);
    });
    await expect(hitTarget(page, input, size.keyboard, 60)).rejects.toThrow('Visible, unclipped hit target');
});

test('Scuttlebutt permission failure leaves an accessible retry and block controls on a small phone', async ({
    page,
}) => {
    await open(page, SIZES[0], 'empty', 'native', '&permissions=retry');
    await page.getByRole('button', { name: 'Open direct messages', exact: true }).click();
    await page.getByRole('listitem', { name: 'Message Sparrow', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Sparrow', exact: true });
    const send = page.getByRole('button', { name: 'Send direct message', exact: true });
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(page.getByText('Unable to verify blocking. Retry before sending a message.')).toBeVisible();
    await input.fill('Keep this unsent draft through permission retry.');
    await expect(send).toBeDisabled();
    await input.press('Enter');
    await expect(input).toHaveValue('Keep this unsent draft through permission retry.');
    await hitTarget(page, retry, 0);
    await retry.click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('Keep this unsent draft through permission retry.');
    await hitTarget(page, input, 0, 60);
    await page.getByRole('button', { name: 'Block user', exact: true }).click();
    const block = page.getByRole('button', { name: 'Block Sparrow', exact: true });
    await hitTarget(page, block, 0);
    await block.click();
    await expect(page.getByText('You have blocked this sailor.', { exact: true })).toBeVisible();
    const unblock = page.getByRole('button', { name: 'Unblock user', exact: true }).last();
    await hitTarget(page, unblock, 0);
    await unblock.click();
    const confirm = page.getByRole('button', { name: 'Unblock Sparrow', exact: true });
    await hitTarget(page, confirm, 0);
    await confirm.click();
    await expect(input).toBeEnabled();
    await hitTarget(page, input, 0, 60);
    await stationaryHost(page);
});
