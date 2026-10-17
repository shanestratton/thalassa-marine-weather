import { expect, test } from '@playwright/test';

for (const width of [300, 375])
    test(`Solunar and private catch actual sheets ${width}px130%`, async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [],
            external: string[] = [],
            origin = new URL(baseURL!).origin;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            external.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/solunar-catch140.html');
        await page.addStyleTag({ content: 'html{font-size:130%!important}' });
        const dimensions = () =>
            page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            }));
        const baseline = await dimensions();
        await page.getByRole('button', { name: 'Open Sun and moon', exact: true }).click();
        const sun = page.getByRole('dialog', { name: 'Sun and moon', exact: true });
        const solunar = sun.getByRole('region', { name: 'Solunar periods' });
        await solunar.scrollIntoViewIfNeeded();
        await expect(solunar).toContainText('Major · upper transit');
        await expect(solunar).toContainText('Minor · moonrise');
        await expect(solunar).toContainText('Traditional lunar windows, not predictions of fish activity.');
        const sunRect = (await sun.boundingBox())!;
        expect(sunRect.x).toBeGreaterThanOrEqual(0);
        expect(sunRect.x + sunRect.width).toBeLessThanOrEqual(width);
        expect(sunRect.y + sunRect.height).toBeLessThanOrEqual(667);
        expect(await dimensions()).toEqual(baseline);
        await page.screenshot({ path: info.outputPath('solunar.png') });
        await sun.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Open private catch', exact: true }).click();
        const detail = page.getByTestId('sighting-detail');
        await detail.getByRole('button', { name: 'Edit', exact: true }).click();
        const species = detail.getByLabel('Catch species'),
            length = detail.getByLabel('Length (cm)'),
            disposition = detail.getByLabel('Kept or released');
        await species.fill('Fictional private cod');
        await length.fill('42.5');
        await disposition.selectOption('released');
        expect(await disposition.evaluate((node) => getComputedStyle(node).colorScheme)).toBe('dark');
        type Snapshot = {
            record: { privateCatch?: unknown; row: { visibility: string } };
            sharedInsert: unknown;
            sharedPatch: unknown;
            export: unknown;
        };
        const snapshot = () =>
            page.evaluate(() =>
                (
                    window as unknown as { __solunarCatchFixture: { snapshot(): Promise<Snapshot> } }
                ).__solunarCatchFixture.snapshot(),
            );
        await expect
            .poll(async () => (await snapshot()).record.privateCatch)
            .toEqual({ species: 'Fictional private cod', length_cm: 42.5, disposition: 'released' });
        for (const field of [species, length, disposition])
            expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const catchRect = (await detail.boundingBox())!;
        expect(catchRect.x).toBeGreaterThanOrEqual(0);
        expect(catchRect.x + catchRect.width).toBeLessThanOrEqual(width);
        expect(catchRect.y + catchRect.height).toBeLessThanOrEqual(667);
        expect(await dimensions()).toEqual(baseline);
        await expect.poll(() => detail.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
        await page.screenshot({ path: info.outputPath('catch-fields.png') });
        await page.evaluate(() => document.documentElement.classList.add('display-light'));
        expect(await disposition.evaluate((node) => getComputedStyle(node).colorScheme)).toBe('light');
        await expect
            .poll(() =>
                detail
                    .locator('label')
                    .first()
                    .evaluate((node) => getComputedStyle(node).color),
            )
            .toBe('rgb(51, 65, 85)');
        await page.screenshot({ path: info.outputPath('catch-fields-daylight.png') });
        expect(await dimensions()).toEqual(baseline);
        await detail.getByRole('button', { name: 'Done', exact: true }).click();
        await detail.getByRole('button', { name: 'Close sighting', exact: true }).click();
        await page.reload();
        await page.addStyleTag({ content: 'html{font-size:130%!important}' });
        await page.getByRole('button', { name: 'Open private catch', exact: true }).click();
        await expect(detail).toContainText('Fictional private cod · 42.5 cm · Released');
        const saved = await snapshot();
        expect(saved.record.row.visibility).toBe('private');
        for (const projection of [saved.sharedInsert, saved.sharedPatch, saved.export])
            expect(JSON.stringify(projection)).not.toContain('Fictional private cod');
        await info.attach('owner-and-projections', {
            body: JSON.stringify(saved, null, 2),
            contentType: 'application/json',
        });
        await page.evaluate(() =>
            (window as unknown as { __solunarCatchFixture: { fence(): void } }).__solunarCatchFixture.fence(),
        );
        await expect(detail.getByText('Catch details · only you', { exact: true })).toHaveCount(0);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
    });
