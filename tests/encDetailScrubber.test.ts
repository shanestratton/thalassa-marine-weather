import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyChartDetailLevel,
    browseDetailLevel,
    isScrubHidden,
    BROWSE_DECLUTTER_FLOOR,
    DETAIL_SCRUB_MAX,
    S52_STANDARD_NAVAID_LAYERS,
} from '../components/map/encDetailScrubber';
import { SCAMIN_CLAUSE } from '../components/map/encDepthStyle';
import { ENC_VEC_LAYERS, S57_NAVAID_CLASSES } from '../components/map/encLayerIds';

/**
 * The scrubber's restore side must yield to the stronger visibility owners
 * (ENC master toggle, imagery hide-list). Before the 2026-07-15 audit fix,
 * with Hybrid the default base, the imagery block hid LNDARE_ISLET while the
 * scrubber force-showed it every apply pass — two opposing writes that never
 * converged, an ~8 Hz background styledata loop with zero user action.
 */

/** Minimal Mapbox map stub: every ENC layer exists; visibility is a Map. */
function makeMap(initial: Record<string, string> = {}) {
    const vis = new Map<string, string>();
    const filters = new Map<string, unknown>();
    const writes: string[] = [];
    return {
        writes,
        getLayer: (id: string) => (id.startsWith('enc-vec-') ? { id } : undefined),
        getLayoutProperty: (id: string, _p: string) => vis.get(id) ?? initial[id] ?? 'visible',
        setLayoutProperty: (id: string, _p: string, v: string) => {
            vis.set(id, v);
            writes.push(`${id}=${v}`);
        },
        getFilter: (id: string) => filters.get(id) ?? null,
        setFilter: (id: string, f: unknown) => {
            filters.set(id, f);
            writes.push(`${id}#filter`);
        },
        _vis: (id: string) => vis.get(id) ?? initial[id] ?? 'visible',
    } as never as import('mapbox-gl').Map & { writes: string[]; _vis: (id: string) => string };
}

describe('applyChartDetailLevel — ownership-aware restore side', () => {
    beforeEach(() => {
        // Reset the module-level activeDeclutter between cases.
        applyChartDetailLevel(makeMap(), 0);
    });

    it('does NOT restore LNDARE_ISLET when imagery owns it (no default-config loop)', () => {
        // Imagery has already hidden the islet dot; declutter is 0.
        const own = { imageryHidden: new Set([ENC_VEC_LAYERS.LNDARE_ISLET]) };
        const map = makeMap({ [ENC_VEC_LAYERS.LNDARE_ISLET]: 'none' });
        applyChartDetailLevel(map, 0, own); // first pass: filters land once
        map.writes.length = 0;
        // SECOND pass = steady state: must be totally silent, else the
        // styledata coalescer reschedules forever (the ~8 Hz loop).
        const changed = applyChartDetailLevel(map, 0, own);
        expect(map._vis(ENC_VEC_LAYERS.LNDARE_ISLET)).toBe('none');
        expect(map.writes).toHaveLength(0);
        expect(changed).toBe(false);
    });

    it('DOES restore LNDARE_ISLET at declutter 0 when imagery is off', () => {
        const map = makeMap({ [ENC_VEC_LAYERS.LNDARE_ISLET]: 'none' });
        applyChartDetailLevel(map, 0, {}); // imagery off, master on
        expect(map._vis(ENC_VEC_LAYERS.LNDARE_ISLET)).toBe('visible');
    });

    it('still HIDES LNDARE_ISLET at declutter ≥ 3 even while imagery owns it', () => {
        const map = makeMap({ [ENC_VEC_LAYERS.LNDARE_ISLET]: 'visible' });
        applyChartDetailLevel(map, 3, { imageryHidden: new Set([ENC_VEC_LAYERS.LNDARE_ISLET]) });
        // Scrubber only ever hides further — the imagery yield is restore-only.
        expect(map._vis(ENC_VEC_LAYERS.LNDARE_ISLET)).toBe('none');
    });

    it('restores NOTHING when the ENC master toggle is off', () => {
        // Master hid everything; declutter 0 would normally show all furniture.
        const map = makeMap({
            [ENC_VEC_LAYERS.LIGHTS]: 'none',
            [ENC_VEC_LAYERS.BOYLAT]: 'none',
            [ENC_VEC_LAYERS.RECTRC]: 'none',
        });
        applyChartDetailLevel(map, 0, { encMasterOff: true });
        map.writes.length = 0;
        const changed = applyChartDetailLevel(map, 0, { encMasterOff: true });
        expect(map._vis(ENC_VEC_LAYERS.LIGHTS)).toBe('none');
        expect(map._vis(ENC_VEC_LAYERS.BOYLAT)).toBe('none');
        expect(map._vis(ENC_VEC_LAYERS.RECTRC)).toBe('none');
        // No visibility write to any master-hidden furniture on steady state.
        expect(map.writes).toHaveLength(0);
        expect(changed).toBe(false);
    });

    it('isScrubHidden still reports the cut furniture correctly', () => {
        applyChartDetailLevel(makeMap(), 3, {});
        expect(isScrubHidden(ENC_VEC_LAYERS.LNDARE_ISLET)).toBe(true); // group 3 (d≥3)
        expect(isScrubHidden(ENC_VEC_LAYERS.LIGHTS)).toBe(false); // group 6 (d≥6)
    });
});

describe('applyChartDetailLevel — isolated-danger marks are never cut (closing audit 2026-07-18)', () => {
    beforeEach(() => {
        applyChartDetailLevel(makeMap(), 0);
    });

    it('BOYISD/BCNISD stay visible even at MAX declutter, unlike the laterals they outrank', () => {
        const map = makeMap();
        applyChartDetailLevel(map, DETAIL_SCRUB_MAX, {});
        // Isolated-danger marks point AT a charted hazard — safety floor, never cut.
        expect(map._vis(ENC_VEC_LAYERS.BOYISD)).toBe('visible');
        expect(map._vis(ENC_VEC_LAYERS.BCNISD)).toBe('visible');
        // The laterals/cardinals they outrank ARE cut at the bare level.
        expect(map._vis(ENC_VEC_LAYERS.BOYLAT)).toBe('none');
        expect(map._vis(ENC_VEC_LAYERS.BOYCAR)).toBe('none');
    });

    it('isScrubHidden never reports BOYISD/BCNISD hidden at any declutter level', () => {
        for (const d of [3, 4, 5, DETAIL_SCRUB_MAX]) {
            applyChartDetailLevel(makeMap(), d, {});
            expect(isScrubHidden(ENC_VEC_LAYERS.BOYISD)).toBe(false);
            expect(isScrubHidden(ENC_VEC_LAYERS.BCNISD)).toBe(false);
        }
        // Control, FLIPPED by W1-01 (build 123): the special-purpose marks
        // they were once grouped with are no longer cut at d ≥ 3. They are
        // S-52 Standard display aids to navigation, so they now go only at
        // the bare level, with the laterals.
        applyChartDetailLevel(makeMap(), 3, {});
        expect(isScrubHidden(ENC_VEC_LAYERS.BOYSPP)).toBe(false);
        expect(isScrubHidden(ENC_VEC_LAYERS.BCNSPP)).toBe(false);
        applyChartDetailLevel(makeMap(), DETAIL_SCRUB_MAX, {});
        expect(isScrubHidden(ENC_VEC_LAYERS.BOYSPP)).toBe(true);
        expect(isScrubHidden(ENC_VEC_LAYERS.BCNSPP)).toBe(true);
    });
});

/**
 * W1-01 (build 123, must-do #1, gap browse-chart-enc-detail): the browsing
 * chart's forced declutter floor hid ENC light sectors (cut at d ≥ 1) and
 * the special-purpose and safe-water marks (cut at d ≥ 3), so they never
 * showed on Obs at all. IHO S-52, the standard every ECDIS draws to, puts
 * aids to navigation (buoys, beacons, lights and the sectors a light
 * carries) in Standard display. The floor now leaves every one of them up;
 * soundings density, names, badges and derived contours stay thinned.
 *
 * The list below is written out by hand on purpose: it is the oracle, not
 * the module's own export read back.
 */
const NAVAIDS_BY_HAND = [
    ENC_VEC_LAYERS.LIGHTS,
    ENC_VEC_LAYERS.LIGHTSEC_LEG,
    ENC_VEC_LAYERS.LIGHTSEC_ARC,
    ENC_VEC_LAYERS.BOYLAT,
    ENC_VEC_LAYERS.BCNLAT,
    ENC_VEC_LAYERS.BOYCAR,
    ENC_VEC_LAYERS.BCNCAR,
    ENC_VEC_LAYERS.BOYSAW,
    ENC_VEC_LAYERS.BCNSAW,
    ENC_VEC_LAYERS.BOYSPP,
    ENC_VEC_LAYERS.BCNSPP,
    ENC_VEC_LAYERS.BOYISD,
    ENC_VEC_LAYERS.BCNISD,
];
/** The navaids the bare level may still cut: all but the isolated-danger pair. */
const CUT_AT_BARE = NAVAIDS_BY_HAND.filter((id) => id !== ENC_VEC_LAYERS.BOYISD && id !== ENC_VEC_LAYERS.BCNISD);
/** Never written by the scrubber at any level (the safety floor). */
const SAFETY_FLOOR = [
    ENC_VEC_LAYERS.DEPARE,
    ENC_VEC_LAYERS.DEPARE_GLAZE,
    ENC_VEC_LAYERS.LNDARE,
    ENC_VEC_LAYERS.COALNE,
    ENC_VEC_LAYERS.DEPCNT_SAFETY,
    // Every wreck, rock and obstruction: one layer since build 125 (125-04).
    ENC_VEC_LAYERS.HAZARDS,
    ENC_VEC_LAYERS.BOYISD,
    ENC_VEC_LAYERS.BCNISD,
];

describe('W1-01: the browse floor keeps every S-52 Standard display navaid', () => {
    beforeEach(() => {
        applyChartDetailLevel(makeMap(), 0);
    });

    it('keeps the floor at 3 and names the navaid layers it protects', () => {
        expect(BROWSE_DECLUTTER_FLOOR).toBe(3);
        // Every navaid class the chart mounts, plus the two light-sector
        // layers drawn from LIGHTS. Derived from the class registry, so a
        // navaid class added later is protected without another edit.
        const fromRegistry = [
            ...S57_NAVAID_CLASSES.map((c) => ENC_VEC_LAYERS[c]),
            ENC_VEC_LAYERS.LIGHTSEC_LEG,
            ENC_VEC_LAYERS.LIGHTSEC_ARC,
        ];
        expect([...S52_STANDARD_NAVAID_LAYERS].sort()).toEqual([...fromRegistry].sort());
        for (const id of NAVAIDS_BY_HAND) expect(S52_STANDARD_NAVAID_LAYERS, id).toContain(id);
        // Light characteristics text is lettering, not a mark: still thinned.
        expect(S52_STANDARD_NAVAID_LAYERS).not.toContain(ENC_VEC_LAYERS.NAVAIDS_LABEL);
    });

    it('at d = 3 every navaid is visible and isScrubHidden says so for each', () => {
        const map = makeMap();
        applyChartDetailLevel(map, 3, {});
        for (const id of NAVAIDS_BY_HAND) {
            expect(map._vis(id), id).toBe('visible');
            expect(isScrubHidden(id), id).toBe(false);
        }
        // The floor still thins what Shane asked it to (2026-07-22).
        for (const id of [
            ENC_VEC_LAYERS.DEPCNT_DERIVED_LINE,
            ENC_VEC_LAYERS.DEPCNT_DERIVED_LABEL,
            ENC_VEC_LAYERS.VHF_BADGE,
            ENC_VEC_LAYERS.VHF_BADGE_VTS,
            ENC_VEC_LAYERS.RECTRC_LABEL,
            ENC_VEC_LAYERS.POINTS_LABEL,
            ENC_VEC_LAYERS.LNDARE_ISLET,
        ]) {
            expect(map._vis(id), id).toBe('none');
            expect(isScrubHidden(id), id).toBe(true);
        }
    });

    it('no navaid sits in any tier the floor reaches (d = 0 … floor)', () => {
        for (let d = 0; d <= 3; d++) {
            const map = makeMap();
            applyChartDetailLevel(map, d, {});
            for (const id of NAVAIDS_BY_HAND) {
                expect(map._vis(id), `${id} at d=${d}`).toBe('visible');
                expect(isScrubHidden(id), `${id} at d=${d}`).toBe(false);
            }
        }
    });

    it('cuts the sectors and the special-purpose and safe-water marks together with the laterals, at d = 6 only', () => {
        const five = makeMap();
        applyChartDetailLevel(five, 5, {});
        for (const id of NAVAIDS_BY_HAND) expect(five._vis(id), `${id} at d=5`).toBe('visible');
        const bare = makeMap();
        applyChartDetailLevel(bare, DETAIL_SCRUB_MAX, {});
        expect(DETAIL_SCRUB_MAX).toBe(6);
        for (const id of CUT_AT_BARE) {
            expect(bare._vis(id), `${id} at d=6`).toBe('none');
            expect(isScrubHidden(id), `${id} at d=6`).toBe(true);
        }
    });

    it('never cuts BOYISD/BCNISD and never writes any safety-floor layer, at any level', () => {
        for (let d = 0; d <= DETAIL_SCRUB_MAX; d++) {
            const map = makeMap();
            applyChartDetailLevel(map, d, {});
            for (const id of SAFETY_FLOOR) {
                expect(
                    map.writes.filter((w) => w.startsWith(`${id}=`)),
                    `${id} at d=${d}`,
                ).toEqual([]);
                expect(isScrubHidden(id), `${id} at d=${d}`).toBe(false);
            }
        }
    });

    it('is silent on the second pass at the floor and at the bare level', () => {
        for (const d of [3, DETAIL_SCRUB_MAX]) {
            const map = makeMap();
            applyChartDetailLevel(map, d, {});
            map.writes.length = 0;
            expect(applyChartDetailLevel(map, d, {}), `d=${d}`).toBe(false);
            expect(map.writes, `d=${d}`).toHaveLength(0);
        }
    });

    it('keeps the SCAMIN sounding bias at -0.9 virtual zoom per step', () => {
        const zero = makeMap();
        applyChartDetailLevel(zero, 0, {});
        expect(zero.getFilter(ENC_VEC_LAYERS.SOUNDG)).toEqual(SCAMIN_CLAUSE);
        const floor = makeMap();
        applyChartDetailLevel(floor, 3, {});
        expect(floor.getFilter(ENC_VEC_LAYERS.SOUNDG)).toEqual([
            'any',
            ['!', ['has', '_minZoom']],
            ['>=', ['+', ['zoom'], 3 * -0.9], ['get', '_minZoom']],
        ]);
    });

    it('still yields on the restore side: master off restores no navaid at the floor', () => {
        const hidden = Object.fromEntries(NAVAIDS_BY_HAND.map((id) => [id, 'none']));
        const map = makeMap(hidden);
        applyChartDetailLevel(map, 3, { encMasterOff: true });
        for (const id of NAVAIDS_BY_HAND) expect(map._vis(id), id).toBe('none');
        expect(map.writes.filter((w) => w.endsWith('=visible'))).toEqual([]);
    });

    it('leaves HIDE_ONLY contours to their owner on the restore side', () => {
        const map = makeMap({ [ENC_VEC_LAYERS.DEPCNT_LINE]: 'none', [ENC_VEC_LAYERS.DEPCNT_LABEL]: 'none' });
        applyChartDetailLevel(map, 0, {});
        expect(map._vis(ENC_VEC_LAYERS.DEPCNT_LINE)).toBe('none');
        expect(map._vis(ENC_VEC_LAYERS.DEPCNT_LABEL)).toBe('none');
    });
});

describe('W1-01: browsing draws at the floor, whatever plotting left the slider at', () => {
    beforeEach(() => {
        applyChartDetailLevel(makeMap(), 0);
    });

    it('plotting gets exactly the slider; browsing gets the floor at every slider value', () => {
        for (let slider = 0; slider <= DETAIL_SCRUB_MAX; slider++) {
            expect(browseDetailLevel(true, slider), `plotting, slider ${slider}`).toBe(slider);
            expect(browseDetailLevel(false, slider), `browsing, slider ${slider}`).toBe(3);
        }
    });

    it('a plotting "Clean" (6) does not follow the skipper back to Obs', () => {
        // Review scenario: plot a leg with the slider at Clean, tap Done,
        // go back to Obs. Obs and the Plan tab are the same kept-alive map
        // and nothing resets the slider, so the old max(slider, floor) kept
        // every light and buoy hidden on Obs for the rest of the session.
        const map = makeMap();
        applyChartDetailLevel(map, browseDetailLevel(true, DETAIL_SCRUB_MAX), {});
        for (const id of CUT_AT_BARE) expect(map._vis(id), `${id} while plotting at 6`).toBe('none');
        applyChartDetailLevel(map, browseDetailLevel(false, DETAIL_SCRUB_MAX), {});
        for (const id of NAVAIDS_BY_HAND) {
            expect(map._vis(id), `${id} browsing after 6`).toBe('visible');
            expect(isScrubHidden(id), `${id} browsing after 6`).toBe(false);
        }
    });

    it('a plotting 4 or 5 does not leave Obs without leads, names or light characteristics', () => {
        for (const slider of [4, 5]) {
            const map = makeMap();
            applyChartDetailLevel(map, browseDetailLevel(true, slider), {});
            applyChartDetailLevel(map, browseDetailLevel(false, slider), {});
            for (const id of [ENC_VEC_LAYERS.RECTRC, ENC_VEC_LAYERS.NAVAIDS_LABEL, ...NAVAIDS_BY_HAND]) {
                expect(map._vis(id), `${id} browsing after ${slider}`).toBe('visible');
                expect(isScrubHidden(id), `${id} browsing after ${slider}`).toBe(false);
            }
        }
    });
});

describe('W1-01: the browsing chart uses the exported floor', () => {
    const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
    const hubCode = hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('takes its level from browseDetailLevel instead of keeping its own floor', () => {
        expect(hubCode).toMatch(/import \{[^}]*\bbrowseDetailLevel\b[^}]*\} from '\.\/encDetailScrubber';/);
        expect(hubCode).not.toMatch(/const BROWSE_DECLUTTER_FLOOR\s*=/);
        expect(hubCode).toContain('const effectiveDeclutter = browseDetailLevel(coordCaptureMode, declutter);');
        // The slider's leftover value must not reach the browsing chart.
        expect(hubCode).not.toMatch(/Math\.max\(\s*declutter\b/);
    });
});
