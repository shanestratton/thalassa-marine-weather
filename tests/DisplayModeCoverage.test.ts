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

/** Classes carrying a `.display-light …` override, unescaped. */
function coveredByDaylight(): Set<string> {
    const rules = css.match(/\.display-light\s+\.[-A-Za-z0-9_\\[\]/.]+/g) ?? [];
    return new Set(rules.map((r) => r.replace(/^\.display-light\s+\./, '').replace(/\\/g, '')));
}

/** Every text-* colour utility actually used in app source. */
function textUtilitiesInUse(): Map<string, number> {
    const out = execSync(
        'grep -rohE "text-(white|gray|slate|zinc|neutral|stone)(/[0-9]+|-[0-9]{2,3}(/[0-9]+)?)?" components pages src modules || true',
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
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

describe('sunlight mode coverage', () => {
    it('every text utility in use has a daylight override', () => {
        const covered = coveredByDaylight();
        const uncovered = [...textUtilitiesInUse().entries()]
            .filter(([cls]) => !covered.has(cls) && !INTENTIONALLY_DARK.has(cls))
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
            ':root:not(.display-light) .text-gray-500',
            ':root:not(.display-light) .text-slate-500',
            String.raw`:root:not(.display-light) .text-white\/40`,
        ]) {
            expect(css).toContain(sel);
        }
    });

    it('guards the lift off sunlight mode, which remaps those three itself', () => {
        // Without :not(.display-light) the lift would fight the daylight
        // sheet and re-lighten text that had just been darkened for a white
        // background.
        const lift = css.slice(css.indexOf('MUTED TEXT — WCAG AA floor'));
        expect(lift).not.toMatch(/^:root \.text-gray-500/m);
    });
});
