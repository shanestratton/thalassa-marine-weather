/**
 * Storm info card placement and stacking (Shane 2026-08-22: "it is too high
 * up on the screen and is in the heading area along with the zoom level etc.
 * can it come down to just below the zoom level pill and unroll from the left
 * to the right instead of top to bottom? keep the colors the same, and make
 * sure that it is on top of all other layers").
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
const hud = src.slice(src.indexOf('const hud = document.createElement'), src.indexOf('map.getContainer().appendChild(hud)'));
const card = src.slice(src.indexOf('function buildStormBadgeDOM'), src.indexOf('// ── Header: Storm name'));

describe('storm badge placement', () => {
    it('sits below the header FAB row, not in it', () => {
        // 56px is the header row — mic FAB, status pill, zoom readout. 104px
        // is where this app already starts the next row (ChartDepthControls).
        expect(hud).toContain('top: 108px;');
        expect(hud).not.toContain('top: 56px;');
    });

    it('stacks above the FAB rail and the route banner', () => {
        // Rail FABs are z-700 and the route banner z-720, so the old z-600
        // could be covered by furniture.
        const z = Number(/z-index:\s*(\d+)/.exec(hud)?.[1]);
        expect(z).toBeGreaterThan(720);
        expect(Number(/z-index:(\d+)/.exec(card)?.[1])).toBeGreaterThan(720);
    });

    it('unrolls left to right, not top to bottom', () => {
        expect(src).toContain('@keyframes storm-badge-unroll');
        expect(card).toContain('animation:storm-badge-unroll');
        const kf = src.slice(src.indexOf('@keyframes storm-badge-unroll'), src.indexOf('@keyframes cyclone-blob'));
        // max-width, so the horizontal reveal happens without a height change.
        expect(kf).toContain('max-width: 0');
        expect(kf).toContain('max-width: 320px');
        // NOT scaleX: that stretches the type on the way in and snaps it
        // straight at the end, which reads as a glitch rather than a reveal.
        expect(kf).not.toContain('scaleX');
    });

    it('keeps the accent colouring untouched', () => {
        // "keep the colors the same" — the card is themed off the storm's
        // category accent and that must survive a layout change.
        expect(card).toContain('${d.accentColor}33');
        expect(card).toContain('border-top:3px solid ${d.accentColor}');
        expect(card).toContain('0 0 16px ${d.accentColor}15');
    });

    it('injects its keyframes on the badge path, not only the visibility path', () => {
        // The injector lives in a different effect. CSS ignores an unknown
        // animation name silently, so an ordering slip would cost the unroll
        // with nothing in the console to say why.
        const badgeMount = src.slice(src.indexOf('const HUD_ID ='), src.indexOf('map.getContainer().appendChild(hud)'));
        expect(badgeMount).toContain('injectCycloneCSS();');
    });
});
