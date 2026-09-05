/**
 * Obs chart credits live in ONE place — the strip centred under the basemap
 * dropdown — and the licence-required Mapbox control is never occluded.
 *
 * Shane, 2026-09-06: "put them all in the same spot below the drop down box at
 * the top middle of the screen … the 'i' button for the map is hidden under
 * the location fab." Before this each credit picked its own corner and fought
 * the working controls for the same pixels; the Mapbox ⓘ sat under the fab.
 *
 * Wording is deliberately NOT asserted here beyond presence: each credit's
 * words are its licence's minimum and belong to that licence's own tests.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    CREDITS_SLOT_PX,
    CREDITS_STRIP_POSITION_CLASS,
    CREDITS_STRIP_TOP_PX,
    creditsStripTop,
} from '../components/map/creditsStrip';

const strip = (s: string) =>
    s
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the credits strip anchor', () => {
    it('starts 6px under the basemap dropdown (top inset + 8px, trigger h-12)', () => {
        const selector = readFileSync('components/map/MapBaseSelector.tsx', 'utf8');
        expect(selector).toContain("top: 'calc(env(safe-area-inset-top) + 8px)'");
        expect(selector).toMatch(/className="flex h-12 min-h-\[44px\]/);
        expect(CREDITS_STRIP_TOP_PX).toBe(8 + 48 + 6);
        expect(creditsStripTop()).toBe('calc(env(safe-area-inset-top) + 62px)');
        expect(creditsStripTop(CREDITS_SLOT_PX)).toBe('calc(env(safe-area-inset-top) + 92px)');
        expect(CREDITS_STRIP_POSITION_CLASS).toBe('absolute left-1/2 -translate-x-1/2');
    });
});

describe('every chart credit sits on the strip', () => {
    it('RainViewer: first slot, same spot shown or hidden', () => {
        const src = strip(readFileSync('components/map/MapWeatherControls.tsx', 'utf8'));
        const block = src.slice(src.indexOf('{showRainViewerAttribution && ('), src.indexOf('{controlsHidden ? ('));
        expect(block).toContain('${CREDITS_STRIP_POSITION_CLASS}');
        expect(block).toContain('top: creditsStripTop(0)');
        expect(block).not.toContain('bottom:');
        expect(block).not.toContain('right-2');
    });

    it('Copernicus: on the strip on the chart, one slot lower while RainViewer is showing', () => {
        const src = strip(readFileSync('components/map/CmemsAttribution.tsx', 'utf8'));
        expect(src).toContain('`${CREDITS_STRIP_POSITION_CLASS} z-520');
        expect(src).toContain('{ top: creditsStripTop(stackOffsetPx) }');
        // The embedded public map keeps its own placement.
        expect(src).toContain("embedded ? { bottom: '84px' }");
        const hub = strip(readFileSync('components/map/MapHub.tsx', 'utf8'));
        expect(hub).toContain('stackOffsetPx={rainCreditShown ? CREDITS_SLOT_PX : 0}');
        expect(hub).toContain("weather.activeLayers.has('rain') &&");
        // The licence's minimum wording is untouched.
        expect(src).toContain('E.U. Copernicus Marine Service Information');
    });
});

describe('the Mapbox ⓘ is never under the Locate fab', () => {
    it('lifts the bottom-right control stack above the fab row, containers only', () => {
        const css = readFileSync('index.css', 'utf8');
        // MapActionFabs: right 16px, bottom 80px + inset, 48px tall → top at 128px.
        const fabs = readFileSync('components/map/MapActionFabs.tsx', 'utf8');
        expect(fabs).toContain("bottom: 'calc(80px + env(safe-area-inset-bottom))'");
        expect(fabs).toContain('w-12 h-12');
        // Two rules name this container: the joint bottom-left/right rule
        // (4rem + 1px, the tab bar) and the dedicated lift AFTER it. The
        // cascade takes the later one, so that is the one that must clear
        // the fab: 4rem is the bar (h-16); +73px lands 9px above the fab's top.
        const rules = [
            ...css.matchAll(
                /\.mapboxgl-ctrl-bottom-right \{\s*bottom: calc\(4rem \+ (\d+)px \+ env\(safe-area-inset-bottom\)\);/g,
            ),
        ];
        expect(rules.length, 'joint rule plus the dedicated lift').toBeGreaterThanOrEqual(2);
        const lift = rules[rules.length - 1];
        expect(Number(lift[1])).toBeGreaterThanOrEqual(128 - 64 + 8);
        expect(lift.index!).toBeGreaterThan(rules[0].index!);
        // The elements themselves are never styled (MapAttributionContract).
        expect(css).not.toContain('.mapboxgl-ctrl-attrib');
        expect(css).not.toContain('.mapboxgl-ctrl-logo');
    });

    it('the ENC chip moves above the lifted stack instead of colliding with it', () => {
        const enc = strip(readFileSync('components/map/EncAttributionChip.tsx', 'utf8'));
        expect(enc).toContain("bottom: 'calc(env(safe-area-inset-bottom) + 204px)'");
        expect(enc).not.toContain('+ 136px');
    });
});
