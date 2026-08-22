/**
 * The storm layer's satellite half and its details card.
 *
 * Both were lost without ever being judged on their merits. The satellite
 * cloud layer was collateral damage when Xweather was decommissioned on cost
 * (58f1d9bd, 2026-04-22), whose commit message promised a NOAA replacement
 * "next session" that never shipped — squall returned precip-only three days
 * later and stayed that way for four months. The details card was removed
 * purely as declutter (b418d518, 2026-04-15: "less clutter on the chart"),
 * its builders left as dead code until a July sweep deleted 391 lines of
 * them. Nobody noticed either until Shane asked on 2026-08-21.
 *
 * These assertions are the tripwire: a squall layer that is precip-only, or
 * a cyclone layer whose card builders have been swept again, fails here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const squall = read('components/map/useSquallMap.ts');
const cyclone = read('components/map/useCycloneLayer.ts');

describe('squall keeps its satellite cloud half', () => {
    it('mounts NASA GIBS Himawari IR alongside the precipitation cells', () => {
        expect(squall).toContain('Himawari_AHI_Band13_Clean_Infrared');
        expect(squall).toContain('gibs.earthdata.nasa.gov');
        expect(squall).toContain('squall-ir-layer');
        // The precip layer must still be there — this is a COMPOSITE, and
        // restoring one half by replacing the other would repeat the mistake.
        expect(squall).toContain('squall-rainbow-layer');
    });

    it('caps the IR source at the zoom GIBS actually serves', () => {
        // GoogleMapsCompatible_Level6 stops at z6 while the precip layer runs
        // to z8; without the cap every tile past z6 would 404.
        expect(squall).toContain('GIBS_MAX_ZOOM = 6');
        expect(squall).toContain('maxzoom: GIBS_MAX_ZOOM');
    });

    it('lets either half fail without taking the other down', () => {
        // BOTH directions matter, and only one was handled when this was
        // first restored: the IR mount sat INSIDE mountSquallLayer, which is
        // reached only after the Rainbow snapshot fetch clears five early
        // returns (no Supabase URL, throw, 3 s timeout, non-OK, empty
        // snapshot). Any Rainbow hiccup silently took the clouds with it —
        // which is exactly what Shane saw on 2026-08-21.
        //
        // GIBS needs nothing from Rainbow: no key, no proxy, no snapshot.
        // Self-contained BY SIGNATURE: it takes the map and nothing else, so
        // it cannot be made to depend on the Rainbow snapshot or the Supabase
        // URL without changing this line.
        expect(squall).toContain('function mountSatelliteLayerNow(map: mapboxgl.Map): void {');
        // And its own failure degrades to precip-only rather than throwing
        // out of the mount path.
        const irFn = squall.slice(
            squall.indexOf('function mountSatelliteLayerNow(map'),
            squall.indexOf('/**\n * Add (or replace) the Mapbox raster source'),
        );
        expect(irFn).toContain('catch');
        expect(irFn).toContain('continuing with precip only');
        // …and so does the guarded ENTRY POINT, which is what startLoad calls.
        // The first cut of ensureSatelliteLayer called map.isStyleLoaded()
        // bare as the first statement of startLoad, so a TypeError escaped the
        // effect and took the Rainbow load down with it — this coupling, in
        // the opposite direction, is the thing this spec exists to catch.
        const ensureFn = squall.slice(
            squall.indexOf('function ensureSatelliteLayer('),
            squall.indexOf('function mountSatelliteLayerNow(map'),
        );
        expect(ensureFn).toContain('try {');
        expect(ensureFn).toContain('continuing with precip only');
        expect(ensureFn).toContain("typeof map.isStyleLoaded === 'function'");
        // Mounted before the Rainbow fetch is even attempted.
        const startLoad = squall.slice(squall.indexOf('const startLoad'), squall.indexOf('loadSquallTiles(map'));
        expect(startLoad).toContain('ensureSatelliteLayer(map');
    });

    it('tears both layers down together', () => {
        const cleanup = squall.slice(squall.indexOf('function cleanupLayers'));
        expect(cleanup).toContain('IR_LAYER');
        expect(cleanup).toContain('IR_SOURCE');
    });
});

describe('the cyclone details card exists and is mounted', () => {
    it('keeps every builder the card is made of', () => {
        for (const fn of [
            'buildBadgeData',
            'buildStormBadgeDOM',
            'createStormBadgeStatic',
            'computePressureTrend',
            'computeDevProbability',
            'extractAdvisories',
        ]) {
            expect(cyclone).toContain(fn);
        }
    });

    it('is actually mounted, not just defined', () => {
        // The July sweep deleted the builders precisely BECAUSE nothing
        // called them. A definition with no call site is how this feature
        // died the first time.
        expect(cyclone).toContain('hud.appendChild(createStormBadgeStatic(selectedStorm))');
        expect(cyclone).toContain("hud.id = HUD_ID");
    });

    it('carries the fields a skipper reads off a storm card', () => {
        expect(cyclone).toContain('pressureTrend');
        expect(cyclone).toContain('devProbability');
        expect(cyclone).toContain('advisories');
        expect(cyclone).toContain('nextAdvStr');
        expect(cyclone).toContain('dataAgeStr');
    });

    it('keeps categoryLabels, which only the card uses', () => {
        // Swept in July for being unreferenced once the card went.
        expect(cyclone).toContain('const categoryLabels');
        expect(cyclone).toContain('Category 5 Cyclone');
    });

    it('still runs the data-age ticker the card depends on', () => {
        // This 60 s timer kept running for four months against elements that
        // no longer existed; it is useful again now.
        expect(cyclone).toContain('tickDataAge');
        expect(cyclone).toContain('cyclone-data-age');
    });

    // ── The satellite's THIRD failure mode (2026-08-22) ────────────────
    // "The satellite imagery is still not coming through" — after the mount
    // was decoupled from Rainbow, and after the Pi tile proxy was gated. The
    // tiles were never the problem: the exact URL this builds returns ~76 kB
    // of real Himawari PNG. The clouds were painting and being BURIED, which
    // is the same bug the rain layer hit on 2026-07-23 ("my rain layer does
    // not seem to be working"). Anchoring at the style's first symbol layer
    // was right when imagery sat at the bottom of the stack; the hybrid
    // imagery and the ENC fills now sit far above it.
    //
    // …and that whole line of reasoning was still wrong, twice over. The
    // assertions below replace it (Shane 2026-08-23, third report of "the
    // satellite imagery is still not showing").
    it('gets the cloud\'s alpha from the pixels, because the tile is opaque', () => {
        // MEASURED, not reasoned. The exact URL this builds was fetched on
        // 2026-08-23: HTTP 200, 76 080 B, PNG colour type 6 (RGBA), and
        // alpha == 255 on 100% of sampled pixels, with the clear-sky
        // background sitting at luminance 96-160 of 255.
        //
        // An opaque tile is not an overlay. Under the base imagery it is
        // invisible and over it, it greys out the world — so NO anchor could
        // ever have fixed this, which is why two anchor rounds did nothing.
        const src = readFileSync('components/map/useSquallMap.ts', 'utf8');
        const mount = src.slice(src.indexOf('function mountSatelliteLayer'), src.indexOf('function mountSquallLayer'));
        expect(mount).toContain("'raster-color'");
        expect(mount).toContain("'raster-color-mix'");
        // The precip half of this same file already proved the technique on
        // Rainbow's grayscale dbz — it just was never applied to the cloud.
        expect(src).toContain("'raster-color': SQUALL_COLOR_RAMP");
    });

    it('anchors the cloud above the imagery, and not to a layer that moves', () => {
        const src = readFileSync('components/map/useSquallMap.ts', 'utf8');
        const mount = src.slice(src.indexOf('function mountSatelliteLayer'), src.indexOf('function mountSquallLayer'));
        // The anchor list moved into components/map/imageryOrder.ts so BOTH
        // cloud implementations resolve it identically — assert there, and
        // assert this file defers to it rather than re-deriving one.
        const order = readFileSync('components/map/imageryOrder.ts', 'utf8');
        expect(order).toContain("'satellite-base-layer'");
        expect(order).toContain("'hybrid-base-layer'");
        const anchor = mount.slice(mount.indexOf('const imageryIdx ='), mount.indexOf('map.addLayer('));
        expect(anchor).toContain('cloudOverlayBeforeId(styleLayers)');
        // 'settlement-major-label' looks like a stable high-water mark and is
        // not one: MapHub's ordering pass RELOCATES it to encBottom whenever
        // imagery is lit — which is exactly the configuration Shane runs.
        expect(anchor).not.toContain("'settlement-major-label'");
    });

    it('does NOT keep the IR anchor coupled to the rain layer', () => {
        // The previous round asserted these two must move together. They must
        // not: RainViewer's tiles composite as an overlay, and the GIBS Clean
        // IR tile was measured fully opaque. Coupling them is what carried a
        // fix that worked for rain onto a layer it could not work for.
        //
        // Rain's own anchor still stands and is still asserted — on its own.
        const weather = readFileSync('components/map/useWeatherLayers.ts', 'utf8');
        for (const id of ['settlement-major-label', 'place-city', 'country-label', 'admin-0-boundary']) {
            expect(weather).toContain(`'${id}'`);
        }
    });
});
