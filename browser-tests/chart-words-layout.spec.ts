import { expect, test, type Page } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * Charts stay on the boat (127-C-b): where chart facts were not kept, the
 * skipper reads plain words instead, and they must fit. Measured with the real
 * components and CSS inside the app shell with the real tab bar
 * (e2e/fixtures/chart-words.tsx): the Route tracer's stub rows ("caution · tap
 * for why", "needs tide · tap for the window", the land words) are at most two
 * lines each; the departure planner's "Tide gates for this route need your
 * boat's charts" line and the saved-plan notes wrap inside their cards;
 * nothing sits under the tab bar and nothing overflows sideways — at phone
 * sizes as drawn, the iPad split pane, landscape and large text, in the
 * system face and in wide fonts (Verdana here, DejaVu Sans on CI). Nouméa and
 * Tromsø are over protected charts; the Chesapeake (NOAA) keeps its figures.
 */

const phones = [
    { name: '320x561', width: 320, height: 561, extra: '&root=app' },
    { name: '375x662', width: 375, height: 662, extra: '&root=app' },
    { name: '390x779', width: 390, height: 779, extra: '&root=app' },
    { name: '430x856', width: 430, height: 856, extra: '&root=app' },
];
const others = [
    { name: '1024x768 split pane', width: 1024, height: 768, extra: '&pane=true' },
    { name: 'landscape 844x390', width: 844, height: 390, extra: '&root=app' },
    { name: 'large text 375x662', width: 375, height: 662, extra: '&largeText' },
];
const VIEWS = ['legs', 'sweep', 'caveats'] as const;
type View = (typeof VIEWS)[number];

async function open(page: Page, size: { width: number; height: number }, query: string) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET'
            ? route.continue()
            : route.abort();
    });
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/e2e/fixtures/chart-words.html?${query}`);
    await page.waitForFunction(() => (window as unknown as { __chartWordsReady?: boolean }).__chartWordsReady);
    await page.evaluate(() => document.fonts.ready);
    return errors;
}

/** Every rule, measured in the page. Returns what broke. */
function layoutIssues(page: Page, view: View) {
    return page.evaluate((v) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        if (document.documentElement.scrollWidth > W + 1) issues.push('page overflows sideways');
        const box = (
            v === 'legs'
                ? document.querySelector('[data-fixture-card]')
                : v === 'sweep'
                  ? document.querySelector('[role="dialog"]')
                  : document.querySelector('[data-testid="plan-route-caveats"]')
        ) as HTMLElement | null;
        if (!box) return [`no ${v} card`];
        const card = box.getBoundingClientRect();
        if (card.bottom > nav.top + 0.5) issues.push(`card runs under the tab bar (${card.bottom} > ${nav.top})`);
        if (card.right > W + 0.5 || card.left < -0.5) issues.push('card leaves the screen');
        if (box.scrollWidth > box.clientWidth + 1) issues.push('card overflows sideways');
        const texts =
            v === 'legs'
                ? [...box.querySelectorAll<HTMLElement>('.cursor-pointer > div:first-child')]
                : v === 'sweep'
                  ? [...box.querySelectorAll<HTMLElement>('p')].filter((p) => /boat's charts/.test(p.textContent ?? ''))
                  : [...box.querySelectorAll<HTMLElement>('p')];
        if (texts.length === 0) issues.push(`no ${v} words`);
        for (const element of texts) {
            const rect = element.getBoundingClientRect();
            const words = element.textContent?.trim().slice(0, 28);
            if (rect.left < card.left - 1 || rect.right > card.right + 1) issues.push(`"${words}" escapes its card`);
            if (element.scrollWidth > element.clientWidth + 1) issues.push(`"${words}" overflows sideways`);
            if (v === 'legs') {
                const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
                const lines = Math.round(rect.height / lineHeight);
                if (lines > 2) issues.push(`"${words}" takes ${lines} lines`);
            }
        }
        return issues;
    }, view);
}

for (const fonts of ['system', 'wide'] as const) {
    for (const size of [...phones, ...others]) {
        test(`chart words fit ${size.name} (${fonts} face), clear of the tab bar`, async ({ page }) => {
            for (const view of VIEWS) {
                const errors = await open(
                    page,
                    size,
                    `view=${view}&place=noumea${size.extra}${fonts === 'wide' ? '&fonts=wide' : ''}`,
                );
                if (view === 'legs') {
                    await expect(page.getByText('caution · tap for why')).toBeVisible();
                    await expect(page.getByText('needs tide · tap for the window')).toBeVisible();
                    await expect(page.getByText('crosses charted land')).toBeVisible();
                    if (fonts === 'wide') await expectWideFaceDrawn(page.getByText('caution · tap for why'));
                } else if (view === 'sweep') {
                    await expect(page.getByText(/Tide gates for this route need your boat's charts/)).toBeVisible();
                    await expect(page.getByText('CLEAR', { exact: true })).toHaveCount(0);
                } else {
                    await expect(page.getByText(/^Red on this route: part of it dries/)).toBeVisible();
                    await expect(page.getByTestId('plan-route-caveats')).not.toContainText('0.6 m');
                }
                await expect.poll(() => layoutIssues(page, view), { timeout: 3_000 }).toEqual([]);
                expect(errors).toEqual([]);
            }
        });
    }
}

test('Tromsø (high latitude, protected) reads the same words at 320 in wide fonts', async ({ page }) => {
    for (const view of VIEWS) {
        await open(page, phones[0], `view=${view}&place=tromso&root=app&fonts=wide`);
        await expect.poll(() => layoutIssues(page, view), { timeout: 3_000 }).toEqual([]);
    }
    await open(page, phones[0], 'view=legs&place=tromso&root=app&fonts=wide');
    await expect(page.getByText('caution · tap for why')).toBeVisible();
});

test('the Chesapeake (NOAA, open data) keeps its full figures', async ({ page }) => {
    await open(page, phones[2], 'view=legs&place=chesapeake&root=app&fonts=wide');
    await expect(page.getByText('clear — 6.4 m least')).toBeVisible();
    await expect(page.getByText('thin water — 1.6 m charted at low tide')).toBeVisible();
    await expect(page.getByText('tap for why')).toHaveCount(0);
    await expect.poll(() => layoutIssues(page, 'legs'), { timeout: 3_000 }).toEqual([]);
    await open(page, phones[2], 'view=caveats&place=chesapeake&root=app&fonts=wide');
    await expect(page.getByTestId('plan-route-caveats')).toContainText('dries 0.6 m');
    await open(page, phones[2], 'view=sweep&place=chesapeake&root=app&fonts=wide');
    await expect(page.getByText(/Tide gates for this route need your boat's charts/)).toHaveCount(0);
});

for (const mode of ['light', 'night'] as const) {
    test(`chart words fit 390x779 in ${mode} mode`, async ({ page }) => {
        for (const view of VIEWS) {
            await open(page, phones[2], `view=${view}&place=noumea&root=app&fonts=wide&mode=${mode}`);
            await expect.poll(() => layoutIssues(page, view), { timeout: 3_000 }).toEqual([]);
        }
    });
}
