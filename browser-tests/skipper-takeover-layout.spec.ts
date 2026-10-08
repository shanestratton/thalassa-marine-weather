import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * A forgotten device stops holding the boat's public page (build 125, 125-12).
 * Shane 2026-10-09 at the marina: "tapping 'Publish from this device' on the
 * Vessel page will fix it - - i cannot find that message??"
 *
 * The real Log notice with its in-place takeover, the confirm it opens, and
 * the Vessel skipper card with the Pi primary and a forgotten claim — the
 * state where the card used to offer no button at all — under a copy of the
 * app's header and tab bar (e2e/fixtures/skipper-takeover.tsx). House rules
 * measured, not assumed: at 320 × 568 in wide fonts (Verdana on a Mac, DejaVu
 * Sans on the Linux runner) every button is whole, at least 44 pt tall, not
 * covered and above the tab bar; nothing runs sideways; the confirm is centred
 * and clear of the tab bar; the card keeps its fixed height with its new
 * "Public page" line inside it.
 */

const SIZES = [
    { name: '320x568', width: 320, height: 568 },
    { name: '375x667', width: 375, height: 667 },
    { name: '390x844', width: 390, height: 844 },
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
    await applyWideFonts(page);
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/skipper-takeover.html?${query}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 25_000 });
    await settle(page);
    return errors;
}

/** A control is on screen, whole, hit-testable, ≥ 44 pt and above the tab bar. */
async function expectReachable(page: Page, name: string) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await expect
        .poll(() =>
            button.evaluate((element) => {
                const r = element.getBoundingClientRect();
                return [r.top + 3, r.top + r.height / 2, r.bottom - 3].every((y) => {
                    const hit = document.elementFromPoint(r.left + r.width / 2, y);
                    return !!hit && (hit === element || element.contains(hit));
                });
            }),
        )
        .toBe(true);
    const geometry = await button.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, navTop: nav.top };
    });
    expect(geometry.height, `${name} is a 44 pt target`).toBeGreaterThanOrEqual(43.5);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom, `${name} ends above the tab bar`).toBeLessThanOrEqual(geometry.navTop + 0.5);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    return button;
}

/** Let the page's finite animations end: a dialog measured mid zoom-in is 95 % of its size. */
async function settle(page: Page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const finite = document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.race([
            Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
            new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
    });
}

async function expectNothingSideways(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
}

/** The takeover confirm: centred, clear of the tab bar, whole, both actions reachable. */
async function expectConfirmFits(page: Page, holder: RegExp) {
    const dialog = page.getByRole('dialog', { name: 'Take over skipper publishing?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(holder);
    await settle(page);
    const geometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[role="dialog"] [data-pane-dialog-panel]')!;
        const box = panel.getBoundingClientRect();
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const escapes = [...panel.querySelectorAll<HTMLElement>('*')].some((element) => {
            const r = element.getBoundingClientRect();
            return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1);
        });
        return {
            left: box.left,
            right: window.innerWidth - box.right,
            top: box.top,
            bottom: box.bottom,
            viewport: window.innerHeight,
            navTop: nav.top,
            cut: panel.scrollHeight > panel.clientHeight + 1,
            sideways: panel.scrollWidth > panel.clientWidth + 1,
            escapes,
        };
    });
    expect(Math.abs(geometry.left - geometry.right), 'centred across').toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.top - (geometry.viewport - geometry.bottom)), 'centred down').toBeLessThanOrEqual(1);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom, 'clear of the tab bar').toBeLessThanOrEqual(geometry.navTop + 0.5);
    expect(geometry.cut, 'nothing cut off').toBe(false);
    expect(geometry.sideways).toBe(false);
    expect(geometry.escapes).toBe(false);
    await expectReachable(page, 'Take over');
    await expectReachable(page, 'Cancel');
}

async function shoot(page: Page, info: TestInfo, label: string) {
    const path = info.outputPath(`${label}-${info.project.name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(label, { path, contentType: 'image/png' });
}

for (const size of SIZES) {
    test(`the Log notice takes over in place at ${size.name}, under the real header, in wide fonts`, async ({
        page,
    }, info) => {
        const errors = await open(page, size, 'view=log&claim=forgotten');
        const notice = page.getByTestId('skipper-claim-notice-text');
        await expect(notice).toContainText('iPhone/iPad · 7e1a holds your public page');
        await expect(notice).toContainText('(claimed 32 days ago)');
        await expectWideFaceDrawn(notice);

        // The whole notice sits between the header and the tab bar.
        const placement = await page.evaluate(() => {
            const card = document.querySelector('[data-testid="skipper-claim-notice-text"]')!.closest('.rounded-2xl')!;
            const r = card.getBoundingClientRect();
            const header = document.querySelector('[data-testid="app-header"]')!.getBoundingClientRect();
            const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, headerBottom: header.bottom, navTop: nav.top };
        });
        expect(placement.top).toBeGreaterThanOrEqual(placement.headerBottom);
        expect(placement.bottom, 'the notice ends above the tab bar').toBeLessThanOrEqual(placement.navTop + 0.5);
        const publish = await expectReachable(page, 'Publish from this device');
        await expectNothingSideways(page);
        if (size.width === 320) await shoot(page, info, 'log-notice-320x568');

        await publish.click();
        await expectConfirmFits(page, /iPhone\/iPad · 7e1a holds your public page — claimed 32 days ago/);
        if (size.width === 320) await shoot(page, info, 'log-confirm-320x568');

        await page.getByRole('button', { name: 'Take over', exact: true }).click();
        await expect(page.getByTestId('claim-holder')).toHaveText('dev-fictional-this-phone-9f3a');
        await expect(page.getByText('Recording, not publishing')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test(`the Vessel card offers the takeover with the Pi primary at ${size.name}, in its fixed height`, async ({
        page,
    }, info) => {
        const errors = await open(page, size, 'view=vessel&claim=forgotten&pi=1');
        const card = page.getByTestId('skipper-device-card');
        await expect(card).toBeVisible();
        await expect(page.getByText('Position: the Pi')).toBeVisible();
        await expect(page.getByTestId('skipper-device-publisher')).toHaveText(
            'Public page: iPhone/iPad · 7e1a · claimed 32 days ago',
        );
        await expectWideFaceDrawn(page.getByTestId('skipper-device-publisher'));

        const fit = await card.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const inner = {
                top: box.top + parseFloat(style.borderTopWidth),
                bottom: box.bottom - parseFloat(style.borderBottomWidth),
                left: box.left + parseFloat(style.borderLeftWidth),
                right: box.right - parseFloat(style.borderRightWidth),
            };
            const outside = [...element.querySelectorAll<HTMLElement>('*')]
                .filter((child) => !child.classList.contains('sr-only') && !child.closest('.sr-only'))
                .map((child) => ({ child, r: child.getBoundingClientRect() }))
                .filter(({ r }) => r.width > 0 && r.height > 0)
                .filter(
                    ({ r }) =>
                        r.top < inner.top - 0.5 ||
                        r.bottom > inner.bottom + 0.5 ||
                        r.left < inner.left - 0.5 ||
                        r.right > inner.right + 0.5,
                )
                .map(({ child }) => `${child.tagName} "${child.textContent?.trim().slice(0, 24)}"`);
            const title = element.querySelector('.skipper-device-title')!.getBoundingClientRect();
            const pi = [...element.querySelectorAll('span')].find((span) => span.textContent === 'Position: the Pi')!;
            const piBox = pi.getBoundingClientRect();
            const publisher = element.querySelector('[data-testid="skipper-device-publisher"]')!;
            const row = element.querySelector('.skipper-device-gps')!.getBoundingClientRect();
            return {
                height: box.height,
                cssHeight: parseFloat(style.height),
                cut: element.scrollHeight > element.clientHeight + 1,
                outside,
                piWhole: piBox.right <= title.right + 0.5 && pi.scrollWidth <= pi.clientWidth + 1,
                publisherOneLine: publisher.getBoundingClientRect().height <= row.height + 0.5,
            };
        });
        expect(fit.height, 'the card keeps its fixed height').toBeCloseTo(fit.cssHeight, 0);
        expect(fit.cut, 'nothing in the card is cut off').toBe(false);
        expect(fit.outside, 'everything sits inside the card').toEqual([]);
        expect(fit.piWhole, '"Position: the Pi" is never truncated').toBe(true);
        expect(fit.publisherOneLine, 'the publisher line stays on its row').toBe(true);

        const publish = await expectReachable(page, 'Publish from this device');
        await expectNothingSideways(page);
        if (size.width === 320) await shoot(page, info, 'vessel-card-pi-320x568');

        await publish.click();
        await expectConfirmFits(page, /iPhone\/iPad · 7e1a holds your public page/);
        await page.getByRole('button', { name: 'Take over', exact: true }).click();
        await expect(page.getByTestId('claim-holder')).toHaveText('dev-fictional-this-phone-9f3a');
        await expect(page.getByTestId('skipper-device-publisher')).toHaveText('Public page: this phone');
        await expect(page.getByTestId('skipper-device-pi-primary')).toHaveText('The Pi is the Primary Device');
        expect(errors).toEqual([]);
    });
}

test('a long device name truncates on the card rows instead of pushing the button out (320x568)', async ({
    page,
}, info) => {
    const errors = await open(page, { width: 320, height: 568 }, 'view=vessel&claim=long&pi=0');
    const status = page.getByTestId('skipper-device-status');
    await expect(status).toContainText('Primary: Wandering Albatross');
    const row = await status.evaluate((element) => ({
        truncated: element.scrollWidth > element.clientWidth,
        height: element.getBoundingClientRect().height,
        rowHeight: element.closest('.skipper-device-gps')!.getBoundingClientRect().height,
    }));
    expect(row.truncated).toBe(true);
    expect(row.height).toBeLessThanOrEqual(row.rowHeight + 0.5);
    await expectReachable(page, 'Publish from this device');
    await expectNothingSideways(page);
    await shoot(page, info, 'vessel-card-long-name-320x568');
    expect(errors).toEqual([]);
});
