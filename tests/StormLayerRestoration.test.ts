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
    it('mounts the world cloud layer alongside the precipitation cells', () => {
        // Was NASA GIBS Himawari Band 13 (2026-08-21 → 2026-08-24). Replaced
        // by the SAME cloud layer the Sky menu serves, so the punter sees one
        // cloud field with one appearance whichever page they are on — and it
        // is a true overlay, which GIBS never was.
        expect(squall).toContain("getTileUrl('clouds')");
        expect(squall).not.toContain('Himawari_AHI_Band13_Clean_Infrared');
        expect(squall).toContain('squall-ir-layer');
        // The precip layer must still be there — this is a COMPOSITE, and
        // restoring one half by replacing the other would repeat the mistake.
        expect(squall).toContain('squall-rainbow-layer');
    });

    it('caps the cloud source at the zoom its provider actually serves', () => {
        // The cap itself is the invariant; the number moved with the source.
        // GIBS stopped at z6 while the precip layer runs to z8, so cloud was
        // the half that stopped sharpening first. OWM's rasters run to z9,
        // which clears precip's ceiling — and the number is read from
        // TILE_SOURCE_MAX_ZOOM rather than restated, so the Sky layer and the
        // storm page cannot drift apart.
        expect(squall).toContain("maxzoom: tileSourceMaxZoom('clouds')");
        expect(squall).not.toContain('GIBS_MAX_ZOOM');
    });

    it('lets either half fail without taking the other down', () => {
        // BOTH directions matter, and only one was handled when this was
        // first restored: the IR mount sat INSIDE mountSquallLayer, which is
        // reached only after the Rainbow snapshot fetch clears five early
        // returns (no Supabase URL, throw, 3 s timeout, non-OK, empty
        // snapshot). Any Rainbow hiccup silently took the clouds with it —
        // which is exactly what Shane saw on 2026-08-21.
        //
        // The cloud layer needs nothing from Rainbow: no snapshot, no proxy.
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
    it('uses a tile that is genuinely an overlay, so no alpha is synthesised', () => {
        // BOTH SIDES MEASURED, and that is the whole point of this test.
        //
        // GIBS Himawari Band 13, fetched 2026-08-23: HTTP 200, 76 080 B, PNG
        // colour type 6 (RGBA), alpha == 255 on 100% of sampled pixels, clear
        // sky at luminance 96-160/255. An opaque tile is not an overlay —
        // under the imagery it is invisible, over it it greys out the world —
        // so no anchor could ever have fixed it, which is why two anchor
        // rounds did nothing and the alpha had to be ramped from brightness.
        //
        // OWM clouds_new, fetched 2026-08-24: HTTP 200, 90 810 B, colour type
        // 6, 35% of sampled pixels at alpha 0 and NOT ONE at 255. Real
        // transparency, so the ramp comes off — keeping it would fight alpha
        // that is already right.
        const src = readFileSync('components/map/useSquallMap.ts', 'utf8');
        const mount = src
            .slice(src.indexOf('function mountSatelliteLayer'), src.indexOf('function mountSquallLayer'))
            .replace(/\/\/[^\n]*/g, '');
        expect(mount).not.toContain("'raster-color'");
        expect(mount).not.toContain("'raster-color-mix'");
        // The PRECIP half still ramps, and must: Rainbow ships grayscale dbz
        // with no meaningful alpha, which is the case the technique is for.
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

describe('the precip half actually gets time to load', () => {
    it('gives the direct snapshot fetch its own budget, armed only when it starts', () => {
        // "the squall layer is not working" (Shane 2026-08-23). The backend was
        // fine — measured that day: the snapshot endpoint returns 200 with
        // {"snapshot":…} and the tile endpoint a real 9.5 kB dbz_u8 PNG.
        //
        // ONE 3 s abort timer was armed BEFORE the Pi attempt and covered both
        // it and the direct fetch. A configured-but-out-of-range Pi burns its
        // whole read timeout first, so the direct fetch was aborted the moment
        // it started; and with no Pi at all the margin was still thin, against
        // an endpoint measured at 0.69-1.76 s warm and 2.3 s on a cold start —
        // on shore broadband, not a marine link.
        const src = readFileSync('components/map/useSquallMap.ts', 'utf8');
        expect(src).toContain('const PI_BUDGET_MS');
        expect(src).toContain('const DIRECT_BUDGET_MS');

        // The timer must be INSIDE the direct-fetch branch, not above the Pi
        // attempt — that placement is the entire bug.
        const load = src.slice(src.indexOf('async function loadSquallTiles'), src.indexOf('mountSquallLayer(map, supabaseUrl'));
        // Match the CODE form, not the prose: the comment above it quotes the
        // old `setTimeout(() => controller.abort(), 3000)` to explain the bug.
        const armAt = load.indexOf('setTimeout(() => controller.abort(), DIRECT_BUDGET_MS)');
        const piAt = load.indexOf('piCache.passthroughJson');
        const directAt = load.indexOf('await fetch(upstream');
        expect(armAt).toBeGreaterThan(piAt);
        expect(armAt).toBeLessThan(directAt);
        expect(load).toContain('DIRECT_BUDGET_MS');
    });

    it('says WHY it gave up, and how long it took', () => {
        // A timeout and a teardown aborted the same controller and logged the
        // same line, which is part of why this needed a bug report to find.
        const src = readFileSync('components/map/useSquallMap.ts', 'utf8');
        expect(src).toContain('view torn down');
        expect(src).toContain('timed out — budget ${DIRECT_BUDGET_MS}ms');
    });
});
