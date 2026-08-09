/**
 * Notice markers must be DRAWN, not shaped.
 *
 * Chased for over a week as a memory bug and it never was one. The evidence,
 * in the order it arrived:
 *
 *   · The planning screen "crashes back to the Glass page", intermittently,
 *     with nothing in the logs — because iOS kills the WebContent process and
 *     the logger dies with it.
 *   · No JetsamEvent since 02 Aug across ~20 reported kills, so nothing was
 *     being reclaimed for memory.
 *   · The cache census read near zero every time: ENC 0–5 cells, DOM 2508.
 *   · 54 pins render fine, so it was never the pin count.
 *   · It tracked GEOGRAPHY. Shane: "it does seem to crash once we go above
 *     Fraser Island."
 *   · com.apple.WebKit.WebContent-2026-08-06-133814.ips: EXC_BAD_ACCESS,
 *     KERN_INVALID_ADDRESS at 0x5, faulting in TFont::NeedsShapingForGlyphs
 *     under CTFontShapeGlyphs — CoreText deciding how to shape a glyph run.
 *
 * Above Fraser Island the coast fills with Notices to Mariners, and every
 * notice marker was `el.textContent = '📄'`. An emoji misses the page font,
 * falls back to Apple Color Emoji, and must be shaped — dozens of them, all at
 * once, unprompted. That is the only thing that explains a crash tied to place
 * rather than to size, time or interaction.
 *
 * An inline SVG has no font, no fallback and no shaping. These tests keep it
 * that way, because putting the emoji back would look like a harmless tidy-up.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/map/useNoticeLayer.ts'), 'utf8');

/** Strip comments so the explanation above can name the emoji it retired. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('notice markers never hand text to CoreText', () => {
    it('sets no textContent at all on a marker element', () => {
        // Any text run in a marker is a shaping request, emoji or not.
        expect(code).not.toMatch(/el\.textContent\s*=/);
    });

    it('carries no emoji in the marker code', () => {
        const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}]/u;
        const offenders = code
            .split('\n')
            .map((line, i) => [i + 1, line] as const)
            .filter(([, line]) => emoji.test(line) && /textContent|innerText/.test(line));
        expect(offenders).toEqual([]);
    });

    it('draws each of the three markers as SVG instead', () => {
        // 📄 notices, ◈ virtual AtoN, 🌉 bridges — the three that render by the
        // dozen along a coastal route.
        expect(code).toContain('NOTICE_SVG');
        expect(code.match(/<svg /g)?.length ?? 0).toBeGreaterThanOrEqual(3);
        expect(code).toMatch(/chipEl[\s\S]{0,300}innerHTML = NOTICE_SVG/);
        expect(code).toMatch(/virtualMarkEl[\s\S]{0,400}<svg /);
        expect(code).toMatch(/bridgeEl[\s\S]{0,400}<svg /);
    });

    it('keeps an accessible name without laying out text', () => {
        // aria-label is read by VoiceOver but never becomes a text run, so the
        // markers stay reachable without re-entering the shaping path.
        expect(code).toMatch(/aria-label', 'Notice to Mariners'/);
        expect(code).toMatch(/aria-label', 'Virtual navigation aid'/);
        expect(code).toMatch(/aria-label'.*Bridge/);
        expect((code.match(/role', 'img'/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it('still distinguishes a bridge that will not clear', () => {
        // The colour was the only signal on the old emoji marker's border and
        // it must survive the redraw — a bridge below air draft has to look
        // different from one that clears.
        expect(code).toMatch(/passable \? 'rgb\(148,163,184\)' : 'rgb\(239,68,68\)'/);
    });

    it('leaves popup bodies alone — those are one at a time, on demand', () => {
        // The rule is about markers rendered en masse without being asked for.
        // A popup the skipper opened is a single shaping request and is fine.
        expect(source).toContain('localNoticePopupHtml');
    });
});
