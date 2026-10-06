/**
 * The own-ship boat: the glyph, its badge and its spoken name, as Obs draws
 * them (e2e/fixtures/ownship-boat-marker.tsx: real Mapbox projection, the
 * production marker DOM and painters, the real status words and the real
 * position message chip, on synthetic bases with a fictional boat).
 *
 * Shane 2026-10-07: "there is no longer a dot for where the vessel is. We
 * used to have a dot (but it could be a nice little boat). With either
 * anchored or stopped (depending on whether the anchor watch is on). Also it
 * would have sog."
 *
 * Wide fonts throughout (Verdana on a Mac, DejaVu Sans on the Linux runner),
 * so a Mac run lays the badge out the way CI does. Set OWNSHIP_SHOTS to a
 * directory to keep a screenshot of every scene.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.env.OWNSHIP_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

interface Open {
    width: number;
    height: number;
    state: string;
    base?: 'plain' | 'relief' | 'sat';
    theme?: 'dark' | 'light' | 'night';
    route?: boolean;
    bearing?: number;
    name?: string;
}

async function open(page: Page, { width, height, state, base = 'plain', theme = 'dark', route, bearing, name }: Open) {
    await page.setViewportSize({ width, height });
    await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : r.abort()));
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const wide = document.createElement('style');
            // The badge lives inside the Mapbox container, which sets its own
            // face ("Helvetica Neue", Arial: Liberation or DejaVu on the
            // runner), so the wide face goes there too: the badge is laid out
            // at its widest, as the rule asks.
            wide.textContent =
                ":root { --font-sans: Verdana, 'DejaVu Sans', sans-serif !important; } .mapboxgl-map { font-family: Verdana, 'DejaVu Sans', sans-serif !important; }";
            document.head.append(wide);
        });
    });
    const query = new URLSearchParams({ state, base, theme });
    if (route) query.set('route', '1');
    if (bearing) query.set('bearing', String(bearing));
    if (name) query.set('name', name);
    await page.goto(`/e2e/fixtures/ownship-boat-marker.html?${query}`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function shot(page: Page, label: string) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label}.png`) });
}

/** The glyph, the badge, the fix and what the badge says, in viewport pixels. */
async function measure(page: Page) {
    return page.locator('.vessel-tracker-marker').evaluate((root) => {
        const rect = (el: Element | null) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const arrow = root.querySelector('.vessel-arrow')!;
        const badge = root.querySelector<HTMLElement>('.vessel-sog-badge')!;
        const neutral = root.querySelector<SVGGElement>('.vessel-neutral-shape')!;
        const hull = root.querySelector<SVGGElement>('.vessel-directional-shape')!;
        const shown = getComputedStyle(neutral).display !== 'none' ? neutral : hull;
        const sideHull = neutral.querySelector('path:last-of-type');
        const box = root.getBoundingClientRect();
        // The boat's box turns with her: its layout size, around its (unturned) centre.
        const turned = rect(arrow)!;
        const size = { width: (arrow as HTMLElement).offsetWidth, height: (arrow as HTMLElement).offsetHeight };
        const centre = { x: turned.left + turned.width / 2, y: turned.top + turned.height / 2 };
        return {
            fix: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
            arrow: {
                ...size,
                left: centre.x - size.width / 2,
                top: centre.y - size.height / 2,
                right: centre.x + size.width / 2,
                bottom: centre.y + size.height / 2,
            },
            glyph: rect(shown)!,
            glyphKind: shown === neutral ? 'neutral' : 'directional',
            sideHull: getComputedStyle(neutral).display !== 'none' ? rect(sideHull) : null,
            badge: rect(badge)!,
            text: badge.textContent,
            tone: badge.dataset.tone ?? null,
            font: getComputedStyle(badge).fontFamily,
            arrowTransform: (arrow as HTMLElement).style.transform,
            halo: getComputedStyle(arrow.querySelector('svg')!).filter,
            aria: root.getAttribute('aria-label'),
            ageChip: (root.querySelector('.vessel-age-chip') as HTMLElement).style.display !== 'none',
        };
    });
}

/** WCAG contrast of the badge's text on its own chip, composited over the worst of black and white. */
async function badgeContrast(page: Page) {
    return page.locator('.vessel-sog-badge').evaluate((badge) => {
        // Any CSS colour (Tailwind 4 speaks oklch) to sRGB and alpha, through a canvas.
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const parse = (css: string) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
        };
        const over = (fg: number[], bg: number[]) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
        const lum = (rgb: number[]) => {
            const [r, g, b] = rgb.map((v) => {
                const c = v / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a: number[], b: number[]) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        const style = getComputedStyle(badge);
        const text = parse(style.color);
        const chip = parse(style.backgroundColor);
        return Math.min(
            ...[
                [0, 0, 0],
                [255, 255, 255],
            ].map((behind) => {
                const surface = over(chip, behind);
                return ratio(over(text, surface), surface);
            }),
        );
    });
}

const SIZES = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
] as const;

/**
 * An anchor word wears the anchor watch row's own colour: green only while it
 * holds, red when it has lost its data, amber while it expires.
 */
const ANCHOR_TONES: Record<string, string> = {
    anchored: 'anchored',
    'anchored-stale': 'anchored',
    'anchored-nodata': 'alarm',
    'anchored-expiring': 'caution',
    alarm: 'alarm',
    drifting: 'alarm',
};

const WORDS: Record<string, RegExp> = {
    stopped: /^Stopped$/,
    underway: /^6\.2 kts$/,
    heading: /^Stopped$/,
    anchored: /^Anchored$/,
    'anchored-stale': /^Anchored$/,
    'anchored-nodata': /^Anchored$/,
    'anchored-expiring': /^Anchored$/,
    alarm: /^Anchor alarm$/,
    drifting: /^Drifting$/,
    held: /^Last fix 3 h$/,
};

test.describe('the little boat and its badge', () => {
    for (const size of SIZES) {
        for (const state of Object.keys(WORDS)) {
            test(`${state} at ${size.width}x${size.height}`, async ({ page }) => {
                await open(page, { ...size, state });
                const m = await measure(page);
                expect(m.font, 'the house wide-font rule').toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
                expect(m.text).toMatch(WORDS[state]);
                // A 28 px boat, centred on her fix.
                expect(m.arrow.width).toBeCloseTo(28, 0);
                expect(m.arrow.height).toBeCloseTo(28, 0);
                expect(Math.abs(m.arrow.left + m.arrow.width / 2 - m.fix.x)).toBeLessThan(1);
                expect(Math.abs(m.arrow.top + m.arrow.height / 2 - m.fix.y)).toBeLessThan(1);
                // She sits at the chart's centre, as Obs centres on her.
                expect(Math.abs(m.fix.x - size.width / 2)).toBeLessThan(1);
                expect(Math.abs(m.fix.y - size.height / 2)).toBeLessThan(1);
                // The drawing fills its box: visible at a glance, not a speck.
                expect(Math.max(m.glyph.width, m.glyph.height)).toBeGreaterThanOrEqual(18);
                expect(m.halo, 'a dark hairline halo for light bases and imagery').toContain('drop-shadow');
                // The badge beside her, centred on the fix, whole on screen.
                expect(m.badge.left - m.fix.x).toBeCloseTo(18, 0);
                expect(Math.abs(m.badge.top + m.badge.height / 2 - m.fix.y)).toBeLessThan(1);
                expect(m.badge.right).toBeLessThanOrEqual(size.width - 8);
                expect(m.badge.height).toBeLessThanOrEqual(22);
                // A bow only with a direction; otherwise the upright side-on boat.
                const pointed = state === 'underway' || state === 'heading';
                expect(m.glyphKind).toBe(pointed ? 'directional' : 'neutral');
                if (state === 'underway') expect(m.arrowTransform).toBe('rotate(135deg)');
                if (state === 'heading') expect(m.arrowTransform).toBe('rotate(212deg)');
                if (!pointed) expect(m.arrowTransform).toBe('rotate(0deg)');
                // The age goes on the chip above only while an anchor word holds the badge.
                expect(m.ageChip).toBe(state === 'anchored-stale');
                expect(m.aria).toMatch(/^Kittiwake, /);
                if (ANCHOR_TONES[state]) expect(m.tone, "the anchor watch row's own colour").toBe(ANCHOR_TONES[state]);
                if (state === 'anchored-nodata') expect(m.aria).toContain('anchor watch has no current data');
                if (state === 'anchored-expiring') expect(m.aria).toContain('anchor watch authorisation expiring');
                await shot(page, `after-${state}-${size.width}`);
            });
        }
    }

    test('stopped, the chart turned: the side-on boat stays upright on screen', async ({ page }) => {
        await open(page, { width: 390, height: 844, state: 'stopped', bearing: 60 });
        const m = await measure(page);
        expect(m.glyphKind).toBe('neutral');
        // The hull is a long flat shape: level, it is far wider than tall.
        expect(m.sideHull!.width / m.sideHull!.height).toBeGreaterThan(3);
        await shot(page, 'after-stopped-bearing60-390');
    });
});

test.describe('Current Location: the phone gets its own plain dot', () => {
    for (const size of SIZES) {
        test(`the dot at the centre, the boat on the boat, at ${size.width}x${size.height}`, async ({ page }) => {
            await open(page, { ...size, state: 'current' });
            const dot = await page.locator('.loc-dot').evaluate((el) => {
                const b = el.getBoundingClientRect();
                return { x: b.left + b.width / 2, y: b.top + b.height / 2, aria: el.getAttribute('aria-label') };
            });
            expect(Math.abs(dot.x - size.width / 2)).toBeLessThan(1);
            expect(Math.abs(dot.y - size.height / 2)).toBeLessThan(1);
            expect(dot.aria).toBe('Your phone');
            // The boat stays where she is, far off this view: never drawn at the phone.
            const m = await measure(page);
            const onScreen = m.fix.x >= 0 && m.fix.x <= size.width && m.fix.y >= 0 && m.fix.y <= size.height;
            expect(onScreen).toBe(false);
            await shot(page, `after-current-${size.width}`);
        });
    }
});

test.describe('legible on every base, in every palette', () => {
    for (const theme of ['dark', 'light', 'night'] as const) {
        for (const base of ['plain', 'relief', 'sat'] as const) {
            for (const state of ['stopped', 'underway', 'anchored', 'anchored-expiring', 'alarm', 'held'] as const) {
                test(`${state} · ${base} · ${theme}`, async ({ page }) => {
                    await open(page, { width: 390, height: 844, state, base, theme });
                    const m = await measure(page);
                    expect(m.text).toMatch(WORDS[state]);
                    // 12 px bold is not large text: 4.5:1 whatever is under the chip.
                    expect(await badgeContrast(page)).toBeGreaterThanOrEqual(4.5);
                    await shot(page, `after-${state}-${base}-${theme}`);
                });
            }
        }
    }
});

test.describe('her last known position, with its message under Whole route', () => {
    for (const size of SIZES) {
        test(`the message ends above the boat at ${size.width}x${size.height}`, async ({ page }) => {
            // A long name: the message's longest everyday wording.
            await open(page, { ...size, state: 'held', route: true, name: 'Southern Cross II' });
            const message = page.getByRole('status');
            await expect(message).toHaveText(/^Showing Southern Cross II's last known position · 3 h ago$/);
            const chip = await page
                .locator('.thalassa-obs-centre-notice > div')
                .evaluate((el) => el.getBoundingClientRect().bottom);
            const m = await measure(page);
            const marker = Math.min(m.arrow.top, m.badge.top);
            // An iPhone's status bar pushes the message down by its inset
            // (20 pt on an SE, more with a notch) and leaves the boat at the
            // centre of the full-screen chart: it must clear her by that much.
            const inset = size.width === 320 ? 20 : 47;
            expect(marker - chip, `clearance ${marker - chip} px`).toBeGreaterThanOrEqual(inset + 4);
            await shot(page, `after-held-route-${size.width}`);
        });
    }
});
