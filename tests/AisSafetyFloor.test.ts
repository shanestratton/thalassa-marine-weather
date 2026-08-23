/**
 * Two live bugs, both found on 2026-08-23 while designing the crowd-feed and
 * both entirely independent of it. They share one fix because they are the
 * same mistake from opposite ends: the pond query's width was treated as a
 * pure function of what the chart happened to be showing.
 *
 * BUG 1 — the collision guard was filled from chart zoom.
 *   The guard's ONLY internet input is publishInternetAisFeatures(merged),
 *   the result of this query, and it has exactly one production call site.
 *   AisGuardZone.clampRadius permits rings out to 50 NM. So a skipper with a
 *   40 NM ring who zoomed in to their berth was running that guard off a 5 NM
 *   query — a narrowed lookout, caused by a browsing gesture.
 *
 * BUG 2 — below zoom 6 the pond returned nothing at all.
 *   The ladder's widest step is 200 NM. vessels-nearby parses radius with
 *   parseBoundedNumber(v, 0.5, 100), which returns NULL out of range instead
 *   of clamping, so the edge function answered 400 and fetchAndMerge
 *   swallowed it as a log.warn. Zoomed out to plan a passage, the internet
 *   fill was empty every time, with nothing on screen to say so.
 *
 * The governing principle, which is what these tests actually pin:
 * a contribution rule or a browsing gesture may shape what we ask for;
 * neither may ever shrink the lookout.
 */
import { describe, expect, it } from 'vitest';
import { POND_MAX_RADIUS_NM, pondRequestRadiusNm } from '../components/map/useAisStreamLayer';

describe('pond request radius', () => {
    it('never asks for more than the edge function will accept', () => {
        // The 400-on-out-of-range case. z5 used to send 200 and get nothing.
        expect(pondRequestRadiusNm(5, null)).toBeLessThanOrEqual(POND_MAX_RADIUS_NM);
        expect(pondRequestRadiusNm(0, null)).toBeLessThanOrEqual(POND_MAX_RADIUS_NM);
        expect(pondRequestRadiusNm(-3, 50)).toBeLessThanOrEqual(POND_MAX_RADIUS_NM);
        // ...and still asks for something. An over-eager clamp that returned 0
        // would trade a silent 400 for a silently empty circle.
        expect(pondRequestRadiusNm(5, null)).toBeGreaterThan(0);
    });

    it('lets an armed guard ring widen a zoomed-in query', () => {
        // The berth case: chart at z14 wants 5 NM, the ring is 40 NM.
        expect(pondRequestRadiusNm(14, 40)).toBe(40);
        // The guard's maximum, at the tightest zoom.
        expect(pondRequestRadiusNm(14, 50)).toBe(50);
    });

    it('never lets a guard ring NARROW a wide browse', () => {
        // The floor is a floor, not an override. A 2 NM ring must not shrink
        // a z8 chart's 50 NM query — the skipper is looking at the passage.
        expect(pondRequestRadiusNm(8, 2)).toBe(50);
        expect(pondRequestRadiusNm(6, 10)).toBe(100);
    });

    it('ignores a disarmed or nonsense ring rather than trusting it', () => {
        // Callers pass null when the guard is off; localStorage can yield junk.
        expect(pondRequestRadiusNm(12, null)).toBe(10);
        expect(pondRequestRadiusNm(12, 0)).toBe(10);
        expect(pondRequestRadiusNm(12, Number.NaN)).toBe(10);
        expect(pondRequestRadiusNm(12, -5)).toBe(10);
        expect(pondRequestRadiusNm(12, Number.POSITIVE_INFINITY)).toBe(10);
    });

    it('leaves ordinary browsing exactly as it was', () => {
        // Every ladder step at or under the server bound is untouched, so this
        // fix cannot have changed the common case.
        expect(pondRequestRadiusNm(14, null)).toBe(5);
        expect(pondRequestRadiusNm(12, null)).toBe(10);
        expect(pondRequestRadiusNm(10, null)).toBe(25);
        expect(pondRequestRadiusNm(8, null)).toBe(50);
        expect(pondRequestRadiusNm(6, null)).toBe(100);
    });

    it('keeps the guard whole at every zoom the skipper can reach', () => {
        // The invariant, swept rather than spot-checked: with a ring armed,
        // the query is never narrower than the ring at ANY zoom.
        for (const ring of [0.1, 2, 5, 12, 25, 40, 50]) {
            for (let zoom = 0; zoom <= 22; zoom += 0.5) {
                expect(pondRequestRadiusNm(zoom, ring)).toBeGreaterThanOrEqual(ring);
            }
        }
    });
});
