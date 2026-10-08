/**
 * S-57 class-registry coverage — the guard the mission audit asked for
 * (#2a). The ~18-class mark set is mirrored across unlinked sites (layer
 * ids, the z-order list, the fat-finger point set, popup dispatch, the
 * merge). Miss one when adding a class and it renders/taps as nothing,
 * SILENTLY. These tests make that a loud failure: every canonical class
 * must have a layer id, a z-order slot, and a real popup branch.
 */
import { describe, it, expect } from 'vitest';

import {
    ALL_LAYER_IDS,
    ENC_VEC_LAYERS,
    encMarkLayerId,
    S57_BUOY_BEACON_CLASSES,
    S57_HAZARD_POINT_CLASSES,
    S57_NAVAID_CLASSES,
    S57_POINT_MARK_CLASSES,
} from '../../components/map/encLayerIds';
import { buildFeaturePopupHtml } from '../../components/map/encPopup';

/** The rendered popup title, or '' if none. The generic fallback is
 *  'Feature' — a class with no dispatch branch lands there. */
const titleOf = (html: string): string => html.match(/enc-popup-title[^>]*>([^<]*)</)?.[1] ?? '';

describe('S-57 point-mark class registry', () => {
    it.each(S57_POINT_MARK_CLASSES)('%s: layer id + z-order slot + popup branch all present', (cls) => {
        const layerId = encMarkLayerId(cls);
        expect(layerId, `${cls} has no render layer`).toBeTruthy();
        expect([...ALL_LAYER_IDS], `${cls} layer absent from ALL_LAYER_IDS z-order → renders nowhere`).toContain(
            layerId,
        );
        // The merge tags every point with its class (_kind); the one hazard
        // layer's popup answers by it.
        const title = titleOf(buildFeaturePopupHtml(layerId, { _kind: cls }));
        expect(title, `${cls} has no popup branch → falls through to the generic "Feature" popup`).not.toBe('Feature');
        expect(title).not.toBe('');
    });

    it('every navaid class owns a DISTINCT layer id (no accidental alias)', () => {
        const ids = S57_NAVAID_CLASSES.map((c) => encMarkLayerId(c));
        expect(new Set(ids).size).toBe(S57_NAVAID_CLASSES.length);
        expect(ids).not.toContain(ENC_VEC_LAYERS.HAZARDS);
    });

    it('the hazard classes share ONE layer on purpose (shallowest wins across classes) and the popup still tells them apart', () => {
        // build 125, 125-04: a sort key orders one layer only, so one layer is
        // what lets a 0.5 m wreck beat a 15 m rock (tests/enc/encOneHazardLayer).
        expect(new Set(S57_HAZARD_POINT_CLASSES.map((c) => encMarkLayerId(c)))).toEqual(
            new Set([ENC_VEC_LAYERS.HAZARDS]),
        );
        const titles = S57_HAZARD_POINT_CLASSES.map((c) =>
            titleOf(buildFeaturePopupHtml(ENC_VEC_LAYERS.HAZARDS, { _kind: c })),
        );
        expect(titles).toEqual(['Obstruction', 'Wreck', 'Underwater rock']);
    });

    it('an unknown layer id falls through to the generic popup (sanity for the guard)', () => {
        expect(titleOf(buildFeaturePopupHtml('enc-vec-not-a-real-layer', {}))).toBe('Feature');
    });

    it('the light-sector arc is tappable with its own popup (guards #3a)', () => {
        expect(titleOf(buildFeaturePopupHtml(ENC_VEC_LAYERS.LIGHTSEC_ARC, {}))).toBe('Light sector');
    });
});

describe('S-57 class subgroup PARTITION (the full-bind guard)', () => {
    // The merge (tagAndPush) + mount (buildMergedPoints/Navaids,
    // navaidSymbolLayer) all DERIVE from these subgroups, so a class that
    // isn't in one of them never merges/mounts/_kind-tags — the exact
    // silent-no-op the earlier half-bound registry still allowed.

    it('hazard-points ∪ navaids EXACTLY partition the point-mark classes', () => {
        const union = [...S57_HAZARD_POINT_CLASSES, ...S57_NAVAID_CLASSES];
        // covers (no class left out of a merge/mount subgroup)…
        expect([...union].sort()).toEqual([...S57_POINT_MARK_CLASSES].sort());
        // …and disjoint (no class double-sourced).
        expect(new Set(union).size).toBe(union.length);
    });

    it('every point-mark class belongs to EXACTLY one merge/mount subgroup', () => {
        for (const cls of S57_POINT_MARK_CLASSES) {
            const inHazard = (S57_HAZARD_POINT_CLASSES as readonly string[]).includes(cls);
            const inNavaid = (S57_NAVAID_CLASSES as readonly string[]).includes(cls);
            expect(inHazard !== inNavaid, `${cls} must be in exactly one of hazard-points / navaids`).toBe(true);
        }
    });

    it('buoy/beacon symbol classes = navaids minus LIGHTS (the lighthouse layer)', () => {
        const expected = S57_NAVAID_CLASSES.filter((c) => c !== 'LIGHTS');
        expect([...S57_BUOY_BEACON_CLASSES].sort()).toEqual([...expected].sort());
    });

    it('every subgroup class also has a render layer id (merge/mount can address it)', () => {
        for (const cls of [...S57_HAZARD_POINT_CLASSES, ...S57_NAVAID_CLASSES]) {
            expect(encMarkLayerId(cls), `${cls} has no render layer`).toBeTruthy();
        }
    });
});
