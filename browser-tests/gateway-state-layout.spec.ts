/**
 * The NMEA Gateway page and the System status box say where this phone is and
 * how the boat's data reaches it, in one line each, at phone width.
 *
 * Shane 2026-10-07, at home with the boat 900 km away and reading her over
 * Tailscale: "it seems to get confused about where we are … sometime take
 * over, other times it says i am onboard, sometimes it says remote, other
 * times it says live." The words come from one model now
 * (services/boatLink/boatLinkModel.ts); this checks they fit and land.
 *
 * Fictional data only (e2e/fixtures/gateway-state.tsx): no Pi, gateway,
 * account or network is behind the page, and every request off this origin is
 * refused. Wide fonts (Verdana on a Mac, DejaVu Sans on the Linux runner) so a
 * Mac wraps the way CI does; the fixture draws the app's 4rem tab bar.
 *
 * GWSTATE_SHOTS_DIR saves a screenshot of every case; GWSTATE_PHASE=before
 * only takes the pictures (the old words do not meet these rules).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SHOTS = process.env.GWSTATE_SHOTS_DIR;
const PHASE = process.env.GWSTATE_PHASE === 'before' ? 'before' : 'after';

const CASES = [
    {
        scenario: 'ashore-lan',
        pill: 'Away · Live',
        line: 'Reading the boat through your Pi, over Tailscale.',
        status: 'Away · Pi over Tailscale · live',
    },
    {
        scenario: 'ashore-cloud',
        pill: 'Away · Live',
        line: 'Reading the boat through your Pi’s internet updates.',
        status: 'Away · Pi through the cloud · live',
    },
    {
        scenario: 'ashore-takeover',
        pill: 'Away · Not connected',
        line: 'Your Pi hasn’t answered for a minute, so this phone is trying the YDWG-02 directly until it’s back.',
        status: 'Away · not connected',
    },
    {
        scenario: 'aboard-lan',
        pill: 'Aboard · Live',
        line: 'Reading the boat through your Pi, on the boat’s Wi-Fi.',
        status: 'Aboard · Pi on the boat’s Wi-Fi · live',
    },
    {
        // No Pi running Tailscale and no MagicDNS name: a 100.64/10 tunnel is
        // NetBird or WARP as often as Tailscale, so it is "your VPN".
        scenario: 'gateway-vpn',
        pill: 'Away · Live',
        line: 'Connected to the YDWG-02 over your VPN.',
        status: 'Away · YDWG-02 over your VPN · live',
    },
    {
        // Just after Disconnect: the closed socket said in the past tense.
        scenario: 'aboard-closed',
        pill: /^Aboard · \d+ s old$/,
        line: /^Last reading came through the YDWG-02 on the boat’s Wi-Fi, \d+ s ago\. It isn’t connected now\.$/,
        status: /^Aboard · YDWG-02 not connected · \d+ s old$/,
    },
    {
        // The Pi silent aboard: the policy's fallback socket, the longest status row.
        scenario: 'aboard-fallback',
        pill: 'Aboard · Live',
        line: 'Your Pi hasn’t answered for a minute, so this phone is reading the YDWG-02 directly until it’s back.',
        status: 'Aboard · YDWG-02 direct, Pi silent · live',
    },
] as const;

const SIZES = [
    { name: '375x667', width: 375, height: 667 },
    { name: '320x568', width: 320, height: 568 },
] as const;

async function open(page: Page, scenario: string, view: 'gateway' | 'status', width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
        localStorage.clear();
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            wide.textContent = ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    await page.goto(`/e2e/fixtures/gateway-state.html?scenario=${scenario}&view=${view}`);
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function shoot(page: Page, name: string) {
    if (!SHOTS) return;
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${PHASE}-${name}.png`), animations: 'disabled' });
}

async function noSidewaysScroll(page: Page) {
    const overflow = await page.evaluate(() =>
        [document.documentElement, document.body]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => `${el.tagName} ${el.scrollWidth} > ${el.clientWidth}`),
    );
    expect(overflow).toEqual([]);
}

for (const size of SIZES) {
    for (const c of CASES) {
        test(`gateway page, ${c.scenario}, ${size.name}`, async ({ page }) => {
            await open(page, c.scenario, 'gateway', size.width, size.height);
            // The old page drew one plain status pill; the pictures of it need only that.
            const pill = PHASE === 'before' ? page.getByRole('status').first() : page.getByTestId('boat-link-pill');
            await expect(pill).toBeVisible();
            await shoot(page, `gateway-${c.scenario}-${size.name}`);
            if (PHASE === 'before') return;

            // One reading for a screen reader, WHERE · DATA.
            await expect(pill).toHaveText(c.pill);
            await expect(pill).toHaveAttribute('role', 'status');
            // Each chip on one line, whole, inside the 16 px gutters; the pair
            // may wrap onto a second row under a long title at 320 pt.
            const chips = await pill.locator('[data-testid^="boat-link-"]').evaluateAll((els) =>
                els.map((el) => {
                    const r = el.getBoundingClientRect();
                    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
                    return {
                        text: el.textContent,
                        left: r.left,
                        right: r.right,
                        height: r.height,
                        lh,
                        vw: window.innerWidth,
                        clipped: el.scrollWidth > el.clientWidth + 1,
                    };
                }),
            );
            expect(chips.length).toBeGreaterThan(0);
            for (const chip of chips) {
                expect(chip.left, `${chip.text}: left`).toBeGreaterThanOrEqual(15);
                expect(chip.right, `${chip.text}: right`).toBeLessThanOrEqual(chip.vw - 15);
                expect(chip.height, `${chip.text}: one line`).toBeLessThan(chip.lh * 2);
                expect(chip.clipped, `${chip.text}: clipped`).toBe(false);
            }

            const line = page.getByTestId('gateway-link-line');
            await expect(line).toHaveText(c.line);
            const fits = await line.evaluate((el) => {
                const card = el.closest('[data-testid="gateway-card"]')!.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return r.left >= card.left - 1 && r.right <= card.right + 1 && el.scrollWidth <= el.clientWidth + 1;
            });
            expect(fits).toBe(true);
            // The Pi card stays the Pi card: no host:port controls take over.
            if (!['gateway-vpn', 'aboard-closed'].includes(c.scenario)) {
                await expect(page.getByRole('button', { name: 'Retry NMEA connection' })).toHaveCount(0);
                await expect(page.getByRole('button', { name: 'Disconnect NMEA' })).toHaveCount(0);
            }
            await noSidewaysScroll(page);
        });

        test(`status box, ${c.scenario}, ${size.name}`, async ({ page }) => {
            await open(page, c.scenario, 'status', size.width, size.height);
            await page.getByRole('button', { name: /^System status/ }).click();
            const dialog = page.getByRole('dialog', { name: 'System status' });
            await expect(dialog).toBeVisible();
            // The NMEA row sits below the GPS cards: bring it into the picture.
            const nmeaRow = dialog.getByText('NMEA gateway', { exact: true });
            await nmeaRow.scrollIntoViewIfNeeded();
            await nmeaRow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await page.evaluate(
                () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            await shoot(page, `status-${c.scenario}-${size.name}`);
            if (PHASE === 'before') return;

            const row = dialog.getByText(c.status, { exact: true });
            await expect(row).toBeVisible();
            const fits = await row.evaluate((el) => {
                const d = el.closest('[role="dialog"]')!.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return r.left >= d.left && r.right <= d.right;
            });
            expect(fits).toBe(true);
            // Whole: no clamp has cut the age off the end.
            const clipped = await row.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
            expect(clipped, 'status row clipped').toBe(false);
            await noSidewaysScroll(page);
        });
    }
}
