/**
 * Sunlight mode is a hand-maintained allow-list, so it fails SILENTLY.
 *
 * `.display-light` re-maps dark-palette Tailwind utilities one rule at a
 * time (index.css). Any near-white text utility a component uses without a
 * matching rule keeps its dark-mode colour and renders near-invisible on a
 * light surface — and nothing anywhere fails when that happens. The
 * 2026-08-27 UI audit found 20 of 39 text utilities uncovered, including
 * text-white/90, text-white/45 and text-white/35.
 *
 * This is the guard: use a text utility the daylight sheet does not cover and
 * this test fails, which is the only way an allow-list of this shape can be
 * safe to keep.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const css = readFileSync('index.css', 'utf8');

/** Every source root tailwind.config.js compiles class names from. */
const ROOTS = 'components pages src modules hooks context contexts services utils';

/**
 * Neutrals AND chromatics. The chromatic families were the second proven
 * hole: the daylight sheet has always carried amber/sky/emerald/red rules,
 * so the author knew coloured text needs them — but the guard policed none
 * of it, and text-amber-200 (79 uses, on the Glass) rendered ~1.2:1 on a
 * white card with the suite green.
 */
const FAMILIES = [
    'white',
    'gray',
    'slate',
    'zinc',
    'neutral',
    'stone',
    'amber',
    'sky',
    'emerald',
    'red',
    'cyan',
    'teal',
    'blue',
    'green',
    'violet',
    'purple',
    'yellow',
    'orange',
    'rose',
    'indigo',
    'lime',
    'pink',
    'fuchsia',
].join('|');

/** Classes carrying a `.display-light …` override, unescaped. */
function coveredByDaylight(): Set<string> {
    const rules = css.match(/\.display-light\s+\.[-A-Za-z0-9_\\[\]/.]+/g) ?? [];
    return new Set(rules.map((r) => r.replace(/^\.display-light\s+\./, '').replace(/\\/g, '')));
}

/** Every text-* colour utility actually used in app source. */
function textUtilitiesInUse(): Map<string, number> {
    // Scan every root tailwind.config.js globs. The first cut of this guard
    // scanned only components/pages/src/modules, so App.tsx's own
    // text-white/45 sat outside it — and a probe file dropped in hooks/ with
    // an uncovered utility left the suite green.
    const out = execSync(
        `grep -rohE "text-(${FAMILIES})(/[0-9]+|-[0-9]{2,3}(/[0-9]+)?)?" ${ROOTS} ./*.tsx 2>/dev/null || true`,
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
        .split('\n')
        .filter(Boolean);
    const counts = new Map<string, number>();
    for (const cls of out) counts.set(cls, (counts.get(cls) ?? 0) + 1);
    return counts;
}

/**
 * Already-dark text used as dark-on-light chip copy (amber/emerald buttons).
 * Remapping these would invert exactly the cases that were already correct.
 */
const INTENTIONALLY_DARK = new Set(['text-slate-900', 'text-slate-950']);

/**
 * Chromatic steps 600 and darker are legible on a white surface by
 * construction (amber-700 measures 5.0:1, red-700 6.5:1), so they need no
 * daylight remap. Steps 50-500 do: amber-400 is ~1.7:1 on white.
 */
const DARK_ENOUGH_STEP = /-(600|700|800|900|950)(\/|$)/;

describe('sunlight mode coverage', () => {
    it('every text utility in use has a daylight override', () => {
        const covered = coveredByDaylight();
        const uncovered = [...textUtilitiesInUse().entries()]
            .filter(([cls]) => !covered.has(cls) && !INTENTIONALLY_DARK.has(cls) && !DARK_ENOUGH_STEP.test(cls))
            .sort((a, b) => b[1] - a[1]);

        expect(
            uncovered,
            `These text utilities have no .display-light rule, so they keep their dark-mode colour ` +
                `on a light surface:\n${uncovered.map(([c, n]) => `  ${n}x ${c}`).join('\n')}\n` +
                `Add a rule in index.css, or add it to INTENTIONALLY_DARK if it is dark-on-light chip text.`,
        ).toEqual([]);
    });

    it('keeps the two intentionally-dark utilities un-remapped', () => {
        // If someone "helpfully" adds these to the daylight sheet, dark text
        // on amber buttons becomes light text on amber buttons.
        const covered = coveredByDaylight();
        for (const cls of INTENTIONALLY_DARK) expect(covered.has(cls)).toBe(false);
    });
});

describe('muted text meets the AA floor in the dark palettes', () => {
    it('lifts gray-500 / slate-500 / white-40 outside sunlight mode', () => {
        // text-gray-500 (#6B7280) on slate-950 measures 4.24:1 — under the
        // 4.5:1 WCAG AA floor for normal text, and it is the app's most-used
        // muted-text utility. Lifted by rule rather than at ~690 call sites.
        for (const sel of [
            ':root:not(.display-light):not(.theme-onshore) .text-gray-500',
            ':root:not(.display-light):not(.theme-onshore) .text-slate-500',
            ':root:not(.display-light).theme-onshore .text-gray-500',
            String.raw`:root:not(.display-light) .text-white\/40`,
        ]) {
            expect(css).toContain(sel);
        }
    });

    it('does NOT out-rank the onshore palette — the warm ramp must survive', () => {
        // The first cut was a single :root:not(.display-light) rule at
        // specificity (0,3,0) sitting 3,380 lines BELOW
        // `.theme-onshore .text-gray-500` (0,2,0). It won on both counts, so
        // it fixed contrast by silently deleting the onshore warm ramp —
        // every muted label went cool gray in a theme whose whole point is
        // warm stone. Onshore must keep a rule of its own.
        expect(css).toContain(':root:not(.display-light).theme-onshore .text-gray-500');
        expect(css).not.toContain(':root:not(.display-light) .text-gray-500 {');
    });

    it('guards the lift off sunlight mode, which remaps those three itself', () => {
        // Without :not(.display-light) the lift would fight the daylight
        // sheet and re-lighten text that had just been darkened for a white
        // background.
        const lift = css.slice(css.indexOf('MUTED TEXT — WCAG AA floor'));
        expect(lift).not.toMatch(/^:root \.text-gray-500/m);
    });
});
