import { test, expect, type Locator, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

const CHANNEL_ID = '00000000-0000-4000-8000-000000000109';
const CHANNEL_NAME = 'Layout Harbour';
const traffic = new WeakMap<
    Page,
    { channelReads: number; messageReads: number; writes: string[]; failures: string[] }
>();

async function expectComposeTarget(target: Locator, keyboardHeight = 0) {
    await expect(target).toBeVisible();
    const bounds = await target.evaluate((element, height) => {
        const rect = element.getBoundingClientRect();
        const root = element.closest('[data-chat-page]')!.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const ancestors = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const bounds = parent.getBoundingClientRect();
            const style = getComputedStyle(parent);
            ancestors.push({
                tag: parent.tagName,
                className: parent.className,
                top: bounds.top,
                height: bounds.height,
                scrollTop: parent.scrollTop,
                scrollHeight: parent.scrollHeight,
                clientHeight: parent.clientHeight,
                inlineHeight: parent.style.height,
                overflow: style.overflowY,
                paddingBottom: style.paddingBottom,
            });
        }
        return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            rootTop: root.top,
            availableBottom: Math.min(root.bottom, height ? innerHeight - height : nav.top),
            horizontallyContained: rect.left >= root.left && rect.right <= root.right,
            diagnostic: {
                innerHeight,
                visualViewportHeight: window.visualViewport?.height,
                keyboardCss: getComputedStyle(document.documentElement).getPropertyValue('--thalassa-keyboard-height'),
                ancestors,
            },
            hittable: [
                [rect.left + 3, rect.top + rect.height / 2],
                [rect.right - 3, rect.top + rect.height / 2],
                [rect.left + rect.width / 2, rect.top + 3],
                [rect.left + rect.width / 2, rect.bottom - 3],
            ].every(([x, y]) => {
                const hit = document.elementFromPoint(x, y);
                return hit === element || element.contains(hit);
            }),
        };
    }, keyboardHeight);
    expect(bounds, JSON.stringify(bounds)).toMatchObject({ horizontallyContained: true, hittable: true });
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.rootTop);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.availableBottom + 1);
}

async function expectStationaryChat(page: Page, expectedTop?: number) {
    const geometry = await page.locator('[data-chat-page]').evaluate((element) => {
        const root = element.getBoundingClientRect();
        const heading = element.querySelector('h1')!.getBoundingClientRect();
        const scrolledAncestors = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.scrollTop !== 0) {
                scrolledAncestors.push({ className: ancestor.className, scrollTop: ancestor.scrollTop });
            }
        }
        return { top: root.top, height: root.height, headingTop: heading.top, scrolledAncestors };
    });
    expect(geometry.scrolledAncestors).toEqual([]);
    expect(geometry.headingTop).toBeGreaterThanOrEqual(geometry.top);
    if (expectedTop !== undefined) expect(geometry.top).toBeCloseTo(expectedTop, 0);
    return geometry;
}

async function openChannel(page: Page) {
    await page.getByRole('button', { name: CHANNEL_NAME, exact: true }).click();
    await expect(page.getByRole('heading', { name: new RegExp(CHANNEL_NAME) })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Channel messages', exact: true })).toBeVisible();
    await expect(
        page.getByText('Layout harbour update 45: the crew can read this local message.', { exact: true }),
    ).toBeInViewport();
    expect(traffic.get(page)!.messageReads).toBeGreaterThan(0);
    return {
        input: page.getByRole('textbox', { name: 'Type a message', exact: true }),
        send: page.getByRole('button', { name: 'Send message', exact: true }),
    };
}

async function keyboard(page: Page, height: number) {
    await page.evaluate(
        (value) => window.dispatchEvent(new CustomEvent('test:chat-keyboard', { detail: value })),
        height,
    );
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', height ? 'true' : 'false');
    // The shared bridge updates html synchronously; React commits the resized
    // chat on its next render. Wait for the actual layout, not just that flag.
    const chat = page.locator('[data-chat-page]');
    const parentHeight = await chat.evaluate((element) => element.parentElement!.getBoundingClientRect().height);
    await expect
        .poll(async () => Math.round((await chat.boundingBox())!.height))
        .toBe(Math.round(parentHeight - height));
    // Let the real 0/120/360ms focus guard and 500ms channel-history pass
    // finish before asserting final compiled-app geometry.
    await page.waitForTimeout(550);
}

test.describe('Chat — Scuttlebutt production layout', () => {
    test.use({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
        storageState: async ({ baseURL }, provide) => {
            await provide({
                ...ONBOARDED_STORAGE,
                origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
            });
        },
    });

    test.beforeEach(async ({ page, baseURL }) => {
        const observed = { channelReads: 0, messageReads: 0, writes: [] as string[], failures: [] as string[] };
        traffic.set(page, observed);
        page.on('requestfailed', (request) => {
            const url = new URL(request.url());
            if (/\/rest\/v1\/chat_/.test(url.pathname)) {
                observed.failures.push(`${request.method()} ${url.pathname}: ${request.failure()?.errorText}`);
            }
        });
        const origin = new URL(baseURL!).origin;
        const now = Date.now();
        const channel = {
            id: CHANNEL_ID,
            name: CHANNEL_NAME,
            description: 'Local browser smoke',
            region: null,
            icon: '💬',
            is_global: true,
            is_private: false,
            owner_id: null,
            parent_id: null,
            status: 'active',
            created_at: new Date(now).toISOString(),
        };
        const messages = Array.from({ length: 45 }, (_, index) => ({
            id: `local-layout-${index + 1}`,
            channel_id: CHANNEL_ID,
            user_id: 'self',
            display_name: 'You',
            message: `Layout harbour update ${index + 1}: the crew can read this local message.`,
            is_question: false,
            helpful_count: 0,
            is_pinned: false,
            deleted_at: null,
            created_at: new Date(now - (44 - index) * 60_000).toISOString(),
        })).reverse(); // Real service requests newest first, then reverses for display.

        // Install every transport boundary BEFORE app boot. Only public REST
        // reads get fixture rows; no authentication, customer writes, live
        // realtime connection or actual Send action is needed for this smoke.
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.route('**/*', async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const method = request.method();
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
                if (/\/rest\/v1\/chat_/.test(url.pathname)) observed.writes.push(`${method} ${url.pathname}`);
                return route.abort();
            }
            const channelRead = url.pathname === '/rest/v1/chat_channels';
            const messageRead = url.pathname === '/rest/v1/chat_messages';
            if (channelRead || messageRead) {
                const cors = {
                    'access-control-allow-origin': origin,
                    'access-control-allow-credentials': 'true',
                    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
                    'access-control-allow-headers':
                        request.headers()['access-control-request-headers'] ||
                        'authorization, apikey, content-type, x-client-info, accept-profile, prefer',
                    'access-control-expose-headers': 'content-range',
                };
                if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
                if (channelRead) observed.channelReads++;
                if (messageRead) observed.messageReads++;
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: { ...cors, 'content-range': messageRead ? '0-44/45' : '0-0/1' },
                    body: JSON.stringify(channelRead ? [channel] : messages),
                });
            }
            return url.origin === origin ? route.continue() : route.abort();
        });
        await page.addInitScript(() => {
            // No fixture component imports: only model browser visualViewport.
            // The production bridge and actual App ancestors remain untouched.
            // Native None is covered by the source-level real-ChatPage matrix.
            const viewport = new EventTarget();
            Object.assign(viewport, { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
            let cover: HTMLDivElement | undefined;
            window.addEventListener('test:chat-keyboard', ((event: CustomEvent<number>) => {
                if (!cover) {
                    cover = document.createElement('div');
                    cover.textContent = 'Keyboard viewport simulation';
                    Object.assign(cover.style, {
                        position: 'fixed',
                        inset: 'auto 0 0',
                        background: '#334155',
                        color: '#fff',
                        zIndex: '2147483647',
                    });
                    document.body.append(cover);
                }
                cover.style.height = `${event.detail}px`;
                cover.style.display = event.detail ? 'block' : 'none';
                Object.assign(viewport, { height: innerHeight - event.detail });
                viewport.dispatchEvent(new Event('resize'));
            }) as EventListener);
        });

        await page.goto('/');
        await page.getByRole('tab', { name: 'Navigate to Vessel', exact: true }).click();
        await page.getByRole('button', { name: 'Open Scuttlebutt', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Scuttlebutt', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: CHANNEL_NAME, exact: true })).toBeVisible();
        expect(observed.channelReads).toBeGreaterThan(0);
    });

    test.afterEach(async ({ page }, testInfo) => {
        await testInfo.attach('mock-chat-transport', {
            body: JSON.stringify(traffic.get(page)),
            contentType: 'application/json',
        });
        expect(traffic.get(page)?.writes ?? [], 'This anonymous layout smoke must not attempt a chat write').toEqual(
            [],
        );
    });

    test('Vessel navigation opens the public channel and readable message history', async ({ page }) => {
        await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveCount(0);
        const { input, send } = await openChannel(page);
        await expectComposeTarget(input);
        await expectComposeTarget(send);
        await expectStationaryChat(page);
        await expect(send).toBeDisabled();
    });

    test('channel input and Send stay above navigation and the keyboard without sending', async ({ page }) => {
        const { input, send } = await openChannel(page);
        await expectComposeTarget(input);
        await expectComposeTarget(send);
        const before = await expectStationaryChat(page);
        await input.fill('Unsent local smoke-test draft.');
        await expect(send).toBeEnabled();
        await keyboard(page, 344);
        expect(await page.evaluate(() => innerHeight)).toBe(844);
        expect(await page.evaluate(() => window.visualViewport!.height)).toBe(500);
        await expectComposeTarget(input, 344);
        await expectComposeTarget(send, 344);
        const open = await expectStationaryChat(page, before.top);
        expect(before.height - open.height).toBeCloseTo(344, 0);
        await page.screenshot({ path: test.info().outputPath('production-channel-keyboard-open.png') });
        await input.blur();
        await keyboard(page, 0);
        await expect(input).toHaveValue('Unsent local smoke-test draft.');
        await expectComposeTarget(input);
        await expectComposeTarget(send);
        await expectStationaryChat(page, before.top);
    });

    test('Back returns through channels to Vessel and the composer reopens in place', async ({ page }) => {
        const { input } = await openChannel(page);
        await expectComposeTarget(input);
        await page.locator('[data-chat-page]').getByRole('button', { name: 'Go back', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Scuttlebutt', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: CHANNEL_NAME, exact: true })).toBeVisible();
        await expect(input).toHaveCount(0);
        await page.locator('[data-chat-page]').getByRole('button', { name: 'Go back', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Open Scuttlebutt', exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Navigate to Vessel', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await page.getByRole('button', { name: 'Open Scuttlebutt', exact: true }).click();
        const reopened = await openChannel(page);
        await expectComposeTarget(reopened.input);
        await expectComposeTarget(reopened.send);
        await expectStationaryChat(page);
    });
});
