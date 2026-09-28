import { expect, test, type Locator, type Page } from '@playwright/test';

const idleMs = 6000;

async function openFixture(page: Page, baseURL: string, extras = '') {
    const origin = new URL(baseURL).origin;
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
            failures.push(`Unexpected request: ${url.origin}${url.pathname}`);
            return route.abort();
        }
        return route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.clock.install({ time: new Date('2026-09-27T06:00:00Z') });
    await page.goto(`/e2e/fixtures/weather-controls.html?autohide=1${extras}`);
    const panel = page.getByRole('region', { name: extras ? 'Chart layer controls' : 'Weather controls', exact: true });
    await expect(panel).toBeVisible();
    // Allow normal page/React initialization before taking control of time.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
    return { panel, fixture: page.getByTestId('weather-fixture'), failures };
}

async function activate(target: Locator, touch: boolean) {
    if (touch) await target.tap();
    else await target.click();
}

async function expectCompactPill(page: Page, layerControls = false) {
    const pill = page.getByTestId('weather-status-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAccessibleName(layerControls ? 'Show layer controls' : 'Show weather controls');
    const geometry = await pill.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
            height: box.height,
            width: box.width,
            inView: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            noOverflow:
                element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
            receivesInput: !!hit && element.contains(hit),
        };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeLessThanOrEqual(64);
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.inView).toBe(true);
    expect(geometry.noOverflow).toBe(true);
    expect(geometry.receivesInput).toBe(true);
    return pill;
}

async function tabOutsidePanel(page: Page, panel: Locator) {
    for (let attempt = 0; attempt < 15; attempt++) {
        await page.keyboard.press('Tab');
        if (!(await panel.evaluate((element) => element.contains(document.activeElement)))) {
            // WebKit's default Tab order can leave the document for browser
            // chrome. Window blur deliberately suspends the idle timer, so
            // return to a real outside control before testing foreground idle.
            if (!(await page.evaluate(() => document.hasFocus()))) {
                await page.getByRole('button', { name: 'OBS', exact: true }).click();
            }
            expect(await page.evaluate(() => document.hasFocus())).toBe(true);
            return;
        }
    }
    throw new Error('Keyboard focus could not leave weather controls');
}

test('idle collapses to a compact non-blocking status pill; reveal and real interaction restart the timer', async ({
    page,
    baseURL,
    isMobile,
}, info) => {
    const { panel, fixture, failures } = await openFixture(page, baseURL!);
    await page.clock.runFor(idleMs + 100);
    await expect(panel).toHaveCount(0);
    let pill = await expectCompactPill(page);
    await page.screenshot({ path: info.outputPath('weather-status-pill.png'), animations: 'disabled' });
    // This map button occupies the expanded control panel's area, not the pill.
    await activate(page.getByTestId('fixture-map-target'), isMobile);
    await expect(fixture).toHaveAttribute('data-map-clicks', '1');
    await activate(pill, isMobile);
    await expect(panel).toBeVisible();
    await page.clock.runFor(4000);
    await activate(page.getByRole('button', { name: 'Control Rain', exact: true }), isMobile);
    await page.clock.runFor(idleMs - 10);
    await expect(panel).toBeVisible();
    await page.clock.runFor(30);
    await expect(panel).toHaveCount(0);
    pill = await expectCompactPill(page);
    await activate(pill, isMobile);
    await expect(page.getByRole('button', { name: 'Control Rain', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    // Merely hovering over the panel must not turn auto-hide into a permanent pin.
    await panel.hover();
    await page.clock.runFor(idleMs + 100);
    await expect(panel).toHaveCount(0);
    await expectCompactPill(page);
    expect(failures).toEqual([]);
});

test('playback and selection survive hiding; the compact status updates without reopening', async ({
    page,
    baseURL,
    isMobile,
}) => {
    const { panel, fixture, failures } = await openFixture(page, baseURL!);
    await activate(page.getByRole('button', { name: 'Wind model JMA', exact: true }), isMobile);
    await activate(page.getByRole('button', { name: 'Control Rain', exact: true }), isMobile);
    await activate(page.getByRole('button', { name: 'Play', exact: true }), isMobile);
    await expect(fixture).toHaveAttribute('data-rain-playing', 'true');
    await page.clock.runFor(idleMs + 100);
    await expect(panel).toHaveCount(0);
    const pill = await expectCompactPill(page);
    const visibleLines = pill.locator(':scope > span').nth(1);
    const before = await visibleLines.innerText();
    const beforeIndex = await fixture.getAttribute('data-rain-frame');
    await page.clock.runFor(1100);
    await expect(panel).toHaveCount(0);
    await expect(fixture).toHaveAttribute('data-rain-playing', 'true');
    await expect(fixture).not.toHaveAttribute('data-rain-frame', beforeIndex!);
    await expect(visibleLines).not.toHaveText(before);
    const index = Number(await fixture.getAttribute('data-rain-frame'));
    await expect(visibleLines).toContainText(['06:00', '06:10', '06:30', '07:30'][index]);
    await activate(pill, isMobile);
    await expect(page.getByRole('button', { name: 'Control Rain', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await activate(page.getByRole('button', { name: 'Control Wind', exact: true }), isMobile);
    await expect(page.getByRole('button', { name: 'Wind model JMA', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(fixture).toHaveAttribute('data-rain-playing', 'true');
    expect(failures).toEqual([]);
});

test('a held scrub and keyboard focus defer collapse until interaction finishes', async ({
    page,
    baseURL,
    isMobile,
}) => {
    const { panel, failures } = await openFixture(page, baseURL!);
    const slider = page.getByRole('slider', { name: 'Wind timeline', exact: true });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.clock.runFor(idleMs + 1500);
    await expect(panel).toBeVisible();
    await page.mouse.up();
    await page.mouse.move(20, 20);
    await page.clock.runFor(idleMs - 10);
    await expect(panel).toBeVisible();
    await page.clock.runFor(30);
    await expect(panel).toHaveCount(0);
    await activate(await expectCompactPill(page), isMobile);
    await slider.press('ArrowRight');
    await expect(slider).toBeFocused();
    await page.clock.runFor(idleMs + 1500);
    await expect(panel).toBeVisible();
    await tabOutsidePanel(page, panel);
    await page.clock.runFor(idleMs + 100);
    await expect(panel).toHaveCount(0);
    expect(failures).toEqual([]);
});

test('a focused native selector holds the combined panel open until focus leaves', async ({
    page,
    baseURL,
    isMobile,
}) => {
    const { panel, failures } = await openFixture(page, baseURL!, '&extras=select');
    await activate(page.getByRole('button', { name: 'Show layer key', exact: true }), isMobile);
    const select = page.getByRole('combobox', { name: 'Fixture native selection', exact: true });
    await select.scrollIntoViewIfNeeded();
    await select.focus();
    await expect(select).toBeFocused();
    await page.clock.runFor(idleMs + 1500);
    await expect(panel).toBeVisible();
    await select.selectOption({ label: 'Available reference markers' });
    await tabOutsidePanel(page, panel);
    await page.clock.runFor(idleMs + 100);
    await expect(panel).toHaveCount(0);
    await activate(await expectCompactPill(page, true), isMobile);
    await expect(panel).toBeVisible();
    expect(failures).toEqual([]);
});
