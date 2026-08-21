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

    it('never lets a satellite outage take the precipitation with it', () => {
        // The IR mount is wrapped so a GIBS failure degrades to precip-only
        // rather than blanking the storm layer.
        const irBlock = squall.slice(squall.indexOf('Cloud tops FIRST'), squall.indexOf('map.addLayer(\n        {\n            id: SQUALL_LAYER'));
        expect(irBlock).toContain('catch');
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
});
