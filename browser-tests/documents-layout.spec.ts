import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Documents says where every paper's file is, and shares or saves them in one
 * go (126-B3b, binder audit DOC-1 and DOC-10).
 *
 * The real DocumentsHub and index.css under a copy of the app's header and tab
 * bar (e2e/fixtures/documents.tsx), over the real local database and vault,
 * with no network: papers filed here, kept from the iPad, too big to back up,
 * only in the cloud, and one with no file. In wide fonts (Verdana on a Mac,
 * DejaVu Sans on the Linux runner), dark, daylight and night, at 320 x 568,
 * 390 x 844, 430 x 932 and the iPad split pane (507 x 640):
 *
 *   - every paper with a file has one line saying where it is ("On this
 *     phone", "Needs signal to open", "On this phone only (too big to back
 *     up)"), on one line or wrapped, never clipped, inside its card;
 *   - nothing scrolls sideways;
 *   - the ⋮ menu's "Share or save selected" is a 44 pt target, on screen, and
 *     the menu ends above the tab bar.
 *
 * Set DOCUMENTS_SHOTS_DIR (and DOCUMENTS_SHOT_TAG, e.g. before/after) to save
 * docs-430-<tag>.png and docs-430-menu-<tag>.png for Shane.
 */

const SHOTS = process.env.DOCUMENTS_SHOTS_DIR?.trim() || '';
const TAG = process.env.DOCUMENTS_SHOT_TAG?.trim() || 'after';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SIZES = [
    { name: '320x568', width: 320, height: 568 },
    { name: '390x844', width: 390, height: 844 },
    { name: '430x932', width: 430, height: 932 },
    { name: 'iPad pane 507x640', width: 507, height: 640 },
];
const MODES = ['dark', 'light', 'night'] as const;

const LABEL = /^(On this phone|Needs signal to open|On this phone only \(too big to back up\))$/;
/** Papers with a file in the fixture: three here, one kept from the iPad, one too big, three cloud only. */
const PAPERS_WITH_FILES = 7;

async function open(page: Page, size: { width: number; height: number }, mode: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1|localhost)/, (socket) => socket.close());
    await applyWideFonts(page);
    await page.setViewportSize(size);
    await page.goto(`/e2e/fixtures/documents.html?mode=${mode}`);
    await page.waitForFunction(
        () => (window as unknown as { __documentsFixtureReady?: boolean }).__documentsFixtureReady,
        undefined,
        { timeout: 25_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText('Registo de Propriedade')).toBeVisible({ timeout: 25_000 });
    return errors;
}

async function shot(page: Page, name: string) {
    if (!SHOTS) return;
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function expectNothingSideways(page: Page) {
    const overflow = await page.evaluate(() => {
        const doc = document.documentElement.scrollWidth - window.innerWidth;
        const scrollers = [...document.querySelectorAll<HTMLElement>('*')]
            .filter((el) => {
                const s = getComputedStyle(el);
                return (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.clientWidth > 0;
            })
            .map((el) => el.scrollWidth - el.clientWidth);
        return Math.max(doc, 0, ...scrollers);
    });
    expect(overflow, 'sideways overflow (px)').toBeLessThanOrEqual(1);
}

for (const mode of MODES) {
    for (const size of SIZES) {
        test(`Documents, ${mode}, ${size.name}: each card says where its file is, and fits`, async ({ page }) => {
            const errors = await open(page, size, mode);

            const labels = page.getByText(LABEL);
            await expect(labels).toHaveCount(PAPERS_WITH_FILES);
            await expect(page.getByText('On this phone', { exact: true })).toHaveCount(3);
            await expect(page.getByText('Needs signal to open', { exact: true })).toHaveCount(3);
            const phoneOnly = page.getByText('On this phone only (too big to back up)', { exact: true });
            await expect(phoneOnly).toHaveCount(1);
            if (size.width === 430 && mode === 'dark') await shot(page, `docs-430-${TAG}`);
            await shot(page, `docs-${size.width}-${mode}-${TAG}`);
            await phoneOnly.scrollIntoViewIfNeeded();
            await shot(page, `docs-${size.width}-${mode}-manual-${TAG}`);
            await expectWideFaceDrawn(labels.first());
            const measured = await labels.evaluateAll((elements) =>
                elements.map((element) => {
                    const card = element.closest('.rounded-2xl')!.getBoundingClientRect();
                    const line = element.parentElement!;
                    const r = line.getBoundingClientRect();
                    return {
                        text: element.textContent,
                        clipped:
                            line.scrollWidth > line.clientWidth + 1 || element.scrollWidth > element.clientWidth + 1,
                        inside: r.left >= card.left - 0.5 && r.right <= card.right + 0.5,
                    };
                }),
            );
            for (const m of measured) {
                expect(m.clipped, `"${m.text}" is clipped`).toBe(false);
                expect(m.inside, `"${m.text}" stays inside its card`).toBe(true);
            }
            await expectNothingSideways(page);
            expect(errors).toEqual([]);
        });

        test(`Documents, ${mode}, ${size.name}: the ⋮ menu's "Share or save selected" fits`, async ({ page }) => {
            const errors = await open(page, size, mode);
            await page.getByRole('button', { name: 'Select Registo de Propriedade' }).click();
            await page.getByRole('button', { name: 'Select Ship radio licence' }).click();
            await page.getByRole('button', { name: 'Page actions' }).click();

            const action = page.getByRole('button', { name: 'Share or save selected documents' });
            await expect(action).toBeVisible();
            await expect(action).toHaveText('Share or save selected');
            await expect(page.getByRole('button', { name: /Download selected/ })).toHaveCount(0);
            if (size.width === 430 && mode === 'dark') await shot(page, `docs-430-menu-${TAG}`);
            const m = await action.evaluate((button) => {
                const r = button.getBoundingClientRect();
                const menu = button.parentElement!.getBoundingClientRect();
                const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {
                    w: r.width,
                    h: r.height,
                    left: r.left,
                    right: r.right,
                    top: r.top,
                    menuBottom: menu.bottom,
                    menuLeft: menu.left,
                    menuRight: menu.right,
                    navTop: nav.top,
                    width: window.innerWidth,
                    clipped: button.scrollWidth > button.clientWidth + 1,
                    hitIsAction: !!hit && (hit === button || button.contains(hit)),
                };
            });
            expect(m.h, 'a 44 pt target (height)').toBeGreaterThanOrEqual(43.5);
            expect(m.w, 'a 44 pt target (width)').toBeGreaterThanOrEqual(43.5);
            expect(m.top).toBeGreaterThanOrEqual(0);
            expect(m.menuLeft, 'the menu stays on screen (left)').toBeGreaterThanOrEqual(0);
            expect(m.menuRight, 'the menu stays on screen (right)').toBeLessThanOrEqual(m.width);
            expect(m.menuBottom, 'the menu ends above the tab bar').toBeLessThanOrEqual(m.navTop);
            expect(m.clipped, 'its words are not clipped').toBe(false);
            expect(m.hitIsAction, 'a tap on it reaches it').toBe(true);
            await expectNothingSideways(page);
            expect(errors).toEqual([]);
        });
    }
}
