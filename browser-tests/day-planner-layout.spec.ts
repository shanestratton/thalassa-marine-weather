import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { WHITSUNDAYS_DAY_DESTINATIONS } from '../services/dayPlanner/destinations';

const sizes = [
    { width: 320, height: 568, pane: false },
    { width: 390, height: 844, pane: false },
    { width: 1024, height: 768, pane: true },
];

async function openFixture(page: Page, size: (typeof sizes)[number], mode: string, extra = '', openSheet = true) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) &&
            route.request().method() === 'GET' &&
            !url.pathname.startsWith('/api/')
            ? route.continue()
            : route.abort();
    });
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/day-planner.html?mode=${mode}&pane=${size.pane}${extra}`);
    if (openSheet) {
        await page.getByRole('button', { name: /Plan Your Day/ }).click();
        await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toBeVisible();
    } else {
        await expect(page.getByRole('button', { name: /Plan Your Day/ })).toBeVisible();
    }
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
    return errors;
}

async function assertLayout(page: Page) {
    const issues = await page.evaluate(() => {
        const messages: string[] = [];
        const pane = document.querySelector('[data-testid="day-planner-pane"]')!.getBoundingClientRect();
        const sheet = document.querySelector<HTMLElement>('.day-plan-sheet')!;
        const box = sheet.getBoundingClientRect();
        if (
            box.left < pane.left - 1 ||
            box.right > pane.right + 1 ||
            box.top < pane.top - 1 ||
            box.bottom > pane.bottom + 1
        )
            messages.push('Sheet escapes its viewport/pane.');
        for (const selector of ['.day-plan-header', '.day-plan-body', '.day-plan-footer']) {
            const element = sheet.querySelector<HTMLElement>(selector)!;
            if (element.scrollWidth > element.clientWidth + 1) {
                const overflowing = [...element.querySelectorAll<HTMLElement>('*')]
                    .filter((child) => child.clientWidth && child.scrollWidth > child.clientWidth + 1)
                    .map((child) => `${child.tagName}.${child.className}: ${child.scrollWidth}/${child.clientWidth}`);
                messages.push(
                    `${selector} overflows horizontally (${element.scrollWidth}/${element.clientWidth}): ${overflowing.join(', ')}.`,
                );
            }
        }
        for (const element of sheet.querySelectorAll<HTMLElement>(
            '.day-plan-body input, .day-plan-body select, .day-plan-body label',
        )) {
            const rect = element.getBoundingClientRect();
            // Closed departure details have no rendered geometry; the form test
            // opens them separately so those fields receive the same checks.
            if (!rect.width || !rect.height) continue;
            const description =
                element instanceof HTMLInputElement || element instanceof HTMLSelectElement
                    ? `${element.tagName.toLowerCase()} ${element.labels?.[0]?.textContent?.trim() ?? element.type}`
                    : `label ${element.textContent?.trim()}`;
            if (
                (element instanceof HTMLSelectElement ||
                    (element instanceof HTMLInputElement && element.type !== 'checkbox')) &&
                rect.height < 44
            )
                messages.push(`${description} is shorter than the 44px touch target (${rect.height}px).`);
            const fieldset = element.closest('fieldset');
            if (!fieldset) {
                messages.push(`${description} has no containing fieldset.`);
                continue;
            }
            const fieldsetBox = fieldset.getBoundingClientRect();
            for (const [name, bounds] of [
                ['fieldset', fieldsetBox],
                ['sheet', box],
            ] as const) {
                if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
                    messages.push(`${description} escapes its ${name} horizontally.`);
            }
            // A label's box can fit while its text still paints outside it.
            if (element.tagName === 'LABEL') {
                const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                while ((node = textNodes.nextNode())) {
                    if (!node.textContent?.trim() || node.parentElement?.closest('input, select')) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const textBox of range.getClientRects()) {
                        if (!textBox.width || !textBox.height) continue;
                        if (
                            textBox.left < fieldsetBox.left - 1 ||
                            textBox.right > fieldsetBox.right + 1 ||
                            textBox.left < box.left - 1 ||
                            textBox.right > box.right + 1
                        )
                            messages.push(`${description} text escapes its fieldset or sheet horizontally.`);
                    }
                }
            }
        }
        const footer = sheet.querySelector('.day-plan-footer')!.getBoundingClientRect();
        for (const element of sheet.querySelectorAll<HTMLButtonElement>('.day-plan-footer button')) {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (
                rect.top < footer.top - 1 ||
                rect.bottom > footer.bottom + 1 ||
                (hit !== element && !element.contains(hit))
            )
                messages.push('Footer action is obscured.');
        }
        if (document.documentElement.scrollWidth > window.innerWidth + 1)
            messages.push('Document overflows horizontally.');
        return messages;
    });
    expect(issues).toEqual([]);
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

function hoursAfter(localDateTime: string, hours: number) {
    const date = new Date(`${localDateTime}Z`);
    date.setUTCHours(date.getUTCHours() + hours);
    return date.toISOString().slice(0, 16);
}

for (const size of sizes)
    for (const mode of ['dark', 'light']) {
        test(`Day planner actual form fits ${size.width}px ${mode}${size.pane ? ' split pane' : ''}`, async ({
            page,
        }, testInfo) => {
            const errors = await openFixture(page, size, mode);
            await expect(page.getByText('Yacht position · reported just now', { exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeEnabled();
            await expect(page.getByRole('heading', { name: 'Plan Your Day', exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: 'Return trip', exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-${size.width}-${mode}-top`);

            await page.getByText('Position details', { exact: true }).click();
            await expect(page.getByLabel('Latitude', { exact: true })).toBeVisible();
            await assertLayout(page);
            await page.getByText('Position details', { exact: true }).click();

            const destination = page.getByRole('combobox', { name: 'Destination', exact: true });
            await destination.scrollIntoViewIfNeeded();
            await expect(destination).toHaveValue('');
            await expect(destination.locator('option')).toHaveText([
                'All local destinations',
                ...WHITSUNDAYS_DAY_DESTINATIONS.map(({ name }) => name),
            ]);
            const longestDestination = WHITSUNDAYS_DAY_DESTINATIONS.reduce((longest, current) =>
                current.name.length > longest.name.length ? current : longest,
            );
            await destination.selectOption(longestDestination.id);
            await expect(destination).toHaveValue(longestDestination.id);
            const noPreference = page.getByRole('button', { name: 'No preference', exact: true });
            await expect(noPreference).toHaveAttribute('aria-pressed', 'true');
            await page.getByRole('button', { name: 'Snorkel', exact: true }).click();
            await expect(noPreference).toHaveAttribute('aria-pressed', 'false');
            await noPreference.click();
            await expect(noPreference).toHaveAttribute('aria-pressed', 'true');
            await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeEnabled();
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-${size.width}-${mode}-destination`);

            const leaveAt = page.getByLabel('Leave at', { exact: true });
            const departure = await leaveAt.inputValue();
            const returnBy = page.getByLabel('Back by (optional)', { exact: true });
            await returnBy.scrollIntoViewIfNeeded();
            await expect(returnBy).toHaveValue('');
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-${size.width}-${mode}-return-empty`);
            const deadline = hoursAfter(departure, 8);
            await returnBy.fill(deadline);
            await expect(returnBy).toHaveValue(deadline);
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-${size.width}-${mode}-return-filled`);

            await page.getByRole('button', { name: 'Stay overnight', exact: true }).click();
            await expect(page.getByRole('button', { name: 'Stay overnight', exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            const stayUntil = page.getByLabel('Stay until', { exact: true });
            await stayUntil.scrollIntoViewIfNeeded();
            await expect(stayUntil).toBeVisible();
            const overnightEnd = hoursAfter(departure, 24);
            await stayUntil.fill(overnightEnd);
            await expect(stayUntil).toHaveValue(overnightEnd);
            await expect(returnBy).toHaveCount(0);
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-${size.width}-${mode}-overnight`);
            await page.getByRole('button', { name: 'Close day planner', exact: true }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            expect(errors).toEqual([]);
            expect(
                await page.evaluate(
                    () =>
                        (window as unknown as { __dayPlannerFixture: { providerCalls: number } }).__dayPlannerFixture
                            .providerCalls,
                ),
            ).toBe(0);
        });
    }

test('Missing synthetic GPS requires explicit manual departure confirmation', async ({ page }, testInfo) => {
    const errors = await openFixture(page, sizes[1], 'dark', '&position=missing');
    const find = page.getByRole('button', { name: 'Find my day', exact: true });
    await expect(find).toBeDisabled();
    await page.getByLabel('Latitude', { exact: true }).fill('-20.258');
    await page.getByLabel('Longitude', { exact: true }).fill('148.815');
    await expect(find).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Use this position as my departure.' }).check();
    await expect(find).toBeEnabled();
    await assertLayout(page);
    await screenshot(page, testInfo, 'day-planner-manual-confirmed');
    expect(errors).toEqual([]);
});

for (const mode of ['dark', 'light']) {
    test(`Worldwide mapped mode is explicit and fits a narrow phone in ${mode}`, async ({ page }, testInfo) => {
        const errors = await openFixture(page, sizes[0], mode, '&region=noumea');
        const coverage = page.getByLabel('Destination coverage', { exact: true });
        await coverage.scrollIntoViewIfNeeded();
        await expect(coverage).toContainText('Mapped stops · local details unverified');
        await page.getByRole('button', { name: 'Explore mapped stops', exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', { name: 'Explore mapped stops', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByRole('button', { name: 'Snorkel', exact: true })).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: 'Destination', exact: true })).toHaveCount(0);
        await assertLayout(page);
        await screenshot(page, testInfo, `day-planner-worldwide-${mode}`);
        await page.getByLabel('Leave at', { exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByText(/Departure-area time: Pacific\/Noumea/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeEnabled();
        await assertLayout(page);
        expect(errors).toEqual([]);
    });
}

test('Signed-out synthetic form cannot calculate', async ({ page }) => {
    const errors = await openFixture(page, sizes[1], 'light', '&auth=signed-out');
    await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeDisabled();
    await expect(
        page.getByText('Sign in to calculate routes and save a private day plan.', { exact: true }),
    ).toBeAttached();
    expect(errors).toEqual([]);
});

for (const size of sizes.filter((candidate) => !candidate.pane)) {
    test(`Plan front door preserves controls at ${size.width}px`, async ({ page }, testInfo) => {
        const errors = await openFixture(page, size, 'dark', '&surface=plan', false);
        const entry = page.getByRole('button', { name: /Plan Your Day/ });
        const plotting = page.getByRole('button', { name: 'Start plotting', exact: true });
        const controls = [
            entry,
            plotting,
            page.getByRole('button', { name: 'From a past voyage', exact: true }),
            page.getByRole('button', { name: 'Saved routes', exact: true }),
            page.getByRole('button', { name: 'Route Planner actions', exact: true }),
            page.getByRole('button', { name: 'Now', exact: true }),
        ];
        for (const control of controls) {
            await expect(control).toBeVisible();
            await expect(control).toBeInViewport();
            expect(
                await control.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                    return hit === element || element.contains(hit);
                }),
            ).toBe(true);
        }
        const entryBox = (await entry.boundingBox())!;
        const plottingBox = (await plotting.boundingBox())!;
        expect(entryBox.y + entryBox.height).toBeLessThanOrEqual(plottingBox.y);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await screenshot(page, testInfo, `day-planner-front-door-${size.width}`);
        await entry.click();
        await expect(page.getByRole('dialog', { name: 'Plan Your Day', exact: true })).toBeVisible();
        await assertLayout(page);
        await page.getByRole('button', { name: 'Close day planner', exact: true }).click();
        await expect(plotting).toBeVisible();
        expect(errors).toEqual([]);
    });
}

for (const size of sizes.filter((candidate) => !candidate.pane)) {
    for (const mode of ['dark', 'light']) {
        test(`Shared catalogue picker fits ${size.width}px ${mode} with complete and missing route choices`, async ({
            page,
        }, testInfo) => {
            const errors = await openFixture(page, size, mode, '&catalogue=ready');
            const browse = page.getByRole('button', { name: 'Browse shared catalogue', exact: true });
            await browse.scrollIntoViewIfNeeded();
            await expect(browse).toBeEnabled();
            expect(
                await page.evaluate(
                    () =>
                        (window as unknown as { __dayPlannerFixture: { catalogueRequests: unknown[] } })
                            .__dayPlannerFixture.catalogueRequests,
                ),
            ).toHaveLength(0);
            await browse.click();
            const selection = page.getByRole('combobox', { name: 'Shared destination or trip', exact: true });
            await expect(selection.locator('option')).toHaveCount(2);
            await selection.selectOption('00000000-0000-4000-8000-000000000001:1');
            const outbound = page.getByRole('combobox', { name: 'Outbound route reference', exact: true });
            const returning = page.getByRole('combobox', { name: 'Return route reference', exact: true });
            await expect(outbound).toHaveValue('00000000-0000-4000-8000-000000000004:1');
            await expect(returning).toHaveValue('00000000-0000-4000-8000-000000000005:1');
            await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeEnabled();
            await outbound.scrollIntoViewIfNeeded();
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-catalogue-${size.width}-${mode}-ready`);
            await page.getByText('Catalogue source review', { exact: true }).click();
            await page
                .getByText('Synthetic source with a deliberately long description to verify mobile text wrapping', {
                    exact: true,
                })
                .scrollIntoViewIfNeeded();
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-catalogue-${size.width}-${mode}-sources`);
            const calls = await page.evaluate(
                () =>
                    (
                        window as unknown as {
                            __dayPlannerFixture: {
                                catalogueRequests: { name: string; args: Record<string, unknown> }[];
                                providerCalls: number;
                            };
                        }
                    ).__dayPlannerFixture,
            );
            expect(calls.catalogueRequests).toEqual([
                {
                    name: 'nearby_cruising_catalogue',
                    args: { p_latitude: -20.258, p_longitude: 148.815, p_radius_nm: 30, p_limit: 24 },
                },
                {
                    name: 'cruising_catalogue_detail',
                    args: { p_id: '00000000-0000-4000-8000-000000000001', p_version: 1 },
                },
            ]);
            expect(calls.providerCalls).toBe(0);
            expect(errors).toEqual([]);

            const missingErrors = await openFixture(page, size, mode, '&catalogue=missing-return');
            await page.getByRole('button', { name: 'Browse shared catalogue', exact: true }).click();
            await expect(selection.locator('option')).toHaveCount(2);
            await selection.selectOption('00000000-0000-4000-8000-000000000001:1');
            await expect(returning).toHaveValue('');
            await expect(returning.locator('option')).toHaveText(['No reviewed route available']);
            await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeDisabled();
            await returning.scrollIntoViewIfNeeded();
            await expect(page.getByText(/A return route is not assumed from the outbound route/)).toBeVisible();
            await assertLayout(page);
            await screenshot(page, testInfo, `day-planner-catalogue-${size.width}-${mode}-missing-return`);
            await selection.selectOption('');
            await expect(page.getByRole('button', { name: 'Find my day', exact: true })).toBeEnabled();
            expect(missingErrors).toEqual([]);
            expect(
                await page.evaluate(
                    () =>
                        (window as unknown as { __dayPlannerFixture: { providerCalls: number } }).__dayPlannerFixture
                            .providerCalls,
                ),
            ).toBe(0);
        });
    }
}
