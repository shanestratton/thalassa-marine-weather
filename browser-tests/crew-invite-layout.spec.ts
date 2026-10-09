import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Crew IDs stay with you (126-B4). The real InviteCrewModal and Edit Access
 * form, each in the real ModalSheet with the app's CSS and a copy of the tab
 * bar (e2e/fixtures/crew-invite.tsx), in wide fonts (Verdana on a Mac, DejaVu
 * Sans on the Linux runner), dark and daylight, at 320 x 568, 390 x 844,
 * 430 x 932 and in the iPad split pane (507 x 640).
 *
 * Measured, not assumed:
 *   - "Passage readiness" and the "Crew IDs stay with you" note never clip;
 *   - every register chip is at least 44 px tall;
 *   - every chip is the height it was before this package (the page is put
 *     back to "Checklist" with no note and measured again); "Passage
 *     readiness" may wrap like its siblings but is never the tallest chip;
 *   - the Documents chip is described by the note;
 *   - the sheet is centred (in the pane, in split view) and ends above the
 *     tab bar; at 320 x 568 the Send button scrolls fully into view, clear of
 *     the tab bar, and a tap on it reaches it.
 */

const SIZES = [
    { name: '320x568', width: 320, height: 568, pane: false },
    { name: '390x844', width: 390, height: 844, pane: false },
    { name: '430x932', width: 430, height: 932, pane: false },
    { name: 'iPad pane 507x640', width: 1024, height: 768, pane: true },
];
const NOTE = 'Crew IDs stay with you';
const SHOT_DIR = process.env.CREW_INVITE_SHOT_DIR;

async function open(page: Page, query: string, size: { width: number; height: number }) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await applyWideFonts(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/crew-invite.html?${query}`);
    await page.evaluate(() => document.fonts.ready);
    const sheet = page.locator('[data-modal-sheet]');
    await expect(sheet).toBeVisible({ timeout: 25_000 });
    // Measure the settled sheet, not its 95 % zoom-in frame.
    await sheet.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
    );
    return { errors, sheet };
}

/** The register chips' geometry, and the same chips with the page put back as it was before 126-B4. */
function chipGeometry(sheet: Locator) {
    return sheet.evaluate((panel, note) => {
        const chips = [...panel.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
        const measure = () =>
            chips.map((chip) => {
                const label = chip.querySelector('p')!;
                const box = chip.getBoundingClientRect();
                const text = label.getBoundingClientRect();
                return {
                    label: label.textContent?.trim() ?? '',
                    height: box.height,
                    clipped:
                        chip.scrollWidth > chip.clientWidth + 1 ||
                        label.scrollWidth > label.clientWidth + 1 ||
                        text.right > box.right + 0.5 ||
                        text.left < box.left - 0.5,
                };
            });
        const now = measure();
        // Put the page back as it was: "Checklist", and no note.
        const renamed = chips
            .map((chip) => chip.querySelector('p')!)
            .find((p) => p.textContent === 'Passage readiness');
        const notes = [...panel.querySelectorAll<HTMLElement>('*')].filter(
            (element) => element.children.length <= 1 && element.textContent?.trim() === note,
        );
        if (renamed) renamed.textContent = 'Checklist';
        const shown = notes.map((element) => element.style.display);
        notes.forEach((element) => (element.style.display = 'none'));
        const before = measure();
        if (renamed) renamed.textContent = 'Passage readiness';
        notes.forEach((element, index) => (element.style.display = shown[index]));
        return { now, before };
    }, NOTE);
}

async function expectChips(sheet: Locator) {
    const { now, before } = await chipGeometry(sheet);
    expect(now.map((chip) => chip.label)).toContain('Passage readiness');
    expect(now.map((chip) => chip.label)).toContain('Documents');
    expect(now.map((chip) => chip.label)).not.toContain('Checklist');
    expect(
        now.filter((chip) => chip.clipped),
        'no chip or label clips',
    ).toEqual([]);
    expect(
        now.filter((chip) => chip.height < 43.5),
        'every chip is at least 44 px tall',
    ).toEqual([]);
    now.forEach((chip, index) => {
        if (chip.label === 'Passage readiness') {
            const others = now.filter((other) => other.label !== 'Passage readiness').map((other) => other.height);
            expect(chip.height, 'Passage readiness is never the tallest chip').toBeLessThanOrEqual(
                Math.max(...others) + 0.5,
            );
        } else {
            expect(Math.abs(chip.height - before[index].height), `${chip.label} keeps its height`).toBeLessThan(0.5);
        }
    });
}

/** The note: one line, unclipped, inside the sheet, and the Documents chip's description. */
async function expectNote(page: Page, sheet: Locator) {
    const note = sheet.getByText(NOTE, { exact: true });
    await expect(note).toHaveCount(1);
    await expect(note).toBeVisible();
    const documents = sheet.locator('button[aria-pressed]').filter({ hasText: /^Documents/ });
    await expect(documents).toHaveCount(1);
    await expect(documents).toHaveAccessibleDescription(NOTE);
    const m = await note.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const panel = element.closest('[data-modal-sheet]')!.getBoundingClientRect();
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        return {
            clipped: element.scrollWidth > element.clientWidth + 1,
            inside: r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5,
            oneLine: r.height <= lineHeight * 1.5,
            height: r.height,
            lineHeight,
        };
    });
    expect(m.clipped, 'the note is not clipped').toBe(false);
    expect(m.inside, 'the note stays inside the sheet').toBe(true);
    expect(m.oneLine, `the note is one line (${m.height} vs ${m.lineHeight})`).toBe(true);
    await expectWideFaceDrawn(note);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
}

/** Centred across the screen (or its pane), inside it, and ending above the tab bar. */
async function expectSheetPlaced(sheet: Locator) {
    const g = await sheet.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const nav = document.querySelector('[data-testid="app-bottom-nav"]')!.getBoundingClientRect();
        const pane = document.querySelector('[data-split-pane]');
        const frame = pane ? pane.getBoundingClientRect() : null;
        return {
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            navTop: nav.top,
            vw: window.innerWidth,
            frame: frame && { top: frame.top, bottom: frame.bottom, left: frame.left, right: frame.right },
        };
    });
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom, 'the sheet ends above the tab bar').toBeLessThanOrEqual(g.navTop);
    if (g.frame) {
        expect(g.top).toBeGreaterThanOrEqual(g.frame.top);
        expect(g.bottom).toBeLessThanOrEqual(g.frame.bottom);
        expect(g.left).toBeGreaterThanOrEqual(g.frame.left);
        expect(g.right).toBeLessThanOrEqual(g.frame.right);
        expect(Math.abs((g.left + g.right) / 2 - (g.frame.left + g.frame.right) / 2)).toBeLessThan(2);
    } else {
        expect(g.left).toBeGreaterThanOrEqual(0);
        expect(g.right).toBeLessThanOrEqual(g.vw);
        expect(Math.abs((g.left + g.right) / 2 - g.vw / 2)).toBeLessThan(2);
    }
}

/** Scrolled into view inside the sheet: whole, above the tab bar, and the target of a tap at its centre. */
async function expectReachable(target: Locator, what: string) {
    // Retried as a whole: once, shortly after the sheet opens, both engines
    // scroll it back to the field the focus trap focused (a one-off,
    // measured: it never repeats, and a blurred field never does it).
    await expect(async () => {
        const m = await target.evaluate(async (element) => {
            // Scroll the sheet, as a thumb would, and let the frame settle.
            element.scrollIntoView({ block: 'nearest' });
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const r = element.getBoundingClientRect();
            const panel = element.closest('[data-modal-sheet]')!.getBoundingClientRect();
            const nav = document.querySelector('[data-testid="app-bottom-nav"]')!.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                top: r.top,
                bottom: r.bottom,
                height: r.height,
                panelTop: panel.top,
                panelBottom: panel.bottom,
                navTop: nav.top,
                hit: !!hit && (hit === element || element.contains(hit)),
            };
        });
        expect(m.top, `${what} starts inside the sheet`).toBeGreaterThanOrEqual(m.panelTop - 0.5);
        expect(m.bottom, `${what} ends inside the sheet`).toBeLessThanOrEqual(m.panelBottom + 0.5);
        expect(m.bottom, `${what} ends above the tab bar`).toBeLessThanOrEqual(m.navTop);
        expect(m.height).toBeGreaterThanOrEqual(43.5);
        expect(m.hit, `a tap on ${what} reaches it`).toBe(true);
    }).toPass({ timeout: 3_000 });
}

async function screenshot(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
    if (SHOT_DIR) {
        mkdirSync(SHOT_DIR, { recursive: true });
        copyFileSync(path, join(SHOT_DIR, `${name}-${info.project.name}.png`));
    }
}

for (const mode of ['dark', 'light'] as const) {
    for (const size of SIZES) {
        test(`invite sheet, ${mode}, ${size.name}: Passage readiness and the Crew IDs note fit`, async ({
            page,
        }, info) => {
            const { errors, sheet } = await open(
                page,
                `screen=invite&mode=${mode}${size.pane ? '&pane=true' : ''}`,
                size,
            );
            await expect(sheet.getByRole('button', { name: 'Share Passage readiness' })).toBeVisible();
            await expectSheetPlaced(sheet);
            await expectChips(sheet);
            await expectNote(page, sheet);
            const send = sheet.getByRole('button', { name: 'Send crew invitation' });
            await expectReachable(send, 'Send');
            if (size.width === 430 && !size.pane) {
                await sheet.getByRole('button', { name: 'Share Documents' }).scrollIntoViewIfNeeded();
                await screenshot(page, info, `invite-430-after-${mode}`);
            }
            expect(errors).toEqual([]);
        });

        test(`Edit Access, ${mode}, ${size.name}: Passage readiness and the Crew IDs note fit`, async ({ page }) => {
            const { errors, sheet } = await open(
                page,
                `screen=edit&mode=${mode}${size.pane ? '&pane=true' : ''}`,
                size,
            );
            await expect(sheet.getByRole('button', { name: 'Passage readiness' })).toBeVisible();
            await expectSheetPlaced(sheet);
            await expectChips(sheet);
            await expectNote(page, sheet);
            await expectReachable(sheet.getByRole('button', { name: 'Save crew management changes' }), 'Save');
            expect(errors).toEqual([]);
        });
    }
}
