/**
 * Multi-leg trip chain (Shane 2026-07-17: "we need to get our LEGS
 * functioning") — the pure name helpers plus the localStorage-backed chain
 * operations: retro-badging leg 1 when leg 2 is born, trip-field survival
 * across plain overwrites, and the auto-heal that keeps a successor's locked
 * start welded to its predecessor's arrival.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    ordinalLegLabel,
    stripLegBadge,
    withLegBadge,
    legBadgeOrdinal,
    destNameFromRouteName,
    nextLegSeed,
    retroBadgeFirstLeg,
    healTripChain,
    groupTracesByTrip,
    traceToGpx,
    traceGpxFileName,
    saveTrace,
    loadSavedTraces,
    persistLegVerdicts,
    hydrateLegVerdicts,
} from '../services/routeTracer';

describe('trip-chain name helpers', () => {
    it('ordinalLegLabel speaks English ordinals, teens included', () => {
        expect(ordinalLegLabel(1)).toBe('1st Leg');
        expect(ordinalLegLabel(2)).toBe('2nd Leg');
        expect(ordinalLegLabel(3)).toBe('3rd Leg');
        expect(ordinalLegLabel(4)).toBe('4th Leg');
        expect(ordinalLegLabel(11)).toBe('11th Leg');
        expect(ordinalLegLabel(12)).toBe('12th Leg');
        expect(ordinalLegLabel(13)).toBe('13th Leg');
        expect(ordinalLegLabel(21)).toBe('21st Leg');
        expect(ordinalLegLabel(22)).toBe('22nd Leg');
        expect(ordinalLegLabel(23)).toBe('23rd Leg');
    });

    it('withLegBadge never stacks badges; strip/parse round-trip', () => {
        expect(withLegBadge('newport - woorim', 1)).toBe('newport - woorim (1st Leg)');
        expect(withLegBadge('newport - woorim (1st Leg)', 2)).toBe('newport - woorim (2nd Leg)');
        expect(stripLegBadge('woorim - timbuktu (2nd Leg)')).toBe('woorim - timbuktu');
        expect(legBadgeOrdinal('woorim - timbuktu (2nd Leg)')).toBe(2);
        expect(legBadgeOrdinal('woorim - timbuktu')).toBeNull();
    });

    it('destNameFromRouteName: badge stripped, hyphenated towns survive', () => {
        expect(destNameFromRouteName('newport - woorim')).toBe('woorim');
        expect(destNameFromRouteName('Kippa-Ring - Woorim (1st Leg)')).toBe('Woorim');
        expect(destNameFromRouteName('just a name')).toBeNull();
    });
});

const PTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -27.1, lon: 153.2 },
    { lat: -27.0, lon: 153.3 },
];

describe('trip-chain storage operations', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('nextLegSeed: standalone route seeds leg 2 anchored at its arrival', () => {
        const { trace } = saveTrace('newport - woorim', PTS);
        const seed = nextLegSeed(trace)!;
        expect(seed.tripId).toBe(trace.id); // leg 1's id IS the trip id
        expect(seed.ordinal).toBe(2);
        expect(seed.fromName).toBe('woorim');
        expect(seed.anchor).toEqual(PTS[2]); // the EXACT final coordinates
    });

    it('nextLegSeed: chained leg increments; badge is the fallback ordinal', () => {
        const { trace } = saveTrace('woorim - mooloolaba (2nd Leg)', PTS, {
            tripId: 'trip-a',
            legOrdinal: 2,
            destName: 'mooloolaba',
        });
        expect(nextLegSeed(trace)!.ordinal).toBe(3);
        // Cloud round-trip shed the fields → the name badge still chains.
        const bare = { ...trace, tripId: undefined, legOrdinal: undefined, destName: undefined };
        const seed = nextLegSeed(bare)!;
        expect(seed.ordinal).toBe(3);
        expect(seed.fromName).toBe('mooloolaba');
    });

    it('retro-badge: leg 1 earns "(1st Leg)" + chain fields when the trip becomes real', () => {
        const { trace: leg1 } = saveTrace('newport - woorim', PTS);
        const renamed = retroBadgeFirstLeg(leg1.id)!;
        expect(renamed.name).toBe('newport - woorim (1st Leg)');
        expect(renamed.id).toBe(leg1.id); // same id — cloud upsert updates, not twins
        const stored = loadSavedTraces().find((t) => t.id === leg1.id)!;
        expect(stored.tripId).toBe(leg1.id);
        expect(stored.legOrdinal).toBe(1);
        expect(stored.destName).toBe('woorim');
        // Idempotent — a second call has nothing to do.
        expect(retroBadgeFirstLeg(leg1.id)).toBeNull();
    });

    it('plain overwrite keeps trip fields (a re-save never sheds membership)', () => {
        const { trace } = saveTrace('woorim - timbuktu (2nd Leg)', PTS, {
            tripId: 'trip-a',
            legOrdinal: 2,
            destName: 'timbuktu',
        });
        saveTrace('woorim - timbuktu (2nd Leg)', PTS.slice(0, 2), { overwriteId: trace.id });
        const stored = loadSavedTraces().find((t) => t.id === trace.id)!;
        expect(stored.tripId).toBe('trip-a');
        expect(stored.legOrdinal).toBe(2);
        expect(stored.destName).toBe('timbuktu');
    });

    it('auto-heal: moving leg 1 arrival drags leg 2 locked start with it', () => {
        const { trace: leg1 } = saveTrace('newport - woorim (1st Leg)', PTS, {
            tripId: 'trip-a',
            legOrdinal: 1,
            destName: 'woorim',
        });
        const leg2start = PTS[2];
        saveTrace('woorim - mooloolaba (2nd Leg)', [leg2start, { lat: -26.7, lon: 153.1 }], {
            tripId: 'trip-a',
            legOrdinal: 2,
            destName: 'mooloolaba',
        });
        // Edit leg 1: its arrival moves ~200 m.
        const moved = [...PTS.slice(0, 2), { lat: -27.002, lon: 153.302 }];
        const { trace: leg1b } = saveTrace(leg1.name, moved, { overwriteId: leg1.id });
        const msg = healTripChain(leg1b)!;
        expect(msg).toContain('start moved to match');
        const leg2 = loadSavedTraces().find((t) => t.legOrdinal === 2 && t.tripId === 'trip-a')!;
        expect(leg2.points[0]).toEqual({ lat: -27.002, lon: 153.302 }); // welded
        expect(leg2.points[1]).toEqual({ lat: -26.7, lon: 153.1 }); // rest untouched
        // Already welded → nothing to heal.
        expect(healTripChain(leg1b)).toBeNull();
    });

    it('auto-heal is a no-op for standalone routes and chain tails', () => {
        const { trace } = saveTrace('newport - woorim', PTS);
        expect(healTripChain(trace)).toBeNull(); // no tripId
        const { trace: tail } = saveTrace('woorim - end (2nd Leg)', PTS, { tripId: 'trip-b', legOrdinal: 2 });
        expect(healTripChain(tail)).toBeNull(); // no successor
    });
});

describe('leg-verdict persistence (remount cold-cache fix, 2026-07-17)', () => {
    const verdict = {
        grade: 'clear' as const,
        issues: [],
        minDepthM: 8,
        minAt: null,
        needsTide: false,
        nudge: null,
        nudgeTo: null,
    };
    beforeEach(() => localStorage.clear());

    it('round-trips when keel + chart library match', () => {
        const cache = new Map([['a|b', verdict]]);
        persistLegVerdicts(cache, 2.4, false, 7);
        const back = hydrateLegVerdicts(2.4, false, 7)!;
        expect(back.get('a|b')?.grade).toBe('clear');
        expect(back.get('a|b')?.minDepthM).toBe(8);
    });

    it('a different keel, honesty flag, or chart version drops the lot', () => {
        persistLegVerdicts(new Map([['a|b', verdict]]), 2.4, false, 7);
        expect(hydrateLegVerdicts(2.6, false, 7)).toBeNull(); // draft changed
        expect(hydrateLegVerdicts(2.4, true, 7)).toBeNull(); // assumed flipped
        expect(hydrateLegVerdicts(2.4, false, 8)).toBeNull(); // chart installed
        expect(hydrateLegVerdicts(2.4, false, 7)).not.toBeNull(); // unchanged → survives
    });

    it('caps at the newest 500 entries and survives garbage', () => {
        const big = new Map(Array.from({ length: 620 }, (_, i) => [`k${i}`, verdict] as const));
        persistLegVerdicts(big, 2.4, false, 7);
        const back = hydrateLegVerdicts(2.4, false, 7)!;
        expect(back.size).toBe(500);
        expect(back.has('k619')).toBe(true); // newest kept
        expect(back.has('k0')).toBe(false); // oldest culled
        localStorage.setItem('thalassa_leg_verdicts_v1', '{corrupt');
        expect(hydrateLegVerdicts(2.4, false, 7)).toBeNull();
    });
});

describe('groupTracesByTrip (shared by PLAN Trip box + card list)', () => {
    beforeEach(() => localStorage.clear());

    it('groups legs of one trip, ordinal-sorted, standalone routes stay singletons', () => {
        saveTrace('newport - woorim (1st Leg)', PTS, { tripId: 'trip-a', legOrdinal: 1 });
        saveTrace('woorim - mooloolaba (2nd Leg)', PTS, { tripId: 'trip-a', legOrdinal: 2 });
        const { trace: solo } = saveTrace('bay run', PTS);
        // Feed newest-first (like loadSavedTraces returns) and out of leg order.
        const groups = groupTracesByTrip([...loadSavedTraces()]);
        const trip = groups.find((g) => g.key === 'trip-a')!;
        expect(trip.legs.map((l) => l.legOrdinal)).toEqual([1, 2]); // ordinal-sorted
        expect(trip.label).toContain('2 legs');
        const standalone = groups.find((g) => g.key === solo.id)!;
        expect(standalone.legs).toHaveLength(1);
        expect(standalone.label).toBe('bay run');
    });

    it('badge-only legs (cloud shed the fields) still group + sort by name badge', () => {
        const a = { id: 'x1', name: 'a - b (1st Leg)', createdAt: '', points: PTS, tripId: 'x1' };
        const b = { id: 'x2', name: 'b - c (2nd Leg)', createdAt: '', points: PTS, tripId: 'x1' };
        // legOrdinal absent → falls back to the name badge ordinal.
        const groups = groupTracesByTrip([b, a] as never);
        expect(groups).toHaveLength(1);
        expect(groups[0].legs.map((l) => l.name)).toEqual(['a - b (1st Leg)', 'b - c (2nd Leg)']);
    });
});

describe('traceToGpx — chartplotter export', () => {
    const pts = [
        { lat: -27.2, lon: 153.1 },
        { lat: -27.15, lon: 153.18 },
        { lat: -27.1, lon: 153.25 },
    ];

    it('emits a GPX 1.1 <rte> with one <rtept> per pin, 6-dp coords', () => {
        const gpx = traceToGpx('Newport - Woorim', pts, '2026-07-17T00:00:00.000Z');
        expect(gpx).toContain('<gpx version="1.1"');
        expect(gpx).toContain('http://www.topografix.com/GPX/1/1');
        expect(gpx).toContain('<rte>');
        expect((gpx.match(/<rtept /g) || []).length).toBe(3);
        expect(gpx).toContain('lat="-27.200000" lon="153.100000"');
        expect(gpx).toContain('<name>WP-01</name>');
        expect(gpx).toContain('<name>WP-03</name>');
    });

    it('escapes XML in the route name and falls back when blank', () => {
        expect(traceToGpx('A & B <test>', pts, 'T')).toContain('<name>A &amp; B &lt;test&gt;</name>');
        expect(traceToGpx('   ', pts, 'T')).toContain('<name>Thalassa route</name>');
    });

    it('traceGpxFileName is filesystem-safe', () => {
        expect(traceGpxFileName('Newport - Woorim (2nd Leg)')).toBe('Newport-Woorim-2nd-Leg.gpx');
        expect(traceGpxFileName('  ')).toBe('thalassa-route.gpx');
    });
});
