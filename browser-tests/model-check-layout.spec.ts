import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { DIARY_DEVICES, type DiaryDevice } from '../e2e/fixtures/diary-compose-devices';

/**
 * "Her wind vs the models" (Shane 2026-10-07: "go with your recommendation big
 * Claude"): the card, with the real CSS and the real OverlayPortal shell, on a
 * fixture page with the app's tab bar (e2e/fixtures/model-check.tsx), in every
 * state it has. House rules measured, not assumed: centred and clear of the tab
 * bar, the whole card on one screen with no scroll on every phone from 320x568
 * up (the body may scroll only as a last resort in three named cells), 44 pt
 * controls that hit-test, nothing under 12 px, nothing sideways.
 *
 * env() is 0 under Playwright, so the fixture paints each device's REAL insets
 * (DIARY_DEVICES) onto the overlay and the tab bar, and every cell also checks
 * the card's natural height against the band those insets leave:
 * H − max(16, top) − (64 + bottom + 16).
 */

const PER_LOAD_MS = 5_000;

const STATES = [
    'ranked',
    'averaged',
    // Averaged at rest alongside (the shelter note): as heavy as 'worst' bar the current note.
    'marina',
    'worst',
    'diroff',
    'only',
    'noneclose',
    'loading',
    'offline',
    'failed',
    'ratelimited',
    'nomodels',
    'offseries',
    'phone',
    'noreading',
    'stale',
    'undated',
    'ahead',
    'apparent',
    'noposition',
    'details',
] as const;
type State = (typeof STATES)[number];
type Unit = 'kts' | 'mph' | 'kmh' | 'mps';
/** Each state in its own unit ('worst' is km/h by definition), plus the wide units on the ranked states. */
const CASES: { state: State; unit: Unit }[] = [
    ...STATES.map((state) => ({ state, unit: (state === 'worst' ? 'kmh' : 'kts') as Unit })),
    ...(['mph', 'kmh', 'mps'] as const).flatMap((unit) =>
        (['ranked', 'averaged', 'diroff'] as const).map((state) => ({ state, unit })),
    ),
    { state: 'worst', unit: 'mph' },
];

interface Cell {
    device: DiaryDevice;
    wide?: boolean;
    largeText?: boolean;
    /** Body scroll allowed as a last resort for these states (all when true). */
    mayScroll?: boolean | State[];
    /** States left out of this cell (tested elsewhere). */
    skip?: State[];
    /** Attach screenshots of SHOTS for review. */
    shots?: boolean;
}

const D = DIARY_DEVICES;

async function open(page: Page, cell: Cell) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    const { device } = cell;
    await page.setViewportSize({ width: device.width, height: device.height });
    const query = new URLSearchParams({
        state: 'ranked',
        unit: 'kts',
        top: String(device.top),
        bottom: String(device.bottom),
    });
    if (device.pane) query.set('pane', 'true');
    if (cell.wide) query.set('fonts', 'wide');
    if (cell.largeText) query.set('largeText', '');
    await page.goto(`/e2e/fixtures/model-check.html?${query}`);
    await expect(page.getByRole('dialog', { name: 'Her wind vs the models' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

async function show(page: Page, state: State, unit: Unit) {
    await page.evaluate(
        ([s, u]) =>
            (window as unknown as { __modelCheckFixture: { set(s: string, u: string): void } }).__modelCheckFixture.set(
                s,
                u,
            ),
        [state, unit] as const,
    );
    await expect(page.locator('html')).toHaveAttribute('data-model-check-shown', `${state}:${unit}`);
}

/** Every geometric house rule, measured in the page. Returns what broke. */
function layoutIssues(page: Page, args: { top: number; bottom: number; mustFit: boolean; checkOneLine: boolean }) {
    return page.evaluate(({ top, bottom, mustFit, checkOneLine }) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const overlay = document.querySelector<HTMLElement>('[data-model-check]');
        const card = overlay?.querySelector<HTMLElement>('[data-model-check-card]');
        const header = card?.querySelector<HTMLElement>('[data-model-check-header]');
        const body = card?.querySelector<HTMLElement>('[data-model-check-body]');
        const footer = card?.querySelector<HTMLElement>('[data-model-check-footer]') ?? null;
        if (!overlay || !card || !header || !body) return ['no card'];
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        const paneHost = overlay.closest<HTMLElement>('.pane-portal-host');
        const frame = paneHost?.getBoundingClientRect() ?? null;
        const box = card.getBoundingClientRect();

        // The band the device's real insets leave (in a pane: the pane, less 1rem each side).
        const budget = frame ? frame.height - 32 : H - Math.max(16, top) - (64 + bottom + 16);
        const natural =
            header.getBoundingClientRect().height +
            body.scrollHeight +
            (footer?.getBoundingClientRect().height ?? 0) +
            2;
        if (mustFit) {
            if (natural > budget + 0.5)
                issues.push(`card needs ${natural.toFixed(1)}px, the band is ${budget.toFixed(1)}px`);
            if (body.scrollHeight > body.clientHeight + 1)
                issues.push(`body scrolls (${body.scrollHeight} > ${body.clientHeight})`);
        }
        if (box.height > budget + 0.5) issues.push(`card is taller than its band (${box.height} > ${budget})`);

        // Centred across the screen (or its pane) and within its band.
        const left = frame ? frame.left : 0;
        const right = frame ? frame.right : W;
        if (Math.abs(box.left - left - (right - box.right)) > 1)
            issues.push(`not centred across: ${(box.left - left).toFixed(1)} vs ${(right - box.right).toFixed(1)}`);
        const style = getComputedStyle(overlay);
        const o = overlay.getBoundingClientRect();
        const bandTop = o.top + parseFloat(style.paddingTop);
        const bandBottom = o.bottom - parseFloat(style.paddingBottom);
        const middle = (box.top + box.bottom) / 2;
        if (Math.abs(middle - (bandTop + bandBottom) / 2) > 1)
            issues.push(`not centred in its band: ${middle.toFixed(1)} vs ${((bandTop + bandBottom) / 2).toFixed(1)}`);
        if (box.top < 0) issues.push(`card starts above the screen (${box.top})`);
        if (box.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${box.bottom} > ${nav.top})`);
        if (frame && (box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5))
            issues.push('card leaves its pane');

        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        if (card.scrollWidth > card.clientWidth + 1) issues.push('card overflows sideways');
        if (body.scrollWidth > body.clientWidth + 1) issues.push('body overflows sideways');
        for (const element of card.querySelectorAll<HTMLElement>('*')) {
            const rect = element.getBoundingClientRect();
            if (!rect.width || !rect.height || element.classList.contains('sr-only')) continue;
            if (rect.left < box.left - 1 || rect.right > box.right + 1)
                issues.push(`${element.tagName} "${element.textContent?.trim().slice(0, 24)}" escapes the card`);
        }

        // Nothing under 12 px.
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const size = parseFloat(getComputedStyle(node.parentElement!).fontSize);
            if (size < 11.95) issues.push(`"${node.textContent.trim().slice(0, 24)}" is ${size}px`);
        }

        // The header and footer never scroll: title, ⓘ, ✕, caveat and credit fully visible and hit-testable.
        const fully = (el: Element, name: string, control: boolean) => {
            const rect = el.getBoundingClientRect();
            if (control && (rect.width < 43.5 || rect.height < 43.5))
                issues.push(`${name}: ${rect.width}x${rect.height}`);
            if (rect.top < Math.max(0, box.top) - 0.5 || rect.bottom > Math.min(nav.top, box.bottom) + 0.5)
                issues.push(`${name} is not fully visible`);
            const inset = Math.min(4, rect.height / 3);
            const midX = (rect.left + rect.right) / 2;
            const midY = (rect.top + rect.bottom) / 2;
            for (const [x, y] of [
                [midX, midY],
                [midX, rect.top + inset],
                [midX, rect.bottom - inset],
                [rect.left + inset, midY],
                [rect.right - inset, midY],
            ]) {
                const hit = document.elementFromPoint(x, y);
                if (!(hit === el || el.contains(hit)))
                    issues.push(`${name} is covered at ${x.toFixed(0)},${y.toFixed(0)} by ${hit?.tagName}`);
            }
        };
        const title = header.querySelector('h2');
        const caveat = header.querySelector('p');
        if (!title || !caveat) issues.push('header lost its title or caveat');
        else {
            fully(title, 'title', false);
            fully(caveat, 'caveat', false);
        }
        for (const label of ['How this works', 'Close']) {
            const button = header.querySelector(`button[aria-label="${label}"]`);
            if (!button) issues.push(`no ${label} button`);
            else fully(button, label, true);
        }
        if (footer) {
            const credit = footer.querySelector('p');
            if (!credit) issues.push('footer without its credit');
            else fully(credit, 'credit', false);
        }

        // The rows stay on one line each (mph and km/h at 320).
        if (checkOneLine)
            for (const li of card.querySelectorAll<HTMLElement>('ol > li')) {
                for (const cellEl of li.children) {
                    const rect = cellEl.getBoundingClientRect();
                    const line = parseFloat(getComputedStyle(cellEl).lineHeight);
                    if (rect.height > line * 1.5)
                        issues.push(`row "${li.textContent?.trim().slice(0, 30)}" wraps (${rect.height}px)`);
                }
            }
        return issues;
    }, args);
}

async function expectCell(page: Page, cell: Cell, info: { state: State; unit: Unit }) {
    const mayScroll = cell.mayScroll === true || (Array.isArray(cell.mayScroll) && cell.mayScroll.includes(info.state));
    const issues = await layoutIssues(page, {
        top: cell.device.top,
        bottom: cell.device.bottom,
        mustFit: !mayScroll,
        checkOneLine: cell.device.width <= 320 && !cell.largeText,
    });
    expect(issues, `${info.state} in ${info.unit}`).toEqual([]);
}

function cellName(cell: Cell): string {
    const d = cell.device;
    return `${d.name} ${d.width}x${d.height} (${d.top}/${d.bottom})${cell.wide ? ', wide fonts' : ''}${cell.largeText ? ', large text' : ''}`;
}

/** Attached for review: the states a skipper sees most, and the heaviest. */
const SHOTS: State[] = ['ranked', 'worst', 'marina', 'noreading', 'details'];

async function runCell(page: Page, cell: Cell, info: TestInfo) {
    const cases = CASES.filter((c) => !cell.skip?.includes(c.state));
    test.setTimeout(30_000 + cases.length * PER_LOAD_MS);
    const errors = await open(page, cell);
    for (const c of cases) {
        await show(page, c.state, c.unit);
        await expectCell(page, cell, c);
        if (cell.shots && SHOTS.includes(c.state) && c.unit === (c.state === 'worst' ? 'kmh' : 'kts')) {
            const name = `model-check-${c.state}-${c.unit}-${cell.device.width}x${cell.device.height}${cell.wide ? '-wide' : ''}`;
            const path = info.outputPath(`${name}.png`);
            await page.screenshot({ path, animations: 'disabled' });
            await info.attach(name, { path, contentType: 'image/png' });
        }
    }
    expect(errors).toEqual([]);
}

const MUST_FIT: Cell[] = [
    { device: D['iphone-se-zoomed'], shots: true },
    { device: D['iphone-se'] },
    { device: D['iphone-14-zoomed'] },
    { device: D['iphone-16-zoomed'] },
    { device: D['iphone-14'], shots: true },
    { device: D['tablet-pane'], shots: true },
    { device: D['iphone-se'], wide: true },
    { device: D['iphone-14-zoomed'], wide: true },
    { device: D['iphone-16-zoomed'], wide: true },
    { device: D['iphone-14'], wide: true },
    // 320x568 with wide fonts: every state but 'worst' (and the marina case, as heavy), which may
    // scroll the body as a last resort; header and credit are still checked whole and hit-testable.
    { device: D['iphone-se-zoomed'], wide: true, mayScroll: ['worst', 'marina'], shots: true },
];
const LAST_RESORT: Cell[] = [
    { device: D['iphone-14-landscape'], mayScroll: true, shots: true },
    { device: D['iphone-14'], largeText: true, mayScroll: true, shots: true },
];

test.describe('Her wind vs the models · the card fits one screen', () => {
    for (const cell of MUST_FIT) test(cellName(cell), async ({ page }, info) => runCell(page, cell, info));
});

test.describe('Her wind vs the models · the body may scroll, the header and credit never', () => {
    for (const cell of LAST_RESORT) test(cellName(cell), async ({ page }, info) => runCell(page, cell, info));
});

test('the details view and the rows: no buttons in the list, the credit only with rows', async ({ page }) => {
    await open(page, { device: D['iphone-14'] });
    const dialog = page.getByRole('dialog', { name: 'Her wind vs the models' });
    await expect(dialog.getByRole('list', { name: 'Models, closest first' })).toBeVisible();
    await expect(dialog.getByRole('list').getByRole('button')).toHaveCount(0);
    await expect(dialog).toContainText('(CC-BY-4.0) via Open-Meteo');
    await show(page, 'details', 'kts');
    await expect(dialog.getByRole('button', { name: 'How this works' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).not.toContainText('Forecast data:');
    await show(page, 'stale', 'kts');
    await expect(dialog).toContainText('Her last wind reading is');
    await expect(dialog).not.toContainText('Forecast data:');
});

// ── Wiring: the row on the real weather panel opens the real card ──

async function reachable(control: Locator) {
    await control.scrollIntoViewIfNeeded();
    await expect
        .poll(() =>
            control.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return (
                    rect.width >= 44 &&
                    rect.height >= 44 &&
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight &&
                    (hit === element || element.contains(hit))
                );
            }),
        )
        .toBe(true);
}

for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
]) {
    test(`the Wind panel's row opens the card at ${size.width}x${size.height}, and nothing is asked of the models`, async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(45_000);
        const origin = new URL(baseURL!).origin;
        const proxyRequests: string[] = [];
        page.on('request', (request) => {
            if (request.url().includes('/functions/v1/proxy-openmeteo')) proxyRequests.push(request.url());
        });
        await page.route('**/*', (route) => {
            const request = route.request();
            const url = new URL(request.url());
            return url.origin === origin && ['GET', 'HEAD'].includes(request.method())
                ? route.continue()
                : route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize(size);
        // The page's clock, so the 6 s auto-hide can be stepped past rather than waited out:
        // the CI job these specs run in sits near its time cap.
        await page.clock.install();
        await page.goto('/e2e/fixtures/weather-controls.html?follow=boat');
        const panel = page.getByRole('region', { name: 'Weather controls', exact: true });
        await expect(panel).toBeVisible();
        await page.evaluate(() => document.fonts.ready);

        // The Wind timeline is still whole on arrival: the row sits below it.
        const slider = page.getByRole('slider', { name: 'Wind timeline' });
        expect(
            await slider.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const body = element.closest('.thalassa-chart-controls-panel-body')!.getBoundingClientRect();
                return rect.top >= body.top - 0.5 && rect.bottom <= body.bottom + 0.5 && rect.bottom <= innerHeight;
            }),
        ).toBe(true);

        const row = page.getByRole('button', { name: 'Compare her wind with the models now' });
        await reachable(row);
        const shot = info.outputPath(`model-check-row-${size.width}x${size.height}.png`);
        await page.screenshot({ path: shot, animations: 'disabled' });
        await info.attach(`model-check-row-${size.width}x${size.height}`, { path: shot, contentType: 'image/png' });
        await row.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Her wind vs the models' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('No wind reading from her right now, so there is nothing to compare.');
        await expect(dialog).toContainText('One reading is a snapshot, not a verdict.');

        // The panel's 6 s auto-hide stands down while the card is open: 7 s on the page's
        // clock, every timer fired (the card's 2 s re-checks included).
        await page.clock.runFor(7_000);
        await expect(panel).toBeVisible();
        await expect(dialog).toContainText('No wind reading from her right now, so there is nothing to compare.');

        await dialog.getByRole('button', { name: 'Close' }).click();
        await expect(dialog).toBeHidden();
        await expect(row).toBeFocused();
        expect(proxyRequests).toEqual([]);
        expect(errors).toEqual([]);
    });
}
