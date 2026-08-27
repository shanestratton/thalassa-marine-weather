/**
 * Touch targets are a seaway problem, not a checklist item.
 *
 * The 2026-08-27 UI audit resolved the effective height of every button in
 * the app and found roughly half under Apple's 44pt minimum and ~128 under
 * 32px — controls that are genuinely hard to hit one-handed on a moving
 * deck with wet hands. theme.ts has documented a 44pt rule since June and
 * nothing enforced it.
 *
 * This is a RATCHET, not a pass/fail bar. Full compliance is a layout
 * project; what matters immediately is that the number can only fall. Lower
 * the baselines when you improve things — never raise them.
 *
 * The preferred fix for an icon control whose glyph must stay small is the
 * `hit-target-44` utility in index.css: it projects a 44x44 invisible hit
 * box from the button's centre without changing the visual size. Note it
 * can extend beyond the button's bounds, so it must NOT be used where a
 * neighbouring control sits within ~44px — the later sibling would steal
 * taps meant for the earlier one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Tailwind spacing step -> px. */
const SPACING: Record<string, number> = {
    '0': 0,
    '0.5': 2,
    '1': 4,
    '1.5': 6,
    '2': 8,
    '2.5': 10,
    '3': 12,
    '3.5': 14,
    '4': 16,
    '5': 20,
    '6': 24,
    '7': 28,
    '8': 32,
    '9': 36,
    '10': 40,
    '11': 44,
    '12': 48,
    '14': 56,
    '16': 64,
};

/** Approximate line-height contributed by the text size, in px. */
const LINE_HEIGHT: Array<[string, number]> = [
    ['text-[9px]', 12],
    ['text-[10px]', 14],
    ['text-[10.5px]', 14],
    ['text-[11px]', 16],
    ['text-xs', 16],
    ['text-sm', 20],
    ['text-base', 24],
    ['text-lg', 28],
    ['text-xl', 28],
    ['text-2xl', 32],
];

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
            sourceFiles(p, out);
        } else if (p.endsWith('.tsx') && !p.includes('.test.') && !p.includes('.stories.')) {
            out.push(p);
        }
    }
    return out;
}

/** Brace-aware scan for opening <button …> tags — a naive regex breaks on
 *  the `=>` inside inline handlers and silently mis-reports. */
function buttonTags(src: string): string[] {
    const tags: string[] = [];
    let i = 0;
    while (true) {
        i = src.indexOf('<button', i);
        if (i < 0) return tags;
        const from = i + '<button'.length;
        let depth = 0;
        let quote: string | null = null;
        let k = from;
        for (; k < src.length; k++) {
            const c = src[k];
            if (quote) {
                if (c === quote && src[k - 1] !== '\\') quote = null;
            } else if (c === '"' || c === "'" || c === '`') {
                quote = c;
            } else if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '>' && depth === 0) break;
        }
        tags.push(src.slice(from, k));
        i = k;
    }
}

/** Effective height in px, or null when it cannot be resolved statically. */
function effectiveHeight(className: string): number | null {
    if (className.includes('hit-target-44')) return 44;
    const explicit = /min-h-\[(\d+)px\]/.exec(className);
    if (explicit) return Number(explicit[1]);
    const h = /\bh-(\d+(?:\.5)?)\b/.exec(className);
    if (h && SPACING[h[1]] !== undefined) return SPACING[h[1]];
    if (/\bh-(full|screen|auto)\b/.test(className)) return 44; // container-sized
    const pad = /\bpy-(\d+(?:\.5)?)\b/.exec(className) ?? /\bp-(\d+(?:\.5)?)\b/.exec(className);
    if (!pad || SPACING[pad[1]] === undefined) return null;
    const lh = LINE_HEIGHT.find(([cls]) => className.includes(cls))?.[1] ?? 24;
    return SPACING[pad[1]] * 2 + lh;
}

function measure() {
    let measurable = 0;
    let under44 = 0;
    let under32 = 0;
    for (const root of ['components', 'pages', 'src', 'modules']) {
        for (const file of sourceFiles(root)) {
            const src = readFileSync(file, 'utf8');
            for (const attrs of buttonTags(src)) {
                const m = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/s.exec(attrs);
                if (!m) continue;
                const className = [m[1], m[2], m[3]].filter(Boolean).join(' ');
                const height = effectiveHeight(className);
                if (height === null) continue;
                measurable++;
                if (height < 44) under44++;
                if (height < 32) under32++;
            }
        }
    }
    return { measurable, under44, under32 };
}

// Ratchet baselines — lower these as the sweep progresses, never raise them.
const MAX_UNDER_32 = 24;
const MAX_UNDER_44 = 354;

describe('button touch targets', () => {
    const result = measure();

    it('has no button under 32px beyond the ratchet', () => {
        expect(
            result.under32,
            `${result.under32} buttons resolve under 32px (ratchet ${MAX_UNDER_32}). ` +
                `Add the hit-target-44 utility for icon controls whose glyph must stay small, ` +
                `or min-h-[44px] where the layout can absorb it. If this number FELL, lower the ratchet.`,
        ).toBeLessThanOrEqual(MAX_UNDER_32);
    });

    it('holds the sub-44px count at or below the ratchet', () => {
        expect(
            result.under44,
            `${result.under44} of ${result.measurable} measurable buttons are under 44pt (ratchet ${MAX_UNDER_44}).`,
        ).toBeLessThanOrEqual(MAX_UNDER_44);
    });

    it('still measures a meaningful sample — the parser has not silently broken', () => {
        // If a refactor breaks the scan, the counts collapse to zero and both
        // assertions above pass vacuously. This is the tripwire for that.
        expect(result.measurable).toBeGreaterThan(700);
    });
});
