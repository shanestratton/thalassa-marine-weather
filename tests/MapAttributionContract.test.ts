import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('map provider attribution contract', () => {
    it('keeps native attribution chrome and source credits on the primary chart map', () => {
        const source = read('components/map/useMapInit.ts');

        expect(source).toContain('attributionControl: true');
        expect(source).toMatch(/map\.addSource\('satellite-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?Maxar/);
        expect(source).toMatch(/map\.addSource\('hybrid-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?OpenStreetMap/);
        expect(source).toMatch(
            /map\.addSource\('maptiler-ocean',[\s\S]*?attribution:[\s\S]*?MapTiler[\s\S]*?OpenStreetMap/,
        );
        expect(source).toMatch(/map\.addSource\('openseamap-permanent',[\s\S]*?attribution:[\s\S]*?OpenSeaMap/);
        expect(source).not.toMatch(/attribution:\s*['"]\s*['"]/);
    });

    it('keeps attribution enabled on the public voyage and offline chart map surfaces', () => {
        const voyageMap = read('src/components/MapContainer.tsx');
        const offlineMap = read('components/map/ThalassaMap.tsx');

        expect(voyageMap).toMatch(/<Map[\s\S]*?attributionControl/);
        expect(voyageMap).toMatch(/id="bathy-ocean"[\s\S]*?attribution="[^"]*MapTiler[^"]*OpenStreetMap/);
        expect(offlineMap).toMatch(/<Map[\s\S]*?attributionControl/);
        expect(offlineMap).toMatch(/attribution:[\s\S]*?OpenStreetMap/);
        expect(offlineMap).toMatch(/attribution:[\s\S]*?OpenSeaMap/);
    });

    it('does not hide provider attribution controls or logos in global CSS', () => {
        const css = `${read('index.css')}\n${read('logs.html')}`;
        // Mapbox / MapLibre attribution and logo: untouchable, full stop.
        const forbiddenSelectors = ['.mapboxgl-ctrl-attrib', '.mapboxgl-ctrl-logo', '.maplibregl-ctrl-attrib'];
        for (const selector of forbiddenSelectors) {
            expect(css).not.toContain(selector);
        }

        // Leaflet attribution MAY be restyled — the stock white pill on the
        // dark Log maps was the ugliest thing aboard (Shane 2026-08-12) —
        // but the contract this test guards is VISIBILITY, not virginity:
        // every rule that mentions it must keep it shown and legible. The
        // blunt "selector must not appear" form couldn't tell a dark-glass
        // restyle from a hide, and refusing all styling is how the white
        // pill survived this long.
        const hidingVocabulary = [
            /display:\s*none/,
            /visibility:\s*hidden/,
            /opacity:\s*0(?![.\d])/,
            /font-size:\s*0(?![.\d])/,
            /color:\s*transparent/,
            /width:\s*0(?![.\d])/,
            /height:\s*0(?![.\d])/,
        ];
        // ONE exception: the compact-attribution pattern (Shane 2026-08-13:
        // "it was going to be hidden behind an 'i'"). Collapsing credits to
        // an ⓘ toggle is the licence-accepted Mapbox-compact pattern — but
        // ONLY as a toggle. Hiding vocabulary is blessed solely inside the
        // `:not(.is-open)` collapsed rule, and the blessing is conditional
        // on the expanded state actually existing and being reachable.
        const isCollapsedCompactRule = (block: string) => block.includes('.thalassa-attribution-compact:not(.is-open)');
        const attributionBlocks = css.split('}').filter((block) => block.includes('.leaflet-control-attribution'));
        for (const block of attributionBlocks) {
            if (isCollapsedCompactRule(block)) continue;
            for (const pattern of hidingVocabulary) {
                expect(block).not.toMatch(pattern);
            }
        }

        // The collapsed rule is only legal if its restore exists: an
        // `.is-open` rule that brings the credit text back.
        expect(css).toMatch(/\.thalassa-attribution-compact\.is-open[\s\S]{0,200}?font-size:\s*(?!0[^.\d])[\d.]+/);
    });

    it('lifts the chart map credits clear of the bottom tab bar', () => {
        // Declaring attribution is not the same as displaying it. mapbox-gl
        // parks its controls at bottom:0, and App.tsx's nav is fixed, opaque,
        // z-900 and h-16 + border + safe-area inset — so the logo and the
        // attribution pill sat underneath it, 100% invisible, on every chart.
        // At phone width the pill collapses to a compact ⓘ, and that was
        // buried too, leaving no route to the credits whatsoever.
        //
        // Every other assertion in this file reads SOURCE and cannot see
        // occlusion, which is precisely how this shipped. This one guards the
        // geometry: if the nav height changes, this test fails instead of the
        // licence silently breaking again.
        const css = read('index.css');
        expect(css).toContain('.thalassa-chart-map .mapboxgl-ctrl-bottom-left');
        expect(css).toContain('.thalassa-chart-map .mapboxgl-ctrl-bottom-right');
        // Must clear the 4rem nav AND the home-indicator inset.
        expect(css).toMatch(/\.thalassa-chart-map[^}]*bottom:\s*calc\(4rem[^)]*env\(safe-area-inset-bottom\)/s);
        // And the class has to actually be on MapHub's container.
        expect(read('components/map/MapHub.tsx')).toContain('thalassa-chart-map');
    });

    it('keeps the compact ⓘ toggle wired on every Log Leaflet map', () => {
        // The CSS collapse above is licence-legal only while a tap can
        // expand it. That tap lives in installCompactAttribution — so each
        // Log map component must install it, and the helper must genuinely
        // toggle the is-open class the CSS restore keys on.
        const helper = read('components/map/leafletCompactAttribution.ts');
        expect(helper).toMatch(/classList\.toggle\(\s*'is-open'\s*\)/);
        expect(helper).toMatch(/addEventListener\(\s*'click'/);

        for (const path of ['components/LiveMiniMap.tsx', 'components/TrackMapViewer.tsx']) {
            expect(read(path)).toContain('installCompactAttribution(map)');
        }
    });
});
