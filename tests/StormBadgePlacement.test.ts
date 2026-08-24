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
const hud = src.slice(
    src.indexOf('const hud = document.createElement'),
    src.indexOf('map.getContainer().appendChild(hud)'),
);
const card = src.slice(src.indexOf('function buildStormBadgeDOM'), src.indexOf('// ── Header: Storm name'));

describe('storm badge placement', () => {
    it('top-aligns with the MOB FAB, derived rather than hard-coded', () => {
        // Shane 2026-08-23: "the top of the info box for storms should be at
        // the same height as the top of the mob fab."
        //
        // MOB's height is not a constant — .radial-helm-menu anchors at 192px
        // and .radial-helm-mob offsets by (safe-area-inset-top / 2 - 95px),
        // so the target slides with the notch. Two previous hard-coded values
        // (56px, then 108px) were each right on one device. The offset must
        // therefore live in CSS, next to the rule it is derived from.
        expect(hud).toContain("hud.className = 'storm-hud-badges'");
        expect(hud).not.toMatch(/top:\s*\d+px;/);

        const css = readFileSync('index.css', 'utf8');
        const mob = /\.radial-helm-mob\s*\{[^}]*top:\s*([^;]+);/.exec(css)?.[1];
        const badge = /\.storm-hud-badges\s*\{[^}]*top:\s*([^;]+);/.exec(css)?.[1];
        expect(mob).toBe('calc(env(safe-area-inset-top) / 2 - 95px)');
        // 192 (menu anchor) - 95 = 97, plus the same half-inset MOB uses.
        expect(badge).toBe('calc(97px + env(safe-area-inset-top) / 2)');

        // …and the same in short landscape, where MOB re-anchors to the
        // menu's own top instead of sitting above it.
        const landscape = css.slice(css.indexOf('@media (orientation: landscape) and (max-height: 500px)'));
        const lMob = /\.radial-helm-mob\s*\{[^}]*top:\s*([^;]+);/.exec(landscape)?.[1];
        const lBadge = /\.storm-hud-badges\s*\{[^}]*top:\s*([^;]+);/.exec(landscape)?.[1];
        expect(lMob).toBe('0 !important');
        expect(lBadge).toBe('max(64px, calc(env(safe-area-inset-top) + 52px)) !important');
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

    it('rebuildMarkers never removes the card it does not build', () => {
        // The card has now been lost to an orphaned teardown twice. It is
        // created by one effect (deps [selectedStorm?.sid, visible, mapReady])
        // and, because the 30-minute refresh hands React a fresh cyclone
        // object with an UNCHANGED sid, that effect does not re-run — so any
        // stray removal is permanent for the session.
        //
        // Asserted on SHAPE, not on the identifier: the explanatory comment in
        // that function names the literal id, so a substring check would pass
        // by accident of spelling.
        const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        const fn = src.slice(src.indexOf('const rebuildMarkers = () => {'), src.indexOf('let lastZoomInt'));
        expect(fn.length).toBeGreaterThan(100);
        expect(fn).not.toMatch(/querySelector\(\s*[`'"]#/);
    });
});
