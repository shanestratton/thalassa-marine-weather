import { describe, expect, it } from 'vitest';
import {
    BUDDY_FRESH_MS,
    emptyBuddyState,
    evaluateBuddy,
    parseBuddyConfiguration,
    parseBuddyFacts,
    parseBuddyState,
    buddyEventWords,
    type BuddyFacts,
} from '../utils/buddyWatch';
const now = Date.parse('2026-10-17T07:00:00Z'),
    area = { lat: 0, lon: 179.99, radiusNm: 1, label: 'Chosen circle' };
const fact = (
    at = now,
    sog: number | null = 0,
    navStatus: number | null = 0,
    distanceNm: number | null = 2,
): BuddyFacts => ({ at, sog, navStatus, distanceNm });
const run = (reports: BuddyFacts[], selected: typeof area | null = null) => {
    let state = emptyBuddyState();
    const events = [];
    for (const f of reports) {
        const r = evaluateBuddy(state, f, selected, f.at);
        state = r.state;
        if (r.event) events.push(r.event);
    }
    return { state, events };
};
describe('bounded informational buddy rule', () => {
    it('validates explicit area, real zero coordinates, fixed identity and off configuration', () => {
        const c = { mmsi: 234567890, label: 'Example', enabled: false, area };
        expect(parseBuddyConfiguration(c)).toEqual(c);
        for (const change of [
            { mmsi: 970123456 },
            { mmsi: '234567890' },
            { label: '\nname' },
            { label: 'x'.repeat(61) },
            { area: { ...area, lat: '' } },
            { area: { ...area, radiusNm: 0 } },
            { area: { ...area, radiusNm: 51 } },
            { url: 'https://invalid' },
        ])
            expect(parseBuddyConfiguration({ ...c, ...change })).toBeNull();
    });
    it('rejects bad sentinel/unit values and unknown source fields', () => {
        for (const change of [
            { sog: 102.4 },
            { sog: -1 },
            { sog: '' },
            { at: null },
            { at: 1.2 },
            { navStatus: 16 },
            { distanceNm: -1 },
            { url: 'https://invalid' },
        ])
            expect(parseBuddyFacts({ ...fact(), ...change })).toBeNull();
        expect(parseBuddyFacts(fact(now, null, null, null))).not.toBeNull();
    });
    it('does not notify the first sighting, then requires distinct sustained original reports', () => {
        expect(run([fact(now, 4)]).events).toEqual([]);
        expect(run([fact(), fact(now + 1000, 4), fact(now + 61000, 4)]).events).toEqual([]);
        expect(run([fact(), fact(now + 1000, 4), fact(now + 121000, 4)]).events).toEqual(['moving']);
    });
    it('polling a frozen report never manufactures a duration or clear', () => {
        let r = evaluateBuddy(emptyBuddyState(), fact(), null, now);
        r = evaluateBuddy(r.state, fact(now + 1000, 4), null, now + 1000);
        const before = r.state;
        expect(evaluateBuddy(before, fact(now + 1000, 4), null, now + 121000)).toEqual({ state: before, event: null });
        expect(evaluateBuddy(before, fact(now - 1000, 4), null, now + 121000)).toEqual({ state: before, event: null });
    });
    it('unknown/intermediate speeds interrupt the sustained candidate', () => {
        expect(run([fact(), fact(now + 1000, 4), fact(now + 100000, 1), fact(now + 121000, 4)]).events).toEqual([]);
        expect(run([fact(), fact(now + 1000, 4), fact(now + 100000, null), fact(now + 121000, 4)]).events).toEqual([]);
    });
    it('reports anchored/moored and underway with speed corroboration; inconsistent status is unknown', () => {
        expect(run([fact(now, 4), fact(now + 1000, 0.2, 5), fact(now + 121000, 0.2, 5)]).events).toEqual(['moored']);
        expect(run([fact(now, 0.2, 1), fact(now + 1000, 4, 0), fact(now + 121000, 4, 0)]).events).toEqual(['underway']);
        expect(run([fact(now, 0.2, 1), fact(now + 1000, 4, 5), fact(now + 121000, 4, 5)]).events).toEqual([]);
        expect(buddyEventWords('moored')).toBe('AIS reports anchored or moored');
    });
    it('optional chosen circles have10% hysteresis and two-minute original-report confirmation', () => {
        expect(run([fact(), fact(now + 1000, 0, 0, 0.8), fact(now + 121000, 0, 0, 0.8)], area).events).toEqual([
            'entered',
        ]);
        expect(
            run([fact(now, 0, 0, 0.5), fact(now + 1000, 0, 0, 1.2), fact(now + 121000, 0, 0, 1.2)], area).events,
        ).toEqual(['left']);
        expect(
            run([fact(), fact(now + 1000, 0, 0, 0.8), fact(now + 100000, 0, 0, 1), fact(now + 121000, 0, 0, 0.8)], area)
                .events,
        ).toEqual([]);
        expect(run([fact(), fact(now + 1000, 0, 0, 0.8), fact(now + 121000, 0, 0, 0.8)], null).events).toEqual([]);
    });
    it('unknown distance and stale gaps cannot become port arrival/departure', () => {
        expect(run([fact(), fact(now + 1000, 0, 0, null), fact(now + 121000, 0, 0, 0.5)], area).events).toEqual([]);
        expect(run([fact(), fact(now + BUDDY_FRESH_MS + 1, 0, 0, 0.5)], area).events).toEqual([]);
    });
    it('not-seen is one honest missing-cache notice; no unseen vessel or future source becomes a fact', () => {
        expect(evaluateBuddy(emptyBuddyState(), null, null, now).event).toBeNull();
        const first = run([fact()]).state;
        const missing = evaluateBuddy(first, null, null, now + BUDDY_FRESH_MS + 1);
        expect(missing.event).toBe('not-seen');
        expect(evaluateBuddy(missing.state, null, null, now + BUDDY_FRESH_MS + 2).event).toBeNull();
        expect(evaluateBuddy(first, fact(now + 1), null, now).state.observedAt).toBe(now);
        expect(
            evaluateBuddy(missing.state, fact(now + BUDDY_FRESH_MS + 3, 4), null, now + BUDDY_FRESH_MS + 3).event,
        ).toBeNull();
    });
    it('rejects corrupted state rather than accepting a restamped clock', () => {
        expect(parseBuddyState({ ...emptyBuddyState(), observedAt: null, mode: 'moving' })).toBeNull();
        expect(parseBuddyState({ ...emptyBuddyState(), observedAt: now, candidateSince: now + 1 })).toBeNull();
    });
});
