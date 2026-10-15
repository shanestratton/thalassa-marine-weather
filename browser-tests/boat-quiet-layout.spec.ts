/**
 * Settings → Preferences → "If the boat goes quiet" (129-08), measured in a
 * browser at 320 × 568 and 375 × 667 in the house wide fonts
 * (e2e/fixtures/boat-quiet.tsx, the real GeneralTab under the settings
 * header, fictional answers, no network):
 *  - the skipper's switch, a crew member's switch per boat (a Greek boat
 *    name among them) and both at once: every switch whole, uncovered and on
 *    the screen, nothing sideways, the card no wider than itself;
 *  - the words say what the watch does and what it cannot do: it hears her
 *    only while her Pi may use the internet, and satellite mode says so;
 *  - with the watch's table not there (the column probe fails) and the crew
 *    call not there, nothing at all: no switch nothing honours;
 *  - the skipper's first switch-on saves against 125's grants (the fixture
 *    refuses an upsert 42501, as the database does): an update, then an
 *    insert, and the switch stays on.
 *
 * BOATQUIET_SHOTS_DIR saves a picture of each case (the viewport at the
 * section, and the whole page); BOATQUIET_PHASE=before only takes the
 * pictures (Preferences had no such section before 129-08).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SHOTS = process.env.BOATQUIET_SHOTS_DIR;
const PHASE = process.env.BOATQUIET_PHASE === 'before' ? 'before' : 'after';

const SIZES = [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
];

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4199').origin;
    await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/boat-quiet.html?fonts=wide&${query}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { name: 'Units' })).toBeVisible({ timeout: 20_000 });
}

async function shoot(page: Page, name: string) {
    if (!SHOTS) return;
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Whole, uncovered once scrolled to, and inside the screen's width. */
async function expectWholeAndUncovered(control: Locator, width: number) {
    await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const r = element.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return !!hit && (hit === element || element.contains(hit));
            }),
        )
        .toBe(true);
    const box = (await control.boundingBox())!;
    expect(box.height, 'tall enough to hit').toBeGreaterThanOrEqual(24);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

const CASES = [
    {
        state: 'owner',
        switches: ['Page if the boat goes quiet'],
        words: [
            'After 15 min with nothing from her Pi',
            'Wed 19:30–19:50',
            'It hears her only while her Pi may use the internet.',
        ],
    },
    {
        state: 'crew',
        switches: ['Page me if Αύρα goes quiet', 'Page me if Kestrel goes quiet'],
        words: ['Her skipper has the watch on', 'Her skipper hasn’t switched the watch on'],
    },
    {
        state: 'both',
        switches: ['Page if the boat goes quiet', 'Page me if Αύρα goes quiet', 'Page me if Kestrel goes quiet'],
        words: ['It hears her only while her Pi may use the internet.'],
    },
] as const;

test.describe('Preferences → If the boat goes quiet', () => {
    for (const size of SIZES) {
        for (const c of CASES) {
            test(`${c.state} fits ${size.width}x${size.height} in wide fonts`, async ({ page }, info) => {
                await open(page, size, `state=${c.state}`);
                const heading = page.getByRole('heading', { name: 'If the boat goes quiet' });
                if (PHASE === 'before') {
                    await shoot(page, `${info.project.name}-${c.state}-${size.width}x${size.height}`);
                }
                await expect(heading).toBeVisible({ timeout: 15_000 });
                await heading.scrollIntoViewIfNeeded();
                await shoot(page, `${info.project.name}-${c.state}-${size.width}x${size.height}`);
                for (const name of c.switches) {
                    await expectWholeAndUncovered(page.getByRole('switch', { name, exact: true }), size.width);
                }
                const card = heading.locator('xpath=following-sibling::*[1]');
                for (const text of c.words) await expect(card).toContainText(text);
                expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(
                    false,
                );
            });
        }
    }

    test('satellite mode says the watch cannot hear her', async ({ page }) => {
        await open(page, SIZES[0], 'state=owner&sat=1');
        test.skip(PHASE === 'before', 'nothing to say before 129-08');
        const card = page
            .getByRole('heading', { name: 'If the boat goes quiet' })
            .locator('xpath=following-sibling::*[1]');
        await expect(card).toContainText('Satellite mode keeps her Pi off the internet');
    });

    test('a first switch-on saves under 125’s grants: an update, then an insert, never an upsert', async ({ page }) => {
        test.skip(PHASE === 'before', 'nothing to switch before 129-08');
        await open(page, SIZES[0], 'state=new');
        const toggle = page.getByRole('switch', { name: 'Page if the boat goes quiet', exact: true });
        // The save-failed line lives in this card. Scoped to it: a new install's display mode is
        // 'Auto + night' (131-03), whose night note is a role="status" elsewhere on this page.
        const card = page
            .getByRole('heading', { name: 'If the boat goes quiet' })
            .locator('xpath=following-sibling::*[1]');
        await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
        await toggle.click();
        await expect
            .poll(() =>
                page.evaluate(() => (window as unknown as { __boatQuietWrites: unknown[] }).__boatQuietWrites.length),
            )
            .toBe(2);
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await expect(card.getByRole('status')).toHaveCount(0);
        const writes = await page.evaluate(
            () =>
                (
                    window as unknown as {
                        __boatQuietWrites: {
                            method: string;
                            onConflict: string | null;
                            prefer: string;
                            keys: string[];
                        }[];
                    }
                ).__boatQuietWrites,
        );
        expect(writes.map((w) => w.method)).toEqual(['PATCH', 'POST']);
        expect(writes[0].keys).not.toContain('owner_id');
        for (const w of writes) {
            expect(w.onConflict).toBeNull();
            expect(w.prefer).not.toContain('merge-duplicates');
        }
        // Switched off again: one update, her row now there.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(card.getByRole('status')).toHaveCount(0);
    });

    test('hidden when the probe fails: no switch nothing honours', async ({ page }, info) => {
        await open(page, SIZES[0], 'state=absent');
        // Give the probe time to answer (and fail) before looking for its absence.
        await page.waitForTimeout(1_000);
        await expect(page.getByRole('heading', { name: 'If the boat goes quiet' })).toHaveCount(0);
        await expect(page.getByRole('switch', { name: /goes quiet/ })).toHaveCount(0);
        await shoot(page, `${info.project.name}-absent-320x568`);
    });

    test('whole page pictures', async ({ page }, info) => {
        test.skip(!SHOTS, 'pictures only');
        for (const state of ['owner', 'both']) {
            await open(page, SIZES[0], `state=${state}&tall=1`);
            if (PHASE === 'after') {
                await expect(page.getByRole('heading', { name: 'If the boat goes quiet' })).toBeVisible();
            }
            await mkdir(SHOTS!, { recursive: true });
            await page.screenshot({ path: join(SHOTS!, `${info.project.name}-${state}-page-320.png`), fullPage: true });
        }
    });
});
