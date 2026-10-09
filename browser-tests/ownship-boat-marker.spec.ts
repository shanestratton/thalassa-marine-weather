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
    /** Her own wind on her icon (W1-WC): '<kt>[@<from>][~]', '~' the stale tier. */
    wind?: string;
    unit?: string;
    /** The real right-rail zoom control and Locate row. */
    furniture?: boolean;
    /** state 'current': the phone's mark as a live fix or a last known one. */
    phone?: 'live' | 'last';
    /** state 'place' (126-18): the chosen place's name, 300 m from her, her message, a bubble over it. */
    place?: string;
    overlap?: boolean;
    notice?: boolean;
    popup?: boolean;
}

async function open(
    page: Page,
    {
        width,
        height,
        state,
        base = 'plain',
        theme = 'dark',
        route,
        bearing,
        name,
        wind,
        unit,
        furniture,
        phone,
        place,
        overlap,
        notice,
        popup,
    }: Open,
) {
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
    if (wind) query.set('wind', wind);
    if (unit) query.set('unit', unit);
    if (furniture) query.set('furniture', '1');
    if (phone === 'last') query.set('phone', 'last');
    if (place) query.set('place', place);
    if (overlap) query.set('overlap', '1');
    if (notice) query.set('notice', '1');
    if (popup) query.set('popup', '1');
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

/** WCAG contrast of a chip's text on its own fill (the badge by default), over the worst of black and white. */
async function badgeContrast(page: Page, selector = '.vessel-sog-badge') {
    return page.locator(selector).evaluate((badge) => {
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

test.describe('Current Location: the phone gets its own mark', () => {
    for (const size of SIZES) {
        test(`the dot at the centre, the boat on the boat, at ${size.width}x${size.height}`, async ({ page }) => {
            await open(page, { ...size, state: 'current' });
            const dot = await page.locator('.loc-dot').evaluate((el) => {
                const b = el.getBoundingClientRect();
                return {
                    x: b.left + b.width / 2,
                    y: b.top + b.height / 2,
                    width: b.width,
                    aria: el.getAttribute('aria-label'),
                    glyph: !!el.querySelector('svg[data-glyph="phone"]'),
                };
            });
            expect(Math.abs(dot.x - size.width / 2)).toBeLessThan(1);
            expect(Math.abs(dot.y - size.height / 2)).toBeLessThan(1);
            expect(dot.aria).toBe('Your phone');
            // A little phone in a badge, not the old 8 px dot (Shane 2026-10-08).
            expect(dot.width).toBeGreaterThanOrEqual(24);
            expect(dot.glyph).toBe(true);
            // The boat stays where she is, far off this view: never drawn at the phone.
            const m = await measure(page);
            const onScreen = m.fix.x >= 0 && m.fix.x <= size.width && m.fix.y >= 0 && m.fix.y <= size.height;
            expect(onScreen).toBe(false);
            await shot(page, `after-current-${size.width}`);
        });
    }
});

test.describe('Current Location: the phone reads as a phone on every base', () => {
    for (const base of ['plain', 'relief', 'sat'] as const) {
        for (const phone of ['live', 'last'] as const) {
            test(`${phone} fix · ${base}`, async ({ page }) => {
                await open(page, { width: 390, height: 844, state: 'current', base, phone, furniture: true });
                const mark = await page.locator('.loc-dot').evaluate((el) => {
                    const cs = getComputedStyle(el);
                    const glyph = el.querySelector('svg[data-glyph="phone"]')!;
                    const g = glyph.getBoundingClientRect();
                    return {
                        background: cs.backgroundColor,
                        color: cs.color,
                        border: cs.borderTopColor,
                        glyphWidth: g.width,
                        glyphHeight: g.height,
                        last: el.classList.contains('loc-dot--last'),
                        aria: el.getAttribute('aria-label'),
                    };
                });
                // White phone, white rim: blue live, grey last, never the boat's colours.
                expect(mark.color).toBe('rgb(255, 255, 255)');
                expect(mark.border).toBe('rgb(255, 255, 255)');
                expect(mark.background).toBe(phone === 'live' ? 'rgb(37, 99, 235)' : 'rgb(100, 116, 139)');
                expect(mark.last).toBe(phone === 'last');
                expect(mark.aria).toBe(phone === 'live' ? 'Your phone' : 'Your phone, last fix 2 h ago');
                expect(mark.glyphHeight).toBeGreaterThanOrEqual(14);
                // Locate draws the same phone, and says where it goes.
                const locate = page.getByRole('button', { name: 'Locate me', exact: true });
                await expect(locate.locator('svg[data-glyph="phone"]')).toHaveCount(1);
                await expect(locate).toHaveAccessibleDescription('Goes to your phone');
                await shot(page, `after-current-${phone}-${base}`);
            });
        }
    }

    test('on the boat, Locate keeps its crosshair', async ({ page }) => {
        await open(page, { width: 390, height: 844, state: 'stopped', furniture: true });
        const locate = page.getByRole('button', { name: 'Locate me', exact: true });
        await expect(locate.locator('svg[data-glyph="crosshair"]')).toHaveCount(1);
        await expect(locate).toHaveAccessibleDescription('Goes to the boat');
        await expect(page.locator('.loc-dot')).toHaveCount(0);
    });
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

/**
 * Build 123, W1-WC. Shane 2026-10-07: "what about if it is just the highest
 * zoom (14) as soon as the punter zooms out from there, then the wind models
 * kick in??" — and her own reading moves onto her icon as a small arrow and
 * number. Under the boat, centred on her fix: beside the badge it ran under
 * the right-rail zoom control, which on a 320 px phone sits level with the
 * centred boat. Wide fonts, real furniture, fictional values.
 */
async function measureWind(page: Page) {
    return page.locator('.vessel-tracker-marker').evaluate((root) => {
        const rect = (el: Element | null) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const shown = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none';
        const wind = root.querySelector<HTMLElement>('.vessel-wind-chip')!;
        const arrow = root.querySelector<HTMLElement>('.vessel-wind-arrow')!;
        const age = root.querySelector('.vessel-age-chip');
        const boat = root.querySelector<HTMLElement>('.vessel-arrow')!;
        const box = root.getBoundingClientRect();
        const fix = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        // The boat's box, unturned: a bow at any heading stays inside it.
        const half = boat.offsetWidth / 2;
        const style = getComputedStyle(wind);
        const furniture = [...document.querySelectorAll('.thalassa-map-zoom, .thalassa-map-action-fabs')].map(rect);
        return {
            fix,
            shown: shown(wind),
            wind: rect(wind)!,
            text: wind.querySelector('.vessel-wind-text')?.textContent ?? null,
            fontPx: parseFloat(style.fontSize),
            font: style.fontFamily,
            arrowShown: shown(arrow),
            arrowTransform: arrow.style.transform,
            badge: rect(root.querySelector('.vessel-sog-badge'))!,
            age: shown(age) ? rect(age) : null,
            boat: { left: fix.x - half, top: fix.y - half, right: fix.x + half, bottom: fix.y + half },
            furniture,
            aria: root.getAttribute('aria-label'),
            windAria: wind.getAttribute('aria-label'),
            tone: wind.dataset.tone ?? null,
        };
    });
}

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const WIND_SCENES = [
    { state: 'stopped', wind: '14@200', unit: 'kts', text: /^14 kt SSW$/, arrow: 'rotate(20deg)' },
    // The age chip is up over an anchor word: clear of it too.
    { state: 'anchored-stale', wind: '14@200', unit: 'kmh', text: /^26 km\/h SSW$/, arrow: 'rotate(20deg)' },
    // A bow heading south-south-west reaches down toward the chip.
    { state: 'heading', wind: '18@112', unit: 'kts', text: /^18 kt ESE$/, arrow: 'rotate(290deg)' },
    // The widest everyday words, in the stale tier.
    { state: 'underway', wind: '23@247~', unit: 'mph', text: /^27 mph WSW$/, arrow: 'rotate(65deg)' },
    { state: 'held', wind: '0.4', unit: 'kts', text: /^Calm$/, arrow: null },
] as const;

test.describe('her own wind on her own icon, under the boat', () => {
    for (const size of SIZES) {
        for (const scene of WIND_SCENES) {
            test(`${scene.state} with ${scene.wind} ${scene.unit} at ${size.width}x${size.height}`, async ({
                page,
            }) => {
                await open(page, { ...size, state: scene.state, wind: scene.wind, unit: scene.unit, furniture: true });
                const m = await measureWind(page);
                expect(m.shown).toBe(true);
                expect(m.text).toMatch(scene.text);
                expect(m.font, 'the house wide-font rule').toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
                expect(m.fontPx, "the app's 12 px floor").toBeGreaterThanOrEqual(12);
                // Centred under her fix, whole on screen.
                expect(Math.abs((m.wind.left + m.wind.right) / 2 - m.fix.x)).toBeLessThan(1);
                expect(m.wind.top).toBeGreaterThanOrEqual(m.boat.bottom);
                expect(m.wind.left).toBeGreaterThanOrEqual(8);
                expect(m.wind.right).toBeLessThanOrEqual(size.width - 8);
                expect(m.wind.height).toBeLessThanOrEqual(22);
                // Clear of the boat, the badge, the age chip and Obs's right rail.
                expect(overlaps(m.wind, m.boat), 'the boat').toBe(false);
                expect(overlaps(m.wind, m.badge), 'the badge').toBe(false);
                if (m.age) expect(overlaps(m.wind, m.age), 'the age chip').toBe(false);
                expect(m.furniture.length).toBe(2);
                for (const part of m.furniture)
                    expect(overlaps(m.wind, part!), 'the zoom control and Locate row').toBe(false);
                // The arrow flies with the wind, as the streaks do; Calm has none.
                if (scene.arrow) {
                    expect(m.arrowShown).toBe(true);
                    expect(m.arrowTransform).toBe(scene.arrow);
                } else {
                    expect(m.arrowShown).toBe(false);
                }
                expect(m.tone).toBe(scene.wind.endsWith('~') ? 'stale' : 'live');
                // Its own name, and the marker's one spoken name ends with it.
                expect(m.windAria).toMatch(/^Boat wind /);
                expect(m.aria).toMatch(/^Kittiwake, .*; boat wind /);
                await shot(page, `wind-${scene.state}-${size.width}`);
            });
        }
    }

    for (const theme of ['dark', 'light', 'night'] as const) {
        for (const base of ['plain', 'relief', 'sat'] as const) {
            for (const wind of ['14@200', '14@200~'] as const) {
                test(`legible: ${wind.endsWith('~') ? 'stale' : 'live'} · ${base} · ${theme}`, async ({ page }) => {
                    await open(page, { width: 390, height: 844, state: 'stopped', base, theme, wind });
                    // 12 px bold is not large text: 4.5:1 whatever is under the chip.
                    expect(await badgeContrast(page, '.vessel-wind-chip')).toBeGreaterThanOrEqual(4.5);
                    await shot(page, `wind-${wind.endsWith('~') ? 'stale' : 'live'}-${base}-${theme}`);
                });
            }
        }
    }

    test('with no reading of hers, the marker is exactly as before', async ({ page }) => {
        await open(page, { width: 320, height: 568, state: 'stopped', furniture: true });
        const m = await measureWind(page);
        expect(m.shown).toBe(false);
        expect(m.aria).toBe('Kittiwake, stopped; heading unavailable');
    });
});

/**
 * 126-18. Shane 2026-10-09: "also in the obs page, if it isnt the vessel
 * location or the phone location, can we have a pin in the location and that
 * is where the locate fab goes to on the obs page". The production gold pin
 * (obsPlacePin.createPlacePinElement) on the real Mapbox projection, beside
 * the boat and the phone, with the real Locate row. Phones as drawn (the
 * AS_DRAWN convention, day-planner-layout.spec.ts): the status bar and home
 * bar taken off. Wide fonts, fictional places.
 */
const PLACE_SIZES = [
    { name: '320x568 as drawn', width: 320, height: 561 },
    { name: '390x844 as drawn', width: 390, height: 779 },
    { name: '430x932 as drawn', width: 430, height: 856 },
] as const;

/** The pin, its chip and its tip, in viewport pixels, and where the place projects. */
async function measurePin(page: Page) {
    const placePx = await page.evaluate(() =>
        (window as unknown as { __ownship: { placePx(): { x: number; y: number } } }).__ownship.placePx(),
    );
    const pin = await page.locator('.obs-place-pin').evaluate((el) => {
        const rect = (node: Element) => {
            const b = node.getBoundingClientRect();
            return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        const chip = el.querySelector<HTMLElement>('.obs-place-pin__label')!;
        const fill = el.querySelector<SVGPathElement>('path[data-part="fill"]')!;
        const svg = el.querySelector('svg')!;
        const cs = getComputedStyle(chip);
        const hit = rect(el);
        const centre = { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 };
        const atCentre = document.elementFromPoint(centre.x, centre.y);
        return {
            hit,
            chip: rect(chip),
            svg: rect(svg),
            // The drawn tip: the bottom of the gold teardrop's own geometry, at its centre line.
            tip: { x: rect(fill).left + rect(fill).width / 2, y: rect(fill).bottom },
            chipText: chip.textContent,
            chipScroll: { scrollWidth: chip.scrollWidth, clientWidth: chip.clientWidth },
            chipLineHeight: parseFloat(cs.lineHeight),
            chipFontPx: parseFloat(cs.fontSize),
            chipFont: cs.fontFamily,
            chipDirection: cs.direction,
            chipMaxWidth: cs.maxWidth,
            rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
            fill: getComputedStyle(fill).fill,
            glyph: el.getAttribute('data-glyph'),
            aria: el.getAttribute('aria-label'),
            hitIsPin: !!atCentre && el.contains(atCentre),
            zIndex: getComputedStyle(el).zIndex,
        };
    });
    return { placePx, ...pin };
}

/**
 * WCAG contrast of the pin's edge against the base under it: on each base
 * pixel in a ring just outside the pin, the stronger of its navy rim and its
 * white halo; the worst pixel is returned. The night scrim tints both.
 */
async function pinEdgeContrast(page: Page, night: boolean) {
    return page.evaluate((nightScrim) => {
        const pin = document.querySelector('.obs-place-pin svg')!.getBoundingClientRect();
        const base = document.getElementById('base') as HTMLCanvasElement;
        const dpr = base.width / base.getBoundingClientRect().width;
        const ctx = base.getContext('2d')!;
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
        const scrim = (rgb: number[]) => (nightScrim ? rgb.map((c, i) => [69, 10, 10][i] * 0.25 + c * 0.75) : rgb);
        const navy = scrim([15, 23, 42]);
        const white = scrim([255, 255, 255]);
        let worst = Infinity;
        const ring: Array<[number, number]> = [];
        const pad = 3;
        for (let x = pin.left - pad; x <= pin.right + pad; x += 2) ring.push([x, pin.top - pad], [x, pin.bottom + pad]);
        for (let y = pin.top - pad; y <= pin.bottom + pad; y += 2) ring.push([pin.left - pad, y], [pin.right + pad, y]);
        for (const [x, y] of ring) {
            const [r, g, b] = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
            const under = scrim([r, g, b]);
            worst = Math.min(worst, Math.max(ratio(navy, under), ratio(white, under)));
        }
        return worst;
    }, night);
}

/** The colour actually painted at a viewport point (markers are DOM, so read a screenshot). */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
    const png = (await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })).toString(
        'base64',
    );
    return page.evaluate(async (data) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(0, 0, 1, 1).data];
    }, png);
}

const LONG_NAME = 'Puerto Bahía de los Ángeles, Baja California Sur';
/** A box with its size, as getBoundingClientRect().toJSON() gives it. */
type Rect = Box & { width: number; height: number };

test.describe("the chosen place's pin", () => {
    for (const size of PLACE_SIZES) {
        test(`on the place, named, beside the boat and the phone, at ${size.name}`, async ({ page }) => {
            await open(page, { width: size.width, height: size.height, state: 'place', furniture: true });
            const m = await measurePin(page);
            // 1. Its tip on the place.
            expect(Math.abs(m.tip.x - m.placePx.x), `tip x ${m.tip.x} vs ${m.placePx.x}`).toBeLessThanOrEqual(1);
            expect(Math.abs(m.tip.y - m.placePx.y), `tip y ${m.tip.y} vs ${m.placePx.y}`).toBeLessThanOrEqual(1);
            // Obs opens the place at the canvas centre.
            expect(Math.abs(m.placePx.x - size.width / 2)).toBeLessThan(1);
            expect(Math.abs(m.placePx.y - size.height / 2)).toBeLessThan(1);
            // 2. The name whole, on one line, in the wide face, at the 12 px floor.
            expect(m.chipText).toBe('Port Kittiwake');
            expect(m.chipFont, 'the house wide-font rule').toMatch(/^(Verdana|"DejaVu Sans"|DejaVu Sans)/);
            expect(m.chipFontPx).toBeGreaterThanOrEqual(12);
            expect(m.chipScroll.scrollWidth).toBeLessThanOrEqual(m.chipScroll.clientWidth);
            expect(m.chip.height).toBeLessThanOrEqual(m.chipLineHeight + 4);
            // Centred above the head.
            expect(Math.abs(m.chip.left + m.chip.width / 2 - m.placePx.x)).toBeLessThanOrEqual(1);
            expect(m.chip.bottom).toBeLessThanOrEqual(m.svg.top + 1);
            // 4. A real button, at least 44 × 44, on top where it is.
            expect(m.hit.width).toBeGreaterThanOrEqual(44);
            expect(m.hit.height).toBeGreaterThanOrEqual(44);
            expect(m.hitIsPin).toBe(true);
            expect(m.aria).toBe('Port Kittiwake, the place you chose. Show its weather');
            // A button to VoiceOver on the real Marker too (Mapbox makes a role-less one an image).
            await expect(
                page.getByRole('button', {
                    name: 'Port Kittiwake, the place you chose. Show its weather',
                    exact: true,
                }),
            ).toHaveCount(1);
            await expect(page.getByRole('img', { name: /the place you chose/ })).toHaveCount(0);
            // 5. Its own mark: gold, not the boat's sky nor the phone's blue.
            expect(m.glyph).toBe('place');
            expect(m.fill).toBe('rgb(250, 204, 21)');
            expect(m.fill).not.toBe('rgb(56, 189, 248)');
            expect(m.fill).not.toBe('rgb(37, 99, 235)');
            expect(m.zIndex).toBe('1');
            // The boat and the phone are still drawn where they are.
            await expect(page.locator('.vessel-tracker-marker')).toHaveCount(1);
            await expect(page.locator('.loc-dot')).toHaveCount(1);
            // 7. Locate draws the pin it goes to, and says where.
            const locate = page.getByRole('button', { name: 'Locate me', exact: true });
            await expect(locate.locator('svg[data-glyph="place"]')).toHaveCount(1);
            await expect(locate).toHaveAccessibleDescription('Goes to Port Kittiwake');
            // 8. The pin and its chip clear of the Locate row, the zoom rail and the message.
            const furniture = await page
                .locator('.thalassa-map-zoom, .thalassa-map-action-fabs')
                .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as Box));
            expect(furniture).toHaveLength(2);
            for (const part of furniture) {
                expect(overlaps(m.chip, part), 'chip vs furniture').toBe(false);
                expect(overlaps(m.svg, part), 'pin vs furniture').toBe(false);
            }
            if (size.width === 430) await shot(page, 'obspin-430-place-plain');
        });
    }

    test('a long name is cut with an ellipsis at 10rem, never wrapped; Arabic reads right to left', async ({
        page,
    }) => {
        await open(page, { width: 320, height: 561, state: 'place', place: LONG_NAME, base: 'relief' });
        const long = await measurePin(page);
        expect(long.chipText).toBe(LONG_NAME);
        expect(long.chipScroll.scrollWidth).toBeGreaterThan(long.chipScroll.clientWidth);
        expect(long.chip.width).toBeLessThanOrEqual(10 * long.rootPx + 0.5);
        expect(long.chip.height).toBeLessThanOrEqual(long.chipLineHeight + 4);
        expect(long.chip.left).toBeGreaterThanOrEqual(0);
        expect(long.chip.right).toBeLessThanOrEqual(320);
        await shot(page, 'obspin-320-place-longname');
        await open(page, { width: 320, height: 561, state: 'place', place: 'الدوحة' });
        const rtl = await measurePin(page);
        expect(rtl.chipText).toBe('الدوحة');
        expect(rtl.chipDirection).toBe('rtl');
        expect(rtl.chipScroll.scrollWidth).toBeLessThanOrEqual(rtl.chipScroll.clientWidth);
    });

    for (const theme of ['dark', 'light', 'night'] as const) {
        for (const base of ['plain', 'relief', 'sat'] as const) {
            test(`legible: ${base} · ${theme}`, async ({ page }) => {
                await open(page, { width: 390, height: 779, state: 'place', base, theme });
                // 3. 12 px bold is not large text: 4.5:1 whatever is under the chip.
                expect(await badgeContrast(page, '.obs-place-pin__label')).toBeGreaterThanOrEqual(4.5);
                // The pin's edge holds 3:1 against the base around it.
                const edge = await pinEdgeContrast(page, theme === 'night');
                expect(edge, `edge ${edge.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
                await shot(page, `obspin-390-place-${base}-${theme}`);
            });
        }
    }

    test('on Relief at 430x932 as drawn', async ({ page }) => {
        await open(page, { width: 430, height: 856, state: 'place', base: 'relief', theme: 'light', furniture: true });
        const m = await measurePin(page);
        expect(m.chipScroll.scrollWidth).toBeLessThanOrEqual(m.chipScroll.clientWidth);
        await shot(page, 'obspin-430-place-relief');
    });

    test('300 m from the boat at z10: she draws over the pin, and a weather bubble over both', async ({ page }) => {
        await open(page, { width: 430, height: 856, state: 'place', overlap: true });
        // A point painted by both: inside her mainsail and inside the pin's gold (never an antialiased edge).
        const both = await page.evaluate(() => {
            const pinFill = document.querySelector<SVGGeometryElement>('.obs-place-pin path[data-part="fill"]')!;
            // Her side-on boat: mainsail, jib, hull.
            const shapes = [
                ...document.querySelectorAll<SVGGeometryElement>('.vessel-tracker-marker .vessel-neutral-shape path'),
            ];
            const inside = (shape: SVGGeometryElement, x: number, y: number) => {
                const m = shape.getScreenCTM()!.inverse();
                const p = new DOMPoint(x, y).matrixTransform(m);
                return shape.isPointInFill(p);
            };
            const a = pinFill.getBoundingClientRect();
            for (const shape of shapes) {
                const b = shape.getBoundingClientRect();
                for (let y = Math.ceil(Math.max(a.top, b.top)); y <= Math.floor(Math.min(a.bottom, b.bottom)); y += 1)
                    for (
                        let x = Math.ceil(Math.max(a.left, b.left));
                        x <= Math.floor(Math.min(a.right, b.right));
                        x += 1
                    ) {
                        const around = [
                            [x, y],
                            [x - 1, y],
                            [x + 1, y],
                            [x, y - 1],
                            [x, y + 1],
                            [x + 1, y + 1],
                        ];
                        if (
                            around.every(
                                ([px, py]) => inside(pinFill, px + 0.5, py + 0.5) && inside(shape, px + 0.5, py + 0.5),
                            )
                        )
                            return { x, y };
                    }
            }
            return null;
        });
        expect(both, 'the pin and her sail overlap').not.toBeNull();
        const atBoth = await pixelAt(page, both!.x, both!.y);
        // Hers (white sail, blue trim), never the pin's gold.
        expect(atBoth[2], `pixel ${atBoth.join(',')}`).toBeGreaterThan(atBoth[0]);
        // And the stacking itself: hit-testing her (pointer-events lent for the look) finds her above the pin.
        const order = await page.evaluate(({ x, y }) => {
            const root = document.querySelector<HTMLElement>('.vessel-tracker-marker')!;
            root.style.pointerEvents = 'auto';
            const hit = document.elementFromPoint(x + 0.5, y + 0.5);
            root.style.pointerEvents = 'none';
            return hit?.closest('.vessel-tracker-marker, .obs-place-pin')?.className ?? null;
        }, both!);
        expect(order).toContain('vessel-tracker-marker');
        await shot(page, 'obspin-430-overlap-z10');
        // The bubble the pin's tap opens draws above both.
        await open(page, { width: 430, height: 856, state: 'place', overlap: true, popup: true });
        expect((await pixelAt(page, both!.x, both!.y)).slice(0, 3)).toEqual([255, 0, 200]);
        const pinBox = await measurePin(page);
        const top = await page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest('.mapboxgl-popup')?.className ?? null,
            { x: pinBox.hit.left + pinBox.hit.width / 2, y: pinBox.hit.top + pinBox.hit.height / 2 },
        );
        expect(top).toContain('weather-inspect-popup');
    });

    test('at 320, a Locate tap labels where it went, left of the button, clear of the rail and the message', async ({
        page,
    }) => {
        await open(page, { width: 320, height: 561, state: 'place', furniture: true, notice: true });
        const locate = page.getByRole('button', { name: 'Locate me', exact: true });
        await locate.dispatchEvent('click');
        const label = page.locator('[data-locate-label]');
        await expect(label).toHaveText('Port Kittiwake');
        await expect(page.getByRole('status').filter({ hasText: 'Chart centred on Port Kittiwake.' })).toHaveCount(1);
        const boxes = await page.evaluate(() => {
            const r = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as Rect;
            const labelEl = document.querySelector<HTMLElement>('[data-locate-label]')!;
            return {
                label: r('[data-locate-label]'),
                button: document
                    .querySelector('.thalassa-map-action-fabs button[aria-label="Locate me"]')!
                    .getBoundingClientRect()
                    .toJSON() as Rect,
                rail: r('.thalassa-map-zoom'),
                notice: r('.thalassa-obs-centre-notice > div'),
                oneLine: labelEl.scrollWidth <= labelEl.clientWidth,
                hidden: labelEl.getAttribute('aria-hidden'),
            };
        });
        expect(boxes.label.right).toBeLessThanOrEqual(boxes.button.left);
        expect(boxes.label.left).toBeGreaterThanOrEqual(8);
        expect(boxes.label.height).toBeLessThanOrEqual(boxes.button.height + 0.5);
        expect(boxes.oneLine).toBe(true);
        expect(boxes.hidden).toBe('true');
        expect(overlaps(boxes.label, boxes.rail), 'the zoom rail').toBe(false);
        expect(overlaps(boxes.label, boxes.notice), 'the message').toBe(false);
        await shot(page, 'obspin-320-locate-label');
        await open(page, { width: 430, height: 856, state: 'place', furniture: true, notice: true });
        await page.getByRole('button', { name: 'Locate me', exact: true }).dispatchEvent('click');
        await expect(page.locator('[data-locate-label]')).toHaveText('Port Kittiwake');
        await shot(page, 'obspin-430-locate-label');
    });
});
