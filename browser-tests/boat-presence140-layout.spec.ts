import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`actual private boat controls/layer ${width}px130%`, async ({ page, context, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        await context.grantPermissions(['geolocation']);
        await context.setGeolocation({ latitude: 0.01, longitude: 0.01, accuracy: 10 });
        await page.addInitScript(
            ({ webkit }) => {
                const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
                navigator.geolocation.watchPosition = (callback, error, options) =>
                    watch(
                        (position) => {
                            const raw = position.timestamp;
                            // Pinned Windows WebKit's emulated GPS emits microseconds.
                            // Correct ONLY this controlled test callback, retaining the
                            // original acquisition instant; production guards stay exact.
                            const normalized = webkit && raw > 1e14 && Math.abs(raw / 1000 - Date.now()) < 10000;
                            const milliseconds = normalized ? raw / 1000 : raw;
                            window.__presenceGpsClock = { raw, milliseconds, normalized };
                            callback(
                                normalized
                                    ? ({ coords: position.coords, timestamp: milliseconds } as GeolocationPosition)
                                    : position,
                            );
                        },
                        error,
                        options,
                    );
            },
            { webkit: info.project.name === 'webkit' },
        );
        const owner = '00000000-0000-4000-8000-000000000001',
            vessel = '00000000-0000-4000-8000-000000000002';
        const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        let cfg = {
            vesselId: vessel,
            vesselName: 'Fictional yacht',
            tier: 'off',
            revision: uuid(3),
            sequence: 1,
            readerRevision: uuid(4),
            publisherRevision: uuid(5),
            publisherActive: false,
        };
        const requests: { p_action: string; p_input: Record<string, unknown> }[] = [],
            errors: string[] = [],
            external: string[] = [];
        const origin = new URL(baseURL!).origin;
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript(
            ({ owner }) => {
                const payload = btoa(
                    JSON.stringify({
                        sub: owner,
                        aud: 'authenticated',
                        role: 'authenticated',
                        exp: Math.floor(Date.now() / 1000) + 3600,
                    }),
                );
                localStorage.setItem(
                    'thalassa-auth-session',
                    JSON.stringify({
                        access_token: `e30.${payload}.fictional`,
                        refresh_token: 'fictional-refresh',
                        expires_at: Math.floor(Date.now() / 1000) + 3600,
                        expires_in: 3600,
                        token_type: 'bearer',
                        user: { id: owner, aud: 'authenticated', role: 'authenticated' },
                    }),
                );
            },
            { owner },
        );
        await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            if (
                url.origin === 'https://fixture.example.test' &&
                url.pathname === '/rest/v1/rpc/boat_presence_control'
            ) {
                const input = route.request().postDataJSON() as (typeof requests)[number];
                requests.push(input);
                let answer: unknown;
                const now = Date.now();
                if (input.p_action === 'configure')
                    cfg = {
                        ...cfg,
                        tier: String(input.p_input.tier),
                        revision: uuid(30 + cfg.sequence),
                        sequence: cfg.sequence + 1,
                        readerRevision: uuid(40 + cfg.sequence),
                        publisherRevision: uuid(50 + cfg.sequence),
                        publisherActive: false,
                    };
                if (input.p_action === 'begin')
                    cfg = {
                        ...cfg,
                        ...(input.p_input.kind === 'reader'
                            ? { readerRevision: uuid(400 + cfg.sequence) }
                            : { publisherRevision: uuid(500 + cfg.sequence), publisherActive: true }),
                    };
                if (input.p_action === 'nearby')
                    answer = {
                        points: [
                            {
                                id: 'a'.repeat(64),
                                label: 'Thalassa boat',
                                tier: 'nearby',
                                latitude: 0.025,
                                longitude: 0.025,
                                bucketAt: new Date(now - 360000).toISOString(),
                                validUntil: new Date(now + 30000).toISOString(),
                            },
                        ],
                        serverTime: new Date(now).toISOString(),
                        validUntil: new Date(now + 30000).toISOString(),
                    };
                else if (input.p_action === 'friends') answer = { friends: [] };
                else if (input.p_action === 'invite')
                    answer = { token: 'f'.repeat(64), expiresAt: new Date(now + 3600000).toISOString() };
                else answer = { ...cfg, serverTime: new Date(now).toISOString() };
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify(answer),
                    headers: { 'Access-Control-Allow-Origin': '*' },
                });
            }
            if (url.hostname.endsWith('.mapbox.com'))
                return route.fulfill({ contentType: 'application/json', body: '{}' });
            external.push(`${url.origin}${url.pathname}`);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/boat-presence140.html');
        await page.evaluate(() => {
            document.documentElement.style.fontSize = '130%';
        });
        await expect.poll(() => page.evaluate(() => window.__presenceFixture?.ready())).toBe(true);
        await expect.poll(() => page.evaluate(() => window.__presenceFixture?.gps())).toBeTruthy();
        // Refresh the controlled position after module startup. The ORIGINAL
        // callback clock must be recent, rather than relabelled on receipt.
        await context.setGeolocation({ latitude: 0.01, longitude: 0.01, accuracy: 10 });
        await expect
            .poll(() => page.evaluate(() => Math.abs(Date.now() - (window.__presenceFixture.gps() ?? 0))))
            .toBeLessThan(5000);
        const dims = () =>
            page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            }));
        const before = await dims();
        expect(requests).toEqual([]);
        expect(await page.locator('[data-boat-presence]').count()).toBe(0);
        await page.getByRole('button', { name: 'Open layer menu' }).click();
        await page.getByRole('menuitem', { name: 'Live layers', exact: true }).click();
        const toggle = page.getByRole('menuitemcheckbox', { name: 'Thalassa boats, off' });
        await expect.poll(async () => (await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        await toggle.click();
        await page.getByRole('button', { name: 'Close layer menu' }).click();
        await expect(page.locator('[data-helm-scrim]')).toHaveCount(0);
        const marker = page.getByRole('button', { name: 'Thalassa boat; delayed Thalassa position' });
        try {
            await expect(marker).toHaveCount(1);
        } catch (error) {
            await info.attach('fictional-presence-start-failure', {
                body: JSON.stringify({
                    requests,
                    errors,
                    external,
                    state: await page.evaluate(() => window.__presenceFixture.diagnostic()),
                }),
                contentType: 'application/json',
            });
            throw error;
        }
        expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(requests.filter((x) => x.p_action === 'begin').map((x) => x.p_input.kind)).toEqual(['reader']);
        const sent = requests.find((x) => x.p_action === 'fix')!.p_input;
        expect(sent.publisherNonce).toBeUndefined();
        expect(Date.parse(String(sent.observedAt))).toBe(await page.evaluate(() => window.__presenceFixture.gps()));
        await page.screenshot({ path: info.outputPath('presence-map.png') });
        await marker.click();
        let dialog = page.getByRole('dialog', { name: 'Thalassa boat', exact: true });
        await expect(dialog).toContainText('never used for AIS');
        expect(await dims()).toEqual(before);
        await page.screenshot({ path: info.outputPath('presence-detail.png') });
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Credits', exact: true }).click();
        dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        await expect(dialog).toContainText('0.05° cells');
        await dialog.getByRole('button', { name: 'Privacy and friends', exact: true }).click();
        dialog = page.getByRole('dialog', { name: 'Thalassa boats', exact: true });
        await expect(dialog).toContainText('Off by default');
        await expect(dialog.getByLabel('Presence audience')).toHaveValue('off');
        await expect(dialog.getByRole('heading', { name: 'Thalassa boats', exact: true })).toBeInViewport();
        expect(await dialog.locator('[data-modal-sheet]').evaluate((node) => node.scrollTop)).toBe(0);
        await expect(dialog.getByRole('button', { name: 'Publish for this foreground session' })).toBeDisabled();
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(667);
        expect(await dims()).toEqual(before);
        await page.screenshot({ path: info.outputPath('presence-controls-off.png') });
        await dialog.getByLabel('Presence audience').selectOption('friends');
        await dialog.getByRole('button', { name: 'Save audience', exact: true }).click();
        await expect(dialog.getByRole('status', { name: 'Boat presence session' })).toContainText('Choice saved');
        expect(await page.evaluate(() => window.__presenceFixture.session())).toEqual({
            viewing: false,
            publishing: false,
        });
        await expect(marker).toHaveCount(0);
        const publish = dialog.getByRole('button', { name: 'Publish for this foreground session' });
        await publish.scrollIntoViewIfNeeded();
        expect((await publish.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await publish.click();
        await expect(dialog.getByRole('button', { name: 'Stop publishing now' })).toBeVisible();
        await expect
            .poll(() => requests.filter((x) => x.p_action === 'begin').map((x) => x.p_input.kind))
            .toEqual(['reader', 'publisher']);
        await dialog.getByLabel('Private reminder label').fill('Fictional trusted friend');
        const create = dialog.getByRole('button', { name: 'Create one-time invitation' });
        await create.scrollIntoViewIfNeeded();
        expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await create.click();
        await expect(dialog.getByRole('textbox', { name: 'Invitation token', exact: true })).toHaveValue(
            'f'.repeat(64),
        );
        await page.screenshot({ path: info.outputPath('presence-friends.png') });
        expect(await dims()).toEqual(before);
        await page.evaluate(() => window.__presenceFixture.satellite(true));
        await expect(dialog.getByRole('textbox', { name: 'Invitation token', exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => window.__presenceFixture.session())).toEqual({
            viewing: false,
            publishing: false,
        });
        const count = requests.length;
        await page.evaluate(async () => {
            await window.__presenceFixture.tick();
        });
        expect(requests.length).toBe(count);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => {
            window.__presenceFixture.satellite(false);
            window.__presenceFixture.identity();
        });
        await expect(marker).toHaveCount(0);
        expect(await page.evaluate(() => window.__presenceFixture.session())).toEqual({
            viewing: false,
            publishing: false,
        });
        expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /presence/i.test(k)))).toEqual([]);
        await page.evaluate(() => window.__presenceFixture.foreground(false));
        expect(await dims()).toEqual(before);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        await info.attach('presence-fictional-rpc-proof', {
            body: JSON.stringify(
                {
                    requests,
                    errors,
                    external,
                    dimensions: before,
                    gpsClock: await page.evaluate(() => window.__presenceGpsClock),
                },
                null,
                2,
            ),
            contentType: 'application/json',
        });
    });
