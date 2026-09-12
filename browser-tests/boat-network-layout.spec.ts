import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

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
