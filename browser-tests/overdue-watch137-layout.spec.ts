import { test, expect } from '@playwright/test';
const owner = '10000000-0000-4000-8000-000000000001',
    boat = '20000000-0000-4000-8000-000000000001',
    contact = '30000000-0000-4000-8000-000000000001',
    revision = '40000000-0000-4000-8000-000000000001';
for (const width of [300, 375])
    test(`overdue opt-in is held, deliberate, private and legible ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        const server: { ready: boolean; watch: Record<string, unknown> | null } = { ready: false, watch: null };
        const writes: Record<string, unknown>[] = [],
            unexpected: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
            if (url.hostname === 'shore-contact.fixture.invalid') {
                if (url.pathname.endsWith('/overdue_watch_status'))
                    return route.fulfill({
                        json: {
                            schema: 1,
                            ownerId: owner,
                            boatId: boat,
                            checkedAt: Date.now(),
                            ready: server.ready,
                            watch: server.watch,
                        },
                    });
                if (url.pathname.endsWith('/shore_contacts_list'))
                    return route.fulfill({
                        json: {
                            schema: 1,
                            ownerId: owner,
                            boatId: boat,
                            checkedAt: Date.now(),
                            emailReady: server.ready,
                            telegramReady: false,
                            overdueReady: server.ready,
                            contacts: [
                                {
                                    id: contact,
                                    revision,
                                    configuration: {
                                        channel: 'email',
                                        label: 'Chosen recipient',
                                        address: 'fixture@example.invalid',
                                        enabled: true,
                                        sharePosition: false,
                                        allowOverdue: true,
                                    },
                                    consent: 'confirmed',
                                    consentedAt: Date.now() - 1000,
                                },
                            ],
                        },
                    });
                if (url.pathname.endsWith('/configure_overdue_watch')) {
                    const body = route.request().postDataJSON() as Record<string, unknown>;
                    writes.push(body);
                    server.watch = {
                        revision,
                        configuration: body.p_configuration,
                        state: { ownerQueuedAt: null, ownerAttemptedAt: null, contactsQueuedAt: null, endedAt: null },
                        endReason: null,
                        reviewRequired: false,
                    };
                    return route.fulfill({ json: revision });
                }
                if (url.pathname.endsWith('/end_overdue_watch')) {
                    const body = route.request().postDataJSON() as Record<string, unknown>;
                    writes.push(body);
                    server.watch = {
                        ...server.watch,
                        configuration: { ...(server.watch?.configuration as object), enabled: false },
                        state: { ...(server.watch?.state as object), endedAt: Date.now() },
                        endReason: 'arrived',
                    };
                    return route.fulfill({ json: revision });
                }
            }
            unexpected.push(url.hostname + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/overdue-watch137.html');
        await expect(page.getByRole('button', { name: 'Edit planned deadline' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Overdue watch' })).toHaveCount(0);
        expect(writes).toEqual([]);
        server.ready = true;
        await page.reload();
        const section = page.getByRole('region', { name: 'Overdue watch' });
        await expect(section).toBeVisible();
        const arm = section.getByRole('button', { name: 'Save and arm reviewed plan' });
        await expect(arm).toBeDisabled();
        await section.getByRole('checkbox', { name: /Chosen recipient/ }).check();
        await section.getByRole('checkbox', { name: /I reviewed/ }).check();
        await page.getByRole('button', { name: 'Edit planned deadline' }).click();
        await expect(arm).toBeDisabled();
        await section.getByRole('checkbox', { name: /I reviewed/ }).check();
        await arm.click();
        await expect(section.getByText(/Saved plan: Private fixture yacht/)).toBeVisible();
        expect(writes).toHaveLength(1);
        const cfg = writes[0].p_configuration as Record<string, unknown>;
        expect(Object.keys(cfg).sort()).toEqual(['contacts', 'enabled', 'plan', 'rescueRegion', 'sharePosition']);
        expect(Object.keys(cfg.plan as object).sort()).toEqual([
            'departureAt',
            'etaAt',
            'from',
            'overdueAt',
            'persons',
            'to',
            'vesselLabel',
        ]);
        expect(cfg.sharePosition).toBe(false);
        expect(cfg.rescueRegion).toBeNull();
        server.watch = {
            ...server.watch,
            configuration: { ...cfg, plan: { ...(cfg.plan as object), overdueAt: Date.now() - 1200000 } },
            state: {
                ownerQueuedAt: Date.now() - 900000,
                ownerAttemptedAt: Date.now() - 660000,
                contactsQueuedAt: null,
                endedAt: null,
            },
        };
        await section.getByRole('button', { name: 'Reload overdue status' }).click();
        await expect(section.getByText(/Owner notification attempted/)).toHaveText(/delivery unconfirmed/);
        await section.getByRole('button', { name: 'Mark arrived' }).click();
        await expect(section.getByText(/Watch ended: arrived/)).toBeVisible();
        await expect(section.getByRole('button', { name: 'Mark arrived' })).toBeDisabled();
        expect(writes[1].p_reason).toBe('arrived');
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);
        for (const button of await section.locator('button:visible').all()) {
            const b = await button.boundingBox();
            expect(b?.height).toBeGreaterThanOrEqual(44);
        }
        const select = section.getByRole('combobox'),
            color = await select.evaluate((node) => getComputedStyle(node).color),
            png = await select.screenshot();
        const contrast = await page.evaluate(
            async ({ base64, color }) => {
                const image = new Image();
                image.src = 'data:image/png;base64,' + base64;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(image, 0, 0);
                // Sample the right padding, outside both selected text and the overlaid caret.
                const bg = [...ctx.getImageData(image.width - 6, Math.floor(image.height / 2), 1, 1).data];
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 1, 1);
                const fg = [...ctx.getImageData(0, 0, 1, 1).data];
                const lum = (rgb: number[]) =>
                    rgb
                        .slice(0, 3)
                        .map((v) => {
                            v /= 255;
                            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                        })
                        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
                const a = lum(bg),
                    b = lum(fg);
                return { background: a, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
            },
            { base64: png.toString('base64'), color },
        );
        expect(contrast.background).toBeLessThan(0.1);
        expect(contrast.contrast).toBeGreaterThanOrEqual(4.5);
        await page.screenshot({ path: test.info().outputPath('overdue-watch.png'), fullPage: true });
        await page.evaluate(() => {
            (window as unknown as { __overdueAccountSwap: () => void }).__overdueAccountSwap();
        });
        await expect(section).toHaveCount(0);
        expect(unexpected).toEqual([]);
    });
