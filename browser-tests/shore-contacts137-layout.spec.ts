import { test, expect } from '@playwright/test';
import { fixtureBackendOrigin } from './helpers/fixtureBackendOrigin';
const backendOrigin = fixtureBackendOrigin('https://shore-contact.fixture.invalid');
for (const width of [300, 375]) {
    test(`email fragment requires deliberate consent and fits ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        const posts: Record<string, unknown>[] = [],
            unexpected: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(u.hostname)) return route.continue();
            if (u.origin === backendOrigin) {
                if (u.pathname.endsWith('/shore_contacts_list'))
                    return route.fulfill({
                        json: {
                            schema: 1,
                            ownerId: '10000000-0000-4000-8000-000000000001',
                            boatId: '20000000-0000-4000-8000-000000000001',
                            checkedAt: Date.now(),
                            emailReady: false,
                            telegramReady: false,
                            contacts: [],
                        },
                    });
                if (u.pathname.endsWith('/anchor-alert-messaging')) {
                    posts.push(route.request().postDataJSON() as Record<string, unknown>);
                    return route.fulfill({ json: { accepted: true, policyVersion: 2 } });
                }
            }
            unexpected.push(u.hostname + u.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/shore-contacts137.html#shore=confirm.' + 'a'.repeat(64));
        const d = page.getByRole('dialog', { name: 'Confirm shore-contact invitation' });
        await expect(d).toBeVisible();
        const contrast = await d
            .locator('p')
            .first()
            .evaluate((node) => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext('2d')!;
                const rgba = (color: string) => {
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, 1, 1);
                    return [...ctx.getImageData(0, 0, 1, 1).data];
                };
                const foreground = rgba(getComputedStyle(node).color);
                let parent: Element | null = node,
                    background = [0, 0, 0, 255];
                while (parent) {
                    const candidate = rgba(getComputedStyle(parent).backgroundColor);
                    if (candidate[3] === 255) {
                        background = candidate;
                        break;
                    }
                    parent = parent.parentElement;
                }
                const luminance = (rgb: number[]) =>
                    rgb
                        .slice(0, 3)
                        .map((v) => v / 255)
                        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
                const a = luminance(foreground),
                    b = luminance(background);
                return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        expect(new URL(page.url()).hash).toBe('');
        expect(posts).toEqual([]);
        await d.getByRole('button', { name: 'I consent to the invitation' }).click();
        await expect(d.getByRole('status')).toContainText('Consent recorded');
        expect(posts).toEqual([{ action: 'confirm', nonce: 'a'.repeat(64), accepted: true, policyVersion: 2 }]);
        await expect(d.getByRole('button', { name: 'I consent to the invitation' })).toBeDisabled();
        expect(
            await page.evaluate(
                () => (window as unknown as { __shoreDiagnostics: { firstHash: string } }).__shoreDiagnostics.firstHash,
            ),
        ).toBe('');
        // A second email link may open in the same existing browser tab. It must
        // remain an explicit POST and never enter hash/history telemetry.
        await page.evaluate(() => {
            location.hash = 'shore=revoke.' + 'b'.repeat(64);
        });
        const revokeDialog = page.getByRole('dialog', { name: 'Revoke shore-contact consent' });
        await expect(revokeDialog).toBeVisible();
        expect(new URL(page.url()).hash).toBe('');
        expect(posts).toHaveLength(1);
        await revokeDialog.getByRole('button', { name: 'Revoke my consent' }).click();
        await expect(revokeDialog.getByRole('status')).toContainText('Consent revoked');
        expect(posts[1]).toEqual({ action: 'revoke', nonce: 'b'.repeat(64), accepted: true, policyVersion: 2 });
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { __shoreDiagnostics: { hashEvents: string[]; historyEvents: string[] } })
                        .__shoreDiagnostics,
            ),
        ).toEqual({ firstHash: '', hashEvents: [], historyEvents: [] });
        const close = revokeDialog.getByRole('button', { name: 'Close invitation', exact: true });
        const box = await close.boundingBox();
        expect(box && box.height >= 44 && box.y >= 0 && box.y + box.height <= 640).toBeTruthy();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath('shore-consent.png') });
        await close.click();
        await expect(revokeDialog).toHaveCount(0);
        await page.evaluate(() => {
            location.hash = 'ordinary-map-state';
        });
        await expect
            .poll(() =>
                page.evaluate(
                    () =>
                        (window as unknown as { __shoreDiagnostics: { hashEvents: string[] } }).__shoreDiagnostics
                            .hashEvents.length,
                ),
            )
            .toBe(1);
        expect(new URL(page.url()).hash).toBe('#ordinary-map-state');
        expect(unexpected).toEqual([]);
    });
    test(`contact consent and owner stop remain separate at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        const saves: Record<string, unknown>[] = [],
            invitations: Record<string, unknown>[] = [],
            unexpected: string[] = [];
        let confirmed = false;
        const owner = '10000000-0000-4000-8000-000000000001',
            boat = '20000000-0000-4000-8000-000000000001',
            id = '30000000-0000-4000-8000-000000000001',
            revision = '40000000-0000-4000-8000-000000000001';
        let contacts: Record<string, unknown>[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(u.hostname)) return route.continue();
            if (u.origin === backendOrigin) {
                if (u.pathname.endsWith('/shore_contacts_list'))
                    return route.fulfill({
                        json: {
                            schema: 1,
                            ownerId: owner,
                            boatId: boat,
                            checkedAt: Date.now(),
                            emailReady: true,
                            telegramReady: true,
                            contacts: contacts.map((c) => ({
                                ...c,
                                consent: confirmed ? 'confirmed' : 'pending',
                                consentedAt: confirmed ? Date.now() - 1000 : null,
                            })),
                        },
                    });
                if (u.pathname.endsWith('/configure_shore_contact')) {
                    const b = route.request().postDataJSON() as Record<string, unknown>;
                    saves.push(b);
                    contacts = b.p_configuration
                        ? [
                              {
                                  id,
                                  revision,
                                  configuration: b.p_configuration,
                                  consent: confirmed ? 'confirmed' : 'pending',
                                  consentedAt: confirmed ? Date.now() - 1000 : null,
                              },
                          ]
                        : [];
                    return route.fulfill({ json: revision });
                }
                if (u.pathname.endsWith('/anchor-alert-messaging')) {
                    invitations.push(route.request().postDataJSON() as Record<string, unknown>);
                    return route.fulfill({ json: { invitationAccepted: true } });
                }
            }
            unexpected.push(u.hostname + u.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/shore-contacts137.html');
        await page.getByLabel('Contact label', { exact: true }).fill('Generated personal contact');
        await page.getByLabel('Recipient email').fill('person@example.invalid');
        await page.getByRole('button', { name: 'Save contact off' }).click();
        await expect(page.getByRole('button', { name: 'Enable confirmed contact' })).toBeDisabled();
        expect(saves[0].p_configuration).toMatchObject({ enabled: false, sharePosition: false });
        const invite = page.getByRole('button', { name: 'Invite again / renew consent' });
        await invite.scrollIntoViewIfNeeded();
        await invite.click();
        await expect(page.getByRole('status')).toContainText('recipient must explicitly confirm');
        expect(invitations).toHaveLength(1);
        expect(saves).toHaveLength(1);
        // The fixture models a separately completed recipient POST; no real invite or provider exists.
        confirmed = true;
        await page.getByRole('button', { name: 'Reload contacts' }).click();
        await page.getByRole('button', { name: 'Enable confirmed contact' }).click();
        await expect(page.getByRole('button', { name: 'Stop this contact' })).toBeVisible();
        expect(saves[1].p_configuration).toMatchObject({ enabled: true });
        await page.getByRole('button', { name: 'Stop this contact' }).click();
        await expect(page.getByRole('button', { name: 'Enable confirmed contact' })).toBeVisible();
        expect(saves[2].p_configuration).toMatchObject({ enabled: false });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath('shore-contacts.png') });
        await page.evaluate(() => {
            (window as unknown as { __shoreAccountSwap: () => void }).__shoreAccountSwap();
        });
        await expect(page.getByText('Generated personal contact', { exact: false })).toHaveCount(0);
        await expect(page.getByLabel('Recipient email')).toHaveCount(0);
        expect(unexpected).toEqual([]);
    });
}
