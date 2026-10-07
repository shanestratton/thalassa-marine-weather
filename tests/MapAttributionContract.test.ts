import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('map provider attribution contract', () => {
    it('keeps native attribution chrome and source credits on the primary chart map', () => {
        const source = read('components/map/useMapInit.ts');

        // Native controls may be installed explicitly to fit a split pane;
        // disabling the automatic duplicate must never remove the real one.
        expect(source).toContain('installPaneAwareAttribution(map, containerRef.current)');
        const helper = read('components/map/paneAwareAttribution.ts');
        expect(helper).toContain('new mapboxgl.AttributionControl(');
        expect(helper).toContain("map.addControl(control, 'bottom-right')");
        expect(source).toMatch(/map\.addSource\('satellite-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?Maxar/);
        expect(source).toMatch(/map\.addSource\('hybrid-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?OpenStreetMap/);
        // The relief sources carry GEBCO's and Geoscience Australia's credits
        // and the not-for-navigation line (their licence conditions).
        expect(source).toContain('addReliefBase(map)');
        const relief = read('components/map/reliefBase.ts');
        expect(relief).toMatch(/attribution: RELIEF_ATTRIBUTION/);
        expect(relief).toMatch(
            /export const RELIEF_ATTRIBUTION =[\s\S]*?GEBCO[\s\S]*?Geoscience Australia[\s\S]*?Not for navigation/,
        );
        expect(source).toMatch(/map\.addSource\('openseamap-permanent',[\s\S]*?attribution:[\s\S]*?OpenSeaMap/);
        expect(source).not.toMatch(/attribution:\s*['"]\s*['"]/);
    });

    it('keeps attribution enabled on the public voyage and offline chart map surfaces', () => {
        const voyageMap = read('src/components/MapContainer.tsx');
        const offlineMap = read('components/map/ThalassaMap.tsx');

        expect(voyageMap).toMatch(/<Map[\s\S]*?attributionControl/);
        // The public page's depth hint is Mapbox's own bathymetry tileset now,
        // credited by the Mapbox line the style already shows.
        expect(voyageMap).toMatch(/id="bathy-ocean"[\s\S]*?url="mapbox:\/\/mapbox\.mapbox-bathymetry-v2"/);
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
        // Must clear the 4rem nav AND the home-indicator inset. The band is one
        // custom property, so the chart's own bottom-left controls (measured
        // from it) cannot drift back onto the wordmark; the containers read it.
        expect(css).toMatch(
            /:root \{\s*--thalassa-chart-credits-bottom: calc\(4rem \+ 1px \+ env\(safe-area-inset-bottom\)\);\s*\}/,
        );
        expect(css).toMatch(
            /\.thalassa-chart-map \.mapboxgl-ctrl-bottom-left,\s*\.thalassa-chart-map \.mapboxgl-ctrl-bottom-right \{\s*bottom: var\(--thalassa-chart-credits-bottom\);/,
        );
        // …and a real container RULE still states the nav + inset itself: the
        // bottom-right lift (above the Locate fab), selector and first
        // declaration together, so comment text can never satisfy it.
        expect(css).toMatch(
            /^\.thalassa-chart-map \.mapboxgl-ctrl-bottom-right \{\s*bottom: calc\(4rem \+ \d+px \+ env\(safe-area-inset-bottom\)\);/m,
        );
        // The chart's own bottom-left pill and panel stand clear of the
        // wordmark (container + 10px margin - 4px + 23px = 29px up), through
        // one property everything stacked on the pill reads; the geometry
        // itself is proven in e2e/chart-warning.spec.ts.
        const lift = css.match(
            /:root \{\s*--thalassa-chart-controls-bottom: calc\(var\(--thalassa-chart-credits-bottom\) \+ (\d+)px\);\s*\}/,
        );
        expect(lift, 'layer controls are measured from the credits band').not.toBeNull();
        expect(Number(lift![1])).toBeGreaterThan(29);
        expect(css).toMatch(
            /\.thalassa-chart-controls-pill,\s*\.thalassa-chart-controls-panel \{[^}]*bottom: var\(--thalassa-chart-controls-bottom\);/,
        );
        // The Anchorages chip rides on the same property, a pill (48px) + 8px
        // above it, in the pill's own containing block (not the viewport).
        expect(css).toMatch(
            /\.thalassa-anchorage-chip \{\s*left: max\(12px, env\(safe-area-inset-left\)\);\s*bottom: calc\(var\(--thalassa-chart-controls-bottom\) \+ 48px \+ 8px\);/,
        );
        const chip = read('components/map/AnchorageTonightSheet.tsx');
        expect(chip).toMatch(/className="thalassa-anchorage-chip absolute [^"]*min-h-\[44px\]/);
        expect(chip).not.toMatch(/bottom: 'calc\(8\.5rem/);
        // On a landscape phone the folded pill sits ON the credits row, so it
        // must start right of the wordmark's run (6px + 88px = 94px).
        const shortPill = css.match(
            /@media \(orientation: landscape\) and \(max-height: 500px\) \{\s*\.thalassa-chart-controls-pill \{\s*left: calc\((\d+)px \+ env\(safe-area-inset-left\)\);\s*bottom: var\(--thalassa-chart-credits-bottom\);/,
        );
        expect(shortPill, 'the folded landscape pill rule').not.toBeNull();
        expect(Number(shortPill![1])).toBeGreaterThanOrEqual(104);
        // And the class has to actually be on MapHub's container.
        expect(read('components/map/MapHub.tsx')).toContain('thalassa-chart-map');
    });

    it('gives opened credits a legible ink on their white card', () => {
        // Plain-text credits (Blitzortung.org, Anchorages, Moorings, MPA)
        // inherited the chart's white ink on Mapbox's white card. The CONTAINER
        // carries Mapbox's link ink so they inherit it; the attribution and logo
        // elements stay unnamed.
        const css = read('index.css');
        expect(css).toMatch(
            /^\.thalassa-chart-map \.mapboxgl-ctrl-bottom-right \{\s*color: rgb\(0 0 0 \/ 0\.75\);\s*\}/m,
        );
    });
    it('stacks the chart credits under every surface the skipper opens', () => {
        // The containers keep Mapbox's own z-index: geometry keeps the app's
        // furniture off the wordmark and the ⓘ. A blanket lift put the scale
        // bar over the open layer panel's Hide button and the wordmark through
        // the anchorage sheet's backdrop (2026-09-28).
        const css = read('index.css');
        const joint = css.match(
            /\.thalassa-chart-map \.mapboxgl-ctrl-bottom-left,\s*\.thalassa-chart-map \.mapboxgl-ctrl-bottom-right \{([^}]*)\}/,
        );
        expect(joint, 'the joint credits-band rule').not.toBeNull();
        expect(joint![1]).not.toMatch(/z-index/);
        // Every z-index a credits container gets is conditional on its OPENED
        // credits (Mapbox's own aria-expanded toggle), never a standing lift.
        const stacked = css
            .split('}')
            .filter((block) => /mapboxgl-ctrl-bottom-(left|right)/.test(block) && /z-index/.test(block));
        expect(stacked.length).toBeGreaterThanOrEqual(2);
        for (const block of stacked) {
            expect(block).toContain(".mapboxgl-ctrl-bottom-right:has(button[aria-expanded='true'])");
            expect(block).not.toContain('.mapboxgl-ctrl-bottom-left');
        }
        // …and while a surface the skipper opened is up (the layer panel, a
        // menu, a sheet or dialog, the consensus matrix) the opened credits sit
        // one step under the layer panel's 500.
        const yieldRule = stacked.find((block) => /z-index:\s*499;/.test(block));
        expect(yieldRule, 'opened credits yield to opened surfaces').toBeDefined();
        for (const surface of [
            '.thalassa-chart-controls-panel',
            '.radial-helm-open',
            "[role='menu']",
            "[role='dialog']",
            "[aria-modal='true']",
            "button[aria-label='Close consensus matrix']",
        ])
            expect(yieldRule).toContain(surface);
    });

    it('credits the satellite cloud on the chart’s credits strip whenever it is up', () => {
        // An image source cannot carry a Mapbox attribution, so the credit is
        // ours to show: NOAA/NESDIS and every agency whose satellite is in the
        // mosaic, on the same strip as RainViewer and Copernicus, cut out of the
        // layer menu's scrim (data-map-credit) like every licence credit.
        const imagery = read('components/map/satelliteImagery.ts');
        expect(imagery).toContain(
            "export const SAT_IR_CREDIT = 'NOAA/NESDIS GMGSI: GOES, Meteosat (EUMETSAT), Himawari (JMA)';",
        );
        const credit = read('components/map/SatelliteIrCredit.tsx');
        expect(credit).toContain('{SAT_IR_CREDIT}');
        expect(credit).toContain('data-map-credit');
        expect(credit).toContain('CREDITS_STRIP_POSITION_CLASS');
        const hub = read('components/map/MapHub.tsx');
        const at = hub.indexOf('<SatelliteIrCredit');
        expect(at).toBeGreaterThan(-1);
        expect(hub.slice(at, at + 600)).toContain('creditsStripTop(');
        // The legend says the colours are ours: altered NOAA imagery must not be
        // presented as the unaltered product (NODD terms).
        expect(read('components/map/ObsLayerKey.tsx')).toMatch(/colours added by Thalassa/i);
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
