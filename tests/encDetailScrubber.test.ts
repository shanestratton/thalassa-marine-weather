import { describe, it, expect, beforeEach } from 'vitest';
import { applyChartDetailLevel, isScrubHidden } from '../components/map/encDetailScrubber';
import { ENC_VEC_LAYERS } from '../components/map/encLayerIds';

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
