import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

const sizes = [
    { name: '320 phone', width: 320, height: 568 },
    { name: '1024 tablet half pane', width: 1024, height: 768, pane: true },
];

async function assertPaneLayout(page: Page) {
    const problems = await page.evaluate(() => {
        const errors: string[] = [];
        const pane = document.querySelector<HTMLElement>('[data-testid="boat-network-pane"]')!;
        const header = document.querySelector<HTMLElement>('[data-testid="boat-network-header"]')!;
        const scroll = document.querySelector<HTMLElement>('[data-testid="boat-network-scroll"]')!;
        const hardware = document.querySelector<HTMLElement>('[data-boat-hardware]')!;
        const box = pane.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const scrollBox = scroll.getBoundingClientRect();
        const withinWidth = (outer: DOMRect, inner: DOMRect) =>
            inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
        const withinHeight = (outer: DOMRect, inner: DOMRect) =>
            inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
        for (const [label, rect] of [
            ['header', headerBox],
            ['scroll area', scrollBox],
        ] as const) {
            if (!withinWidth(box, rect) || !withinHeight(box, rect)) errors.push(`${label} escapes parent pane`);
        }
        if (scrollBox.top < headerBox.bottom - 1) errors.push('scroll area overlaps page header');
        for (const element of [
            document.documentElement,
            document.body,
            document.getElementById('root')!,
            pane,
            scroll,
            hardware,
        ]) {
            if (element.scrollWidth > element.clientWidth + 1)
                errors.push(
                    `Horizontal overflow: ${element.tagName}.${element.className} (${element.scrollWidth} > ${element.clientWidth})`,
                );
        }
        for (const element of hardware.querySelectorAll<HTMLElement>('*')) {
            if (!element.getClientRects().length) continue;
            if (!withinWidth(scrollBox, element.getBoundingClientRect()))
                errors.push(`Hardware content escapes pane: ${element.tagName} ${element.textContent?.slice(0, 70)}`);
        }
        if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0)
            errors.push('document scrolls instead of the Boat Network pane');
        return errors;
    });
    expect(problems).toEqual([]);
}

async function assertControlReachable(control: Locator) {
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const pane = document.querySelector('[data-testid="boat-network-scroll"]')!.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return (
                    rect.top >= pane.top - 1 &&
                    rect.bottom <= pane.bottom + 1 &&
                    rect.left >= pane.left - 1 &&
                    rect.right <= pane.right + 1 &&
                    (hit === element || element.contains(hit))
                );
            }),
        )
        .toBe(true);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const size of sizes) {
    for (const mode of ['light', 'dark']) {
        test(`Boat Network hardware fits ${size.name} in ${mode}`, async ({ page }, testInfo) => {
            test.setTimeout(60_000);
            // Register before navigation: real component imports must never
            // contact account services, telemetry, or anything on a boat LAN.
            await page.route('**/*', (route) =>
                ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
                    ? route.continue()
                    : route.abort(),
            );
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.goto(`/e2e/fixtures/boat-network-layout.html?mode=${mode}&pane=${!!size.pane}`);
            const toggle = page.getByRole('button', { name: 'Boat hardware & integrations', exact: true });
            const scroll = page.getByTestId('boat-network-scroll');
            const header = page.getByTestId('boat-network-header');
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByRole('heading', { name: 'Pi Cache Server', exact: true })).toHaveCount(0);
            await assertPaneLayout(page);

            const headerBefore = await header.boundingBox();
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(page.getByRole('heading', { name: 'Pi Cache Server', exact: true })).toBeVisible();
            await page.evaluate(async () => {
                await document.fonts.ready;
            });
            // Wait for the real panel's entry animation before measuring it.
            await page.getByRole('heading', { name: 'Pi Cache Server', exact: true }).evaluate(async (element) => {
                const animations = element.closest('[data-boat-hardware]')!.getAnimations({ subtree: true });
                await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
            });
            await assertPaneLayout(page);
            await screenshot(page, testInfo, `boat-hardware-${size.width}-${mode}-expanded`);

            // Scroll the existing pane, without expanding the viewport or
            // relocating the target, to reach the final setup control.
            await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }));
            await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            await assertControlReachable(page.getByRole('button', { name: 'Start Wi-Fi setup', exact: true }));
            await assertPaneLayout(page);
            expect(await header.boundingBox()).toEqual(headerBefore);
            await screenshot(page, testInfo, `boat-hardware-${size.width}-${mode}-end`);

            await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
            await assertControlReachable(toggle);
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(page.getByRole('heading', { name: 'Pi Cache Server', exact: true })).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Start Wi-Fi setup', exact: true })).toHaveCount(0);
            await assertPaneLayout(page);
        });
    }
}

/**
 * "Charts from Kestrel" (127-C-d): this phone's place in the boat's chart
 * vault, in the Boat Pi section, paired with a fictional Kestrel whose Pi is at
 * 192.168.4.20 in the Solent (e2e/fixtures/boat-network-layout.tsx ?charts=).
 * Under the real PageHeader and the real BoatHardwareIntegrations pane, in
 * wide fonts (Verdana on a Mac, DejaVu Sans on Linux), at 320 x 568, 375 x 667
 * and the iPad half pane, in five states plus today's Pi:
 *
 *   - the row is whole in the pane, nothing under the header, nothing sideways;
 *   - the code field stays above a 300 px keyboard;
 *   - "Remove" takes a second tap and opens no modal;
 *   - the device token rides /api/enc/* only, and never a URL.
 */
const chartSizes = [
    { name: '320x568', width: 320, height: 568, pane: false },
    { name: '375x667', width: 375, height: 667, pane: false },
    { name: '1024 half pane', width: 1024, height: 768, pane: true },
];

type KestrelPi = {
    ready: boolean;
    token: string;
    requests: { method: string; path: string; url: string; header: string | null }[];
};
const kestrelPi = (page: Page) => page.evaluate(() => (window as unknown as { __kestrelPi: KestrelPi }).__kestrelPi);

async function openChartsRow(page: Page, size: (typeof chartSizes)[number], state: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
        ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort(),
    );
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/boat-network-layout.html?mode=dark&pane=${size.pane}&charts=${state}`);
    await page.waitForFunction(() => (window as unknown as { __kestrelPi?: KestrelPi }).__kestrelPi?.ready);
    await page.getByRole('button', { name: 'Boat hardware & integrations', exact: true }).click();
    const row = page.getByTestId('charts-from-boat');
    await expect(row).toBeVisible({ timeout: 20_000 });
    const title = row.getByText('Charts from Kestrel', { exact: true });
    await expect(title).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectWideFaceDrawn(title);
    return { row, errors };
}

/** The real panel's sections slide in as they mount (the Pi's go on when it answers): let them land. */
async function settled(page: Page) {
    await page.locator('[data-boat-hardware]').evaluate(async (element) => {
        // The Connected dot pulses for ever: wait only for animations that end.
        const ending = element
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.all(ending.map((animation) => animation.finished.catch(() => undefined)));
    });
}

/** The row is whole inside the scrolling pane: nothing clipped, sideways or under the header. */
async function expectRowWhole(page: Page, row: Locator) {
    await settled(page);
    await row.evaluate((element) => element.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
    const issues = await row.evaluate((element) => {
        const found: string[] = [];
        const scroll = document.querySelector('[data-testid="boat-network-scroll"]')!.getBoundingClientRect();
        const header = document.querySelector('[data-testid="boat-network-header"]')!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        if (box.height > scroll.height + 1) found.push(`taller than the pane (${box.height} > ${scroll.height})`);
        if (box.top < scroll.top - 1 || box.bottom > scroll.bottom + 1) found.push('not whole in the pane');
        if (box.top < header.bottom - 1) found.push('under the header');
        if (element.scrollWidth > element.clientWidth + 1) found.push('scrolls sideways');
        for (const child of element.querySelectorAll<HTMLElement>('*')) {
            if (!child.getClientRects().length) continue;
            const r = child.getBoundingClientRect();
            if (r.left < box.left - 1 || r.right > box.right + 1)
                found.push(`escapes the row: ${child.tagName} ${child.textContent?.slice(0, 50)}`);
        }
        for (const control of element.querySelectorAll<HTMLElement>('button, input')) {
            const r = control.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!hit || !(hit === control || control.contains(hit)))
                found.push(`covered: ${control.textContent || control.getAttribute('aria-label')}`);
            if (r.height < 43.5)
                found.push(`under 44 pt: ${control.textContent || control.getAttribute('aria-label')}`);
        }
        return found;
    });
    expect(issues).toEqual([]);
    await assertPaneLayout(page);
}

/** The code field stays in view, below the header and above a 300 px keyboard. */
async function expectCodeFieldAboveKeyboard(page: Page, row: Locator) {
    const field = row.getByRole('textbox', { name: 'Chart code' });
    await field.click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 300 })));
    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
    await field.fill('hjkmn 4pqrs');
    await expect
        .poll(() =>
            field.evaluate((input) => {
                const r = input.getBoundingClientRect();
                const header = document.querySelector('[data-testid="boat-network-header"]')!.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return r.top >= header.bottom - 1 && r.bottom <= innerHeight - 300 && hit === input;
            }),
        )
        .toBe(true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 0 })));
    return field;
}

for (const size of chartSizes) {
    test.describe(`Charts from Kestrel, ${size.name}`, () => {
        test.setTimeout(60_000);

        test('1. not set up: the code field, above the keyboard, then set up by code', async ({ page }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'not-set-up');
            await expect(row.getByText(/Type the code from Kestrel's Pi/)).toBeVisible();
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-not-set-up-${size.width}`);
            await expectCodeFieldAboveKeyboard(page, row);
            await row.getByRole('button', { name: 'Set up', exact: true }).click();
            await expect(row.getByText(/^This (iPhone|iPad) is set up/)).toBeVisible();
            await expect(row.getByText('1 of 5 devices')).toBeVisible();
            await expectRowWhole(page, row);
            const pi = await kestrelPi(page);
            const enc = pi.requests.filter((r) => r.path.startsWith('/api/enc/'));
            // The enrol carries no token (there is none yet); every call after it does.
            const enrolAt = enc.findIndex((r) => r.path === '/api/enc/devices/enrol');
            expect(enc.slice(enrolAt + 1).length).toBeGreaterThan(0);
            expect(enc.slice(enrolAt + 1).every((r) => r.header === pi.token)).toBe(true);
            expect(pi.requests.filter((r) => !r.path.startsWith('/api/enc/')).every((r) => r.header === null)).toBe(
                true,
            );
            expect(pi.requests.filter((r) => r.url.includes(pi.token))).toEqual([]);
            expect(errors).toEqual([]);
        });

        test('2. set up: 2 of 5 devices, the inline list, and Remove takes a second tap', async ({
            page,
        }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'set-up');
            await expect(row.getByText(/^This (iPhone|iPad) is set up · 1,025 charts on Kestrel/)).toBeVisible();
            await expect(row.getByText('2 of 5 devices')).toBeVisible();
            await expect(row.getByRole('listitem')).toHaveCount(2);
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-set-up-${size.width}`);

            const ipad = row.getByRole('listitem').filter({ hasText: 'iPad' });
            // Two of a kind still read apart: each says when it was added and last seen.
            await expect(ipad.getByText(/^Added (10 Oct|Oct 10)$/)).toBeVisible();
            await expect(ipad.getByText(/^Seen \S+ \S+$/)).toBeVisible();
            const datesWhole = await row.getByRole('listitem').evaluateAll((items) =>
                items.every((li) => {
                    const remove = li.querySelector('button')!.getBoundingClientRect();
                    const dates = [...li.querySelectorAll<HTMLElement>('p:last-of-type > span')];
                    return (
                        dates.length === 2 &&
                        dates.every(
                            (d) =>
                                d.getBoundingClientRect().right <= remove.left + 1 &&
                                d.scrollWidth <= d.clientWidth + 1,
                        )
                    );
                }),
            );
            expect(datesWhole, 'each date whole and clear of Remove').toBe(true);
            await expect(row.getByRole('listitem').filter({ hasText: 'this one' })).toHaveCount(1);
            await ipad.getByRole('button', { name: 'Remove iPad' }).click();
            const confirm = ipad.getByRole('button', { name: 'Tap again to remove iPad' });
            await expect(confirm).toBeVisible();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
            expect((await kestrelPi(page)).requests.filter((r) => r.method === 'DELETE')).toEqual([]);
            await expectRowWhole(page, row);
            await confirm.click();
            await expect(row.getByText('1 of 5 devices')).toBeVisible();
            await expect(row.getByRole('listitem')).toHaveCount(1);
            const deletes = (await kestrelPi(page)).requests.filter((r) => r.method === 'DELETE');
            expect(deletes.map((r) => r.path)).toEqual(['/api/enc/devices/dev-kestrel-ipad']);

            await row.getByRole('button', { name: 'Code for another phone or tablet' }).click();
            await expect(row.getByText('HJKMN 4PQRS', { exact: true })).toBeVisible();
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-set-up-code-${size.width}`);

            const pi = await kestrelPi(page);
            expect(pi.requests.filter((r) => r.path.startsWith('/api/enc/')).every((r) => r.header === pi.token)).toBe(
                true,
            );
            expect(pi.requests.filter((r) => !r.path.startsWith('/api/enc/')).every((r) => r.header === null)).toBe(
                true,
            );
            expect(pi.requests.filter((r) => r.url.includes(pi.token))).toEqual([]);
            expect(errors).toEqual([]);
        });

        test('3. Wi-Fi only: off the boat, a quiet line, not an error', async ({ page }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'wifi-only');
            await expect(row.getByText("Charts come over Kestrel's own Wi-Fi. Join it to get charts.")).toBeVisible();
            await expect(row.getByRole('alert')).toHaveCount(0);
            await expect(row.getByRole('textbox')).toHaveCount(0);
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-wifi-only-${size.width}`);
            expect(errors).toEqual([]);
        });

        test('4. device limit: a sixth device hears why', async ({ page }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'limit');
            await expectCodeFieldAboveKeyboard(page, row);
            await row.getByRole('button', { name: 'Set up', exact: true }).click();
            await expect(
                row.getByText("Five phones and tablets already get Kestrel's charts. Remove one to add this one."),
            ).toBeVisible();
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-limit-${size.width}`);
            expect(errors).toEqual([]);
        });

        test('5. dongle down: set up, and told to check the dongle', async ({ page }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'dongle');
            await expect(
                row.getByText("Kestrel can't open her charts. Check the o-charts dongle is plugged into the Pi."),
            ).toBeVisible();
            await expect(row.getByText('2 of 5 devices')).toBeVisible();
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-dongle-${size.width}`);
            expect(errors).toEqual([]);
        });

        test("today's Pi (update 2): needs its next update, quietly, and nothing else changes", async ({
            page,
        }, testInfo) => {
            const { row, errors } = await openChartsRow(page, size, 'old-pi');
            await expect(row.getByText(/Kestrel's Pi needs its next update/)).toBeVisible();
            await expect(row.getByRole('alert')).toHaveCount(0);
            await expect(row.getByRole('textbox')).toHaveCount(0);
            await expectRowWhole(page, row);
            await screenshot(page, testInfo, `charts-old-pi-${size.width}`);
            // No token exists, so nothing carried one: the old Pi sees today's requests.
            expect((await kestrelPi(page)).requests.every((r) => r.header === null)).toBe(true);
            expect(errors).toEqual([]);
        });
    });
}
