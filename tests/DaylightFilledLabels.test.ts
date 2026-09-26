/**
 * Daylight labels on filled controls — the inverted rule (UX scorecard run 6).
 *
 * `.display-light .text-white` turns labels navy for the pale page. It used
 * to be undone fill by fill, so any filled button whose colour was missing
 * from those short allow-lists got a navy label on a saturated fill: the NMEA
 * Instrument Panel CTA measured 2.86:1 by day against 7.2:1 at night, and 31
 * more gradient buttons were one class change away from the same failure.
 *
 * index.css now inverts it: a `.text-white` element on its own chromatic
 * fill (bg-* or from-*, shade 500–900, every hue) keeps its white label by
 * day, and the element's palette steps down where white would be too faint.
 * This guard pins both halves: the whole grid is listed (so a new fill can
 * never fall off an allow-list again), and every listed fill, after the
 * step-down, measures at least 4.5:1 against white.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const css = read('index.css');
const theme = read('node_modules/tailwindcss/theme.css');

const HUES = [
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
];
/** Daylight turns these fills into light surfaces, so their labels must stay navy. */
const NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone'];
const SHADES = [500, 600, 700, 800, 900];

function filledLabelRule(): { selector: string; body: string } {
    const marker = css.indexOf('Daylight: a white label on a saturated fill stays white');
    expect(marker, 'the filled-label block is missing from index.css').toBeGreaterThan(-1);
    const start = css.indexOf('.display-light', marker);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return { selector: css.slice(start, open), body: css.slice(open + 1, close) };
}

/** Tailwind v4's stock palette value, as sRGB relative luminance. */
function luminance(hue: string, shade: number): number {
    const match = theme.match(new RegExp(`--color-${hue}-${shade}:\\s*oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`));
    if (!match) throw new Error(`--color-${hue}-${shade} not found in tailwindcss/theme.css`);
    const L = Number(match[1]) / 100;
    const C = Number(match[2]);
    const h = (Number(match[3]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

const whiteContrast = (hue: string, shade: number) => 1.05 / (luminance(hue, shade) + 0.05);

/** The day palette step-downs the rule declares: `hue-shade` → shade it resolves to. */
function stepDowns(body: string): Map<string, number> {
    const steps = new Map<string, number>();
    for (const [, hue, from, hue2, to] of body.matchAll(
        /--color-([a-z]+)-(\d{3}):\s*var\(--color-([a-z]+)-(\d{3})\)/g,
    )) {
        expect(hue2, `--color-${hue}-${from} must step within its own hue`).toBe(hue);
        steps.set(`${hue}-${from}`, Number(to));
    }
    return steps;
}

describe('daylight labels on filled controls', () => {
    it('still turns a plain white label navy on the pale page', () => {
        expect(css).toMatch(/\.display-light \.text-white \{[^}]*color: rgb\(15 23 42/);
    });

    it('keeps white on every chromatic bg-/from- fill at shade 500–900, not an allow-list', () => {
        const { selector, body } = filledLabelRule();
        expect(selector.trim().startsWith('.display-light')).toBe(true);
        expect(selector).toContain(").text-white:not(:disabled, [aria-disabled='true'])");
        expect(body).toMatch(/(^|\s)color: #ffffff;/);

        const listed = [...new Set(selector.match(/\.(?:bg|from)-[a-z]+-\d{3}/g) ?? [])].sort();
        const grid = HUES.flatMap((hue) =>
            SHADES.flatMap((shade) => [`.bg-${hue}-${shade}`, `.from-${hue}-${shade}`]),
        ).sort();
        expect(listed).toEqual(grid);
    });

    it('leaves the neutral fills, which daylight turns into light surfaces, on the navy label', () => {
        const { selector } = filledLabelRule();
        for (const neutral of NEUTRALS) {
            expect(selector).not.toMatch(new RegExp(`-${neutral}-\\d`));
        }
    });

    it('only ever steps a fill deeper', () => {
        const steps = stepDowns(filledLabelRule().body);
        expect(steps.size).toBeGreaterThan(0);
        for (const [token, to] of steps) {
            const from = Number(token.split('-').pop());
            expect(to, `${token} steps to ${to}`).toBeGreaterThan(from);
        }
    });

    it('gives every listed fill, and a 400 gradient stop beside it, at least 4.5:1 against white', () => {
        const steps = stepDowns(filledLabelRule().body);
        const failures: string[] = [];
        for (const hue of HUES) {
            for (const shade of [400, ...SHADES]) {
                const resolved = steps.get(`${hue}-${shade}`) ?? shade;
                const ratio = whiteContrast(hue, resolved);
                if (ratio < 4.5) failures.push(`${hue}-${shade} → ${hue}-${resolved}: ${ratio.toFixed(2)}:1`);
            }
        }
        expect(failures).toEqual([]);
    });
});
