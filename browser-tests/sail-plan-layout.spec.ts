import { expect, test, type Page } from '@playwright/test';

const sizes = [
    { name: '320 phone', width: 320, height: 568 },
    { name: '390 phone', width: 390, height: 844 },
    { name: '430 phone', width: 430, height: 932 },
    { name: 'iPad half pane', width: 1024, height: 768, pane: true },
];
const bands = ['Beating', 'Close reach', 'Beam reach', 'Broad reach', 'Running'];

async function selectPlan(page: Page, band: string, tack: string) {
    await page.getByRole('combobox', { name: 'Band', exact: true }).selectOption(band);
    await page.getByRole('combobox', { name: 'Wind side', exact: true }).selectOption(tack);
    await expect(page.getByTestId('sail-plan-details')).toHaveAttribute('data-band', band);
    await expect(page.getByTestId('sail-plan-details')).toHaveAttribute('data-tack', tack);
    await expect(page.locator('[data-mark="wind-arrow"]')).toHaveCount(tack === 'unknown' ? 0 : 1);
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
}

async function assertLayout(page: Page, context: string) {
    const diagram = page.locator('.nmea-sail-plan');
    await expect(diagram.locator('svg[data-mark="rig-diagram"]')).toBeVisible();
    await expect(diagram.locator('[data-mark="traveller-guide"]')).toBeAttached();
    await expect(diagram.locator('[data-mark="yankee-car-guide"]')).toBeAttached();
    await expect(diagram.locator('[data-mark="sail-warning"]')).toHaveCount(2);
    await expect(diagram).toContainText(/Trim guide.*not live positions/i);
    const failures = await page.evaluate(() => {
        const errors: string[] = [];
        const root = document.querySelector('.nmea-sail-plan')!;
        const rig = root.querySelector<SVGSVGElement>('svg[data-mark="rig-diagram"]')!;
        const hull = rig.querySelector('[data-mark="hull"]')!;
        const guide = rig.querySelector('[data-mark="yankee-car-guide"]')!;
        const traveller = root.querySelector('[data-mark="traveller-guide"]')!;
        const following = document.querySelector('[data-testid="following-parts"]')!;
        const warnings = [...root.querySelectorAll('[data-mark="sail-warning"]')];
        const bounds = (element: Element) => element.getBoundingClientRect();
        const contains = (outer: DOMRect, inner: DOMRect) =>
            inner.left >= outer.left - 0.5 &&
            inner.right <= outer.right + 0.5 &&
            inner.top >= outer.top - 0.5 &&
            inner.bottom <= outer.bottom + 0.5;
        const overlap = (a: DOMRect, b: DOMRect) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
        if (!contains(bounds(rig), bounds(hull))) errors.push('Hull escapes the rig SVG');
        if (!contains(bounds(rig), bounds(guide))) errors.push('Yankee guide escapes the rig SVG');
        if (overlap(bounds(hull), bounds(guide))) errors.push('Yankee guide overlaps hull');
        const boom = rig.querySelector('[data-mark="boom"]')!;
        if (overlap(bounds(boom), bounds(guide))) errors.push('Yankee guide overlaps boom');
        const wind = rig.querySelector('[data-mark="wind-arrow"]');
        if (wind) {
            if (!contains(bounds(rig), bounds(wind))) errors.push('Wind arrow escapes rig SVG');
            if (overlap(bounds(wind), bounds(guide))) errors.push('Yankee guide overlaps wind arrow');
        }
        for (const svg of root.querySelectorAll('svg')) {
            for (const text of svg.querySelectorAll('text')) {
                if (text.textContent?.trim() && !contains(bounds(svg), bounds(text)))
                    errors.push(`SVG label clipped: ${text.textContent}`);
            }
        }
        if (bounds(traveller).top < bounds(rig).bottom - 0.5) errors.push('Traveller guide overlaps rig');
        let warningBottom = bounds(traveller).bottom;
        for (const warning of warnings) {
            if (bounds(warning).top < bounds(traveller).bottom - 0.5) errors.push('Warning overlaps traveller guide');
            if (!contains(bounds(root), bounds(warning))) errors.push('Warning escapes diagram wrapper');
            warningBottom = Math.max(warningBottom, bounds(warning).bottom);
        }
        if (warnings.length === 2 && overlap(bounds(warnings[0]), bounds(warnings[1])))
            errors.push('Warnings overlap each other');
        if (bounds(following).top < warningBottom - 0.5) errors.push('Following Parts of a sail overlaps warnings');
        for (const element of [
            document.documentElement,
            document.body,
            document.getElementById('root')!,
            document.querySelector('[data-testid="sail-plan-pane"]')!,
            root,
        ]) {
            if (element.scrollWidth > element.clientWidth + 1)
                errors.push(`Horizontal overflow: ${element.tagName}.${element.className}`);
        }
        return errors;
    });
    expect(failures, context).toEqual([]);
}

async function assertWarningsReachable(page: Page) {
    for (const warning of await page.locator('[data-mark="sail-warning"]').all()) {
        await warning.scrollIntoViewIfNeeded();
        const problems = await warning.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const pane = document.querySelector('[data-testid="sail-plan-pane"]')!.getBoundingClientRect();
            const errors: string[] = [];
            if (
                rect.top < Math.max(0, pane.top) - 0.5 ||
                rect.bottom > Math.min(innerHeight, pane.bottom) + 0.5 ||
                rect.left < Math.max(0, pane.left) - 0.5 ||
                rect.right > Math.min(innerWidth, pane.right) + 0.5
            )
                errors.push(`${element.textContent} is not fully inside the pane viewport after scrolling`);
            for (const y of [rect.top + 4, (rect.top + rect.bottom) / 2, rect.bottom - 4]) {
                const hit = document.elementFromPoint((rect.left + rect.right) / 2, y);
                if (hit !== element && !element.contains(hit)) errors.push(`${element.textContent} is occluded`);
            }
            return errors;
        });
        expect(problems).toEqual([]);
    }
}

for (const size of sizes) {
    for (const mode of ['light', 'dark', 'night']) {
        test(`sail plan guides fit ${size.name} in ${mode}`, async ({ page }, testInfo) => {
            test.setTimeout(60_000);
            await page.route('**/*', (route) =>
                ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
                    ? route.continue()
                    : route.abort(),
            );
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.goto(`/e2e/fixtures/sail-plan.html?mode=${mode}${size.pane ? '&pane=true' : ''}`);
            await expect(page.locator('main')).toHaveAttribute('data-mode', mode);
            await expect(page.getByTestId('night-scrim')).toHaveCount(mode === 'night' ? 1 : 0);
            if (mode === 'night') {
                await expect(page.getByTestId('night-scrim')).toHaveCSS('background-color', 'rgba(69, 10, 10, 0.25)');
                await expect(page.getByTestId('night-scrim')).toHaveCSS('pointer-events', 'none');
            }
            await page.evaluate(async () => {
                await document.fonts.ready;
            });
            for (const band of bands) {
                for (const tack of ['starboard', 'port']) {
                    await selectPlan(page, band, tack);
                    await assertLayout(page, `${size.name}/${mode}/${band}/${tack}`);
                }
            }
            await selectPlan(page, 'Beam reach', 'unknown');
            await assertLayout(page, 'Unknown wind still fits');
            await selectPlan(page, 'Unknown', 'starboard');
            await assertLayout(page, 'Unknown band still fits');
            await selectPlan(page, 'Running', 'port');
            await page.getByRole('checkbox', { name: 'Gybe down' }).check();
            await assertLayout(page, 'Running advice with broad-reach visual fits');
            await page.getByRole('checkbox', { name: 'Sails stowed' }).check();
            await assertLayout(page, 'Stowed guides and warnings fit');
            await assertWarningsReachable(page);

            // The following content remains reachable after the complete diagram.
            await page.getByTestId('following-parts').scrollIntoViewIfNeeded();
            await expect(page.getByTestId('following-parts')).toBeVisible();
            await page.getByTestId('following-parts').locator('summary').click();
            await expect(page.getByTestId('following-parts')).toHaveAttribute('open', '');
            await expect(page.getByTestId('following-parts').locator('svg')).toBeVisible();

            if (
                testInfo.project.name === 'webkit' &&
                ((mode === 'dark' && [320, 390].includes(size.width)) || (mode === 'light' && size.width === 390))
            ) {
                await page.getByRole('checkbox', { name: 'Sails stowed' }).uncheck();
                await page.getByRole('checkbox', { name: 'Gybe down' }).uncheck();
                await selectPlan(page, 'Beam reach', 'starboard');
                await assertWarningsReachable(page);
                // All layout/reachability assertions above use the real phone height.
                // Expand only this artifact's height to avoid WebKit clipping a tall
                // element screenshot at the nested scroll pane's viewport boundary.
                const diagramHeight = await page.locator('.nmea-sail-plan').evaluate((element) => element.clientHeight);
                await page.setViewportSize({ width: size.width, height: Math.max(size.height, diagramHeight + 100) });
                const artifactName = `sail-plan-${size.width}${mode === 'light' ? '-light' : ''}`;
                const path = testInfo.outputPath(`${artifactName}.png`);
                await page.locator('.nmea-sail-plan').screenshot({ path, animations: 'disabled' });
                await testInfo.attach(artifactName, { path, contentType: 'image/png' });
            }
        });
    }
}
