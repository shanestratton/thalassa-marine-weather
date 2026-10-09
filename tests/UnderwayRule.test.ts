/**
 * The under-way alarms' one rule (build 126, 126-02a): off route (XTE) and
 * shoal water. PURE — no stores, no clock of its own.
 *
 *  - Off route sounds while she follows a route and wanders more than a
 *    quarter mile off the line (a mile offshore: the Ship's Log shore zone,
 *    else an open-water leg). It arms only once she has been on the route,
 *    needs two fresh fixes at least 10 s apart to sound, and clears only
 *    under 80% of the limit held 20 s. Stopped, or with no fresh fix, it
 *    neither sounds nor clears.
 *  - Shoal water is the Instrument Panel's own depth rule (keelOffsetFor, one
 *    function for both): below the keel adds nothing; anything else takes the
 *    draft off. Three live readings under the margin sound; it clears only at
 *    the margin + 0.3 m held 10 s. Stale or dead readings never sound or clear.
 *
 * Fictional boats and routes, worldwide: 'Kestrel' (draft 2.4 m) and
 * 'Albatross' (draft not set) in the Solent, the Bay of Islands, Chesapeake
 * Bay, a Fiji passage across the antimeridian and Isfjorden, Svalbard.
 */
import { describe, expect, it } from 'vitest';
import { keelOffsetFor as instrumentPanelKeelOffset } from '../components/nmea/depthTrend';
import {
    UNDERWAY_DEFAULTS,
    XTE_START,
    SHOAL_START,
    acknowledgeShoal,
    keelOffsetFor,
    measureXte,
    muteXte,
    nextShoalState,
    nextXteState,
    sanitiseUnderwayPrefs,
    shoalAudible,
    shoalDepthFrom,
    shoalLines,
    underKeelM,
    xteAudible,
    xteLimitNm,
    type ShoalObservation,
    type ShoalState,
    type XteState,
} from '../services/underway/underwayRule';
import { underKeelClearanceM } from '../services/underway/underKeelClearance';
import { collisionOwnStill } from '../utils/collisionRule';
import { destinationPoint } from '../utils/navigationCalculations';
import { FEET_PER_METRE, vesselDraftIsAssumed, vesselDraftMetres } from '../services/units';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const S = 1_000;

const OFF_ROUTE = UNDERWAY_DEFAULTS.offRoute;

/** A straight leg from `from`, on `bearing`, `lengthNm` long. */
function leg(from: { lat: number; lon: number }, bearing: number, lengthNm: number) {
    return [from, destinationPoint(from.lat, from.lon, bearing, lengthNm)];
}

/** A point `alongNm` down the first leg and `offNm` to starboard of it. */
function beside(route: { lat: number; lon: number }[], bearing: number, alongNm: number, offNm: number) {
    const abeam = destinationPoint(route[0].lat, route[0].lon, bearing, alongNm);
    return offNm === 0 ? abeam : destinationPoint(abeam.lat, abeam.lon, bearing + 90, offNm);
}

// ── The fixtures ────────────────────────────────────────────────────────────

/** The Solent, 50.7N 1.3W: a 6 NM leg west down the channel. */
const SOLENT = leg({ lat: 50.77, lon: -1.3 }, 255, 6);
/** Chesapeake Bay, 38.9N 76.4W: a 24 NM leg up the bay. */
const CHESAPEAKE = leg({ lat: 38.6, lon: -76.4 }, 0, 24);
/** The Bay of Islands, 35.2S 174.1E: out past the heads to sea, 30 NM. */
const BAY_OF_ISLANDS = leg({ lat: -35.2, lon: 174.1 }, 45, 30);
/** Isfjorden, Svalbard, 78.2N: 37 NM along the parallel. */
const ISFJORDEN = [
    { lat: 78.2, lon: 13 },
    { lat: 78.2, lon: 16 },
];
/** Fiji: a passage across the antimeridian at 179.95E. */
const FIJI = [
    { lat: -17, lon: 179.8 },
    { lat: -17, lon: -179.9 },
];

/** Kestrel's profile: draft 2.4 m, stored in feet as the app stores it. */
const KESTREL = { draft: 2.4 * FEET_PER_METRE };
/** Albatross: the skipper never set the draft. */
const ALBATROSS = {};

function run(
    observations: Array<{ at: number; offNm: number | null; still?: boolean; limitNm?: number }>,
    from: XteState = XTE_START,
) {
    let state = from;
    const trail: XteState[] = [];
    for (const o of observations) {
        state = nextXteState(state, {
            fixAt: o.offNm === null ? null : o.at,
            offTrackNm: o.offNm,
            limitNm: o.limitNm ?? OFF_ROUTE.inshoreNm,
            offshore: false,
            still: o.still ?? false,
        });
        trail.push(state);
    }
    return { state, trail };
}

/** On the route (0.05 NM off), so the latch is set. */
const latched = () => run([{ at: T0, offNm: 0.05 }]).state;

describe('the off-route limit, worldwide', () => {
    it('defaults ON: 0.25 NM inshore, 1 NM offshore', () => {
        expect(UNDERWAY_DEFAULTS).toEqual({
            offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
            shoal: { enabled: true },
        });
        expect(sanitiseUnderwayPrefs(undefined)).toEqual(UNDERWAY_DEFAULTS);
        expect(sanitiseUnderwayPrefs('junk')).toEqual(UNDERWAY_DEFAULTS);
    });

    it('reads saved choices defensively: clamped, switches off only when switched off', () => {
        expect(sanitiseUnderwayPrefs({ offRoute: { enabled: false } }).offRoute.enabled).toBe(false);
        expect(sanitiseUnderwayPrefs({ offRoute: { enabled: 'no' } }).offRoute.enabled).toBe(true);
        expect(sanitiseUnderwayPrefs({ shoal: { enabled: false } }).shoal.enabled).toBe(false);
        expect(sanitiseUnderwayPrefs({ offRoute: { inshoreNm: 0.5, offshoreNm: 2 } }).offRoute).toMatchObject({
            inshoreNm: 0.5,
            offshoreNm: 2,
        });
        const wild = sanitiseUnderwayPrefs({ offRoute: { inshoreNm: 40, offshoreNm: -3 } }).offRoute;
        expect(wild.inshoreNm).toBeLessThanOrEqual(1);
        expect(wild.offshoreNm).toBeGreaterThanOrEqual(0.25);
        expect(sanitiseUnderwayPrefs({ offRoute: { inshoreNm: Number.NaN } }).offRoute.inshoreNm).toBe(0.25);
    });

    it('is the offshore limit when the Ship’s Log puts her offshore, the inshore one when coastal or nearshore', () => {
        const longLeg = { legLengthNm: 24, fromStartNm: 12, toEndNm: 12 };
        expect(xteLimitNm('offshore', null, OFF_ROUTE)).toMatchObject({ limitNm: 1, offshore: true });
        // A known zone near land is never widened by a long leg.
        expect(xteLimitNm('coastal', longLeg, OFF_ROUTE)).toMatchObject({ limitNm: 0.25, offshore: false });
        expect(xteLimitNm('nearshore', longLeg, OFF_ROUTE)).toMatchObject({ limitNm: 0.25, offshore: false });
    });

    it('with no zone, reads an open-water leg as offshore and everything else as inshore', () => {
        // Chesapeake Bay's 24 NM leg, 6 NM along it: 6 NM from both ends.
        const sixAlong = measureXte(CHESAPEAKE, beside(CHESAPEAKE, 0, 6, 0.1))!;
        expect(sixAlong.leg.legLengthNm).toBeCloseTo(24, 1);
        expect(sixAlong.leg.fromStartNm).toBeCloseTo(6, 1);
        expect(sixAlong.leg.toEndNm).toBeCloseTo(18, 1);
        expect(xteLimitNm(null, sixAlong.leg, OFF_ROUTE)).toMatchObject({
            limitNm: 1,
            offshore: true,
            basis: 'open-water-leg',
        });
        // Only 3 NM from an end: inshore.
        const threeAlong = measureXte(CHESAPEAKE, beside(CHESAPEAKE, 0, 3, 0.1))!;
        expect(xteLimitNm(null, threeAlong.leg, OFF_ROUTE)).toMatchObject({ limitNm: 0.25, offshore: false });
        // An 8 NM leg is never open water.
        expect(xteLimitNm(null, { legLengthNm: 8, fromStartNm: 4, toEndNm: 4 }, OFF_ROUTE)).toMatchObject({
            limitNm: 0.25,
            offshore: false,
        });
        // Nothing known at all: inshore.
        expect(xteLimitNm(null, null, OFF_ROUTE)).toMatchObject({ limitNm: 0.25, offshore: false });
    });

    it('takes the skipper’s own limits', () => {
        const prefs = sanitiseUnderwayPrefs({ offRoute: { inshoreNm: 0.1, offshoreNm: 2 } }).offRoute;
        expect(xteLimitNm('nearshore', null, prefs).limitNm).toBe(0.1);
        expect(xteLimitNm('offshore', null, prefs).limitNm).toBe(2);
    });
});

describe('off route: when it sounds and when it clears', () => {
    it('arms only once she has been on the route: a start from a berth off the line never sounds', () => {
        // A berth 0.6 NM off the Solent line, ten minutes of fixes.
        const berth = Array.from({ length: 60 }, (_, i) => ({ at: T0 + i * 10 * S, offNm: 0.6 }));
        const { state, trail } = run(berth);
        expect(trail.every((s) => !s.sounding)).toBe(true);
        expect(state.latched).toBe(false);
        expect(state.status).toBe('arming');
        // Inside the quarter mile once: armed.
        const onRoute = run([{ at: T0 + 700 * S, offNm: 0.2 }], state).state;
        expect(onRoute.latched).toBe(true);
        expect(onRoute.status).toBe('watching');
        // Now off again on two fixes 10 s apart: it sounds.
        const off = run(
            [
                { at: T0 + 710 * S, offNm: 0.6 },
                { at: T0 + 720 * S, offNm: 0.6 },
            ],
            onRoute,
        ).state;
        expect(off.sounding).toBe(true);
    });

    it('needs two fresh fixes 10 s apart, and clears only under 80% of the limit held 20 s', () => {
        let state = latched();
        state = run([{ at: T0 + 10 * S, offNm: 0.3 }], state).state;
        expect(state.sounding).toBe(false);
        state = run([{ at: T0 + 20 * S, offNm: 0.3 }], state).state;
        expect(state.sounding).toBe(true);
        expect(state.status).toBe('sounding');
        // Back to 0.22 NM: inside the limit, not inside 80% of it.
        state = run(
            [
                { at: T0 + 30 * S, offNm: 0.22 },
                { at: T0 + 60 * S, offNm: 0.22 },
            ],
            state,
        ).state;
        expect(state.sounding).toBe(true);
        // 0.19 NM: clears once held 20 s.
        state = run(
            [
                { at: T0 + 70 * S, offNm: 0.19 },
                { at: T0 + 80 * S, offNm: 0.19 },
            ],
            state,
        ).state;
        expect(state.sounding).toBe(true);
        state = run([{ at: T0 + 90 * S, offNm: 0.19 }], state).state;
        expect(state.sounding).toBe(false);
        expect(state.status).toBe('watching');
    });

    it('a single fix back inside the limit restarts the confirmation', () => {
        const { state } = run(
            [
                { at: T0 + 10 * S, offNm: 0.3 },
                { at: T0 + 15 * S, offNm: 0.24 },
                { at: T0 + 25 * S, offNm: 0.3 },
            ],
            latched(),
        );
        expect(state.sounding).toBe(false);
    });

    it('never counts one frozen fix twice', () => {
        let state = latched();
        for (let i = 0; i < 5; i++) {
            state = nextXteState(state, {
                fixAt: T0 + 10 * S,
                offTrackNm: 0.4,
                limitNm: 0.25,
                offshore: false,
                still: false,
            });
        }
        expect(state.sounding).toBe(false);
    });

    it('never sounds tacking ±0.8 NM across an offshore leg (limit 1 NM)', () => {
        let state: XteState = XTE_START;
        for (let i = 0; i < 360; i++) {
            const off = i % 2 === 0 ? 0.8 : -0.8;
            const at = beside(BAY_OF_ISLANDS, 45, 10 + i * 0.03, off);
            const m = measureXte(BAY_OF_ISLANDS, at)!;
            expect(m.offTrackNm).toBeCloseTo(0.8, 1);
            state = nextXteState(state, {
                fixAt: T0 + i * 10 * S,
                offTrackNm: m.offTrackNm,
                ...xteLimitNm('offshore', m.leg, OFF_ROUTE),
                still: false,
            });
            expect(state.sounding).toBe(false);
        }
        expect(state.latched).toBe(true);
    });

    it('stopped (0.3 kn) never sounds or clears: hove-to, or at anchor', () => {
        const still = collisionOwnStill(0.3, false);
        expect(still).toBe(true);
        const quiet = run(
            Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 1) * 10 * S, offNm: 0.6, still })),
            latched(),
        ).state;
        expect(quiet.sounding).toBe(false);
        expect(quiet.status).toBe('stopped');
        // Stopped back on the line is not 'back on the route': a mute holds.
        const sounding = run(
            [
                { at: T0 + 10 * S, offNm: 0.6 },
                { at: T0 + 20 * S, offNm: 0.6 },
            ],
            latched(),
        ).state;
        const muted = muteXte(sounding, T0 + 25 * S);
        const held = run(
            Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 3) * 10 * S, offNm: 0.05, still })),
            muted,
        ).state;
        expect(held.mutedUntil).toBe(muted.mutedUntil);
        expect(held.status).toBe('stopped');
    });

    it('a sounding alarm stands down while she is stopped, and under way again needs two fresh fixes', () => {
        const still = collisionOwnStill(0.1, true);
        const sounding = run(
            [
                { at: T0 + 10 * S, offNm: 0.4 },
                { at: T0 + 20 * S, offNm: 0.4 },
            ],
            latched(),
        ).state;
        expect(xteAudible(sounding, T0 + 20 * S)).toBe(true);
        // She anchors 0.4 NM off the line (an anchorage beside the route): silent, all night.
        const anchored = run(
            Array.from({ length: 600 }, (_, i) => ({ at: T0 + 30 * S + i * 60 * S, offNm: 0.4, still })),
            sounding,
        );
        expect(anchored.trail.every((s) => !xteAudible(s, T0 + 31 * 60 * 60 * S))).toBe(true);
        expect(anchored.state.status).toBe('stopped');
        expect(anchored.state.overSince).toBeNull();
        // Under way again, still off: one fix is not enough; two 10 s apart are.
        const t = T0 + 40_000 * S;
        const one = run([{ at: t, offNm: 0.4 }], anchored.state).state;
        expect(xteAudible(one, t)).toBe(false);
        const two = run([{ at: t + 10 * S, offNm: 0.4 }], one).state;
        expect(xteAudible(two, t + 10 * S)).toBe(true);
    });

    it('a stop, or a lost fix, between two fixes off the line restarts the confirmation', () => {
        const still = true;
        // One fix off, then three hours at anchor, then one fix off under way: not two in a row.
        const anchoredBetween = run(
            [
                { at: T0 + 10 * S, offNm: 0.4 },
                ...Array.from({ length: 180 }, (_, i) => ({ at: T0 + 20 * S + i * 60 * S, offNm: 0.4, still })),
                { at: T0 + 4 * 60 * 60 * S, offNm: 0.4 },
            ],
            latched(),
        ).state;
        expect(anchoredBetween.sounding).toBe(false);
        // One fix off, no fix, one fix off.
        const lostBetween = run(
            [
                { at: T0 + 10 * S, offNm: 0.4 },
                { at: T0 + 15 * S, offNm: null },
                { at: T0 + 25 * S, offNm: 0.4 },
            ],
            latched(),
        ).state;
        expect(lostBetween.sounding).toBe(false);
    });

    it('stands down for good once she reaches the end of the route on the line', () => {
        const obs = (at: number, offNm: number, remainingNm: number, endNm: number) => ({
            fixAt: at,
            offTrackNm: offNm,
            limitNm: 0.25,
            offshore: false,
            still: false,
            remainingNm,
            endNm,
        });
        let state = nextXteState(XTE_START, obs(T0, 0.05, 6, 6));
        state = nextXteState(state, obs(T0 + 10 * S, 0.05, 0.1, 0.1));
        expect(state.status).toBe('arrived');
        // On past the end pin into the marina, 0.4 NM beyond it: never sounds.
        for (let i = 1; i <= 30; i++) state = nextXteState(state, obs(T0 + (10 + i * 10) * S, 0.4, 0, 0.4));
        expect(state.sounding).toBe(false);
        expect(state.status).toBe('arrived');
    });

    it('a route that starts where it ends (a day sail from the berth) is not arrived at the start', () => {
        const obs = (at: number, offNm: number, remainingNm: number, endNm: number) => ({
            fixAt: at,
            offTrackNm: offNm,
            limitNm: 0.25,
            offshore: false,
            still: false,
            remainingNm,
            endNm,
        });
        // In the berth, reckoned on the last leg home: 0 to go, at the end pin.
        let state = nextXteState(XTE_START, obs(T0, 0.05, 0, 0.05));
        state = nextXteState(state, obs(T0 + 10 * S, 0.05, 0, 0.05));
        expect(state.status).toBe('watching');
        // Out on the first leg, then off it: it sounds.
        state = nextXteState(state, obs(T0 + 20 * S, 0.05, 11, 1));
        state = nextXteState(state, obs(T0 + 30 * S, 0.4, 10, 2));
        state = nextXteState(state, obs(T0 + 40 * S, 0.4, 10, 2));
        expect(state.sounding).toBe(true);
    });

    it('beyond the end but well off to the side is off route, not arrived', () => {
        const obs = (at: number, offNm: number, remainingNm: number, endNm: number) => ({
            fixAt: at,
            offTrackNm: offNm,
            limitNm: 0.25,
            offshore: false,
            still: false,
            remainingNm,
            endNm,
        });
        let state = nextXteState(XTE_START, obs(T0, 0.05, 6, 6));
        state = nextXteState(state, obs(T0 + 10 * S, 3, 0, 3));
        state = nextXteState(state, obs(T0 + 20 * S, 3, 0, 3));
        expect(state.status).toBe('sounding');
    });

    it('a stale or missing fix never sounds or clears, and says so', () => {
        const quiet = run(
            Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 1) * 10 * S, offNm: null })),
            latched(),
        ).state;
        expect(quiet.sounding).toBe(false);
        expect(quiet.status).toBe('no-fix');
        const sounding = run(
            [
                { at: T0 + 10 * S, offNm: 0.6 },
                { at: T0 + 20 * S, offNm: 0.6 },
            ],
            latched(),
        ).state;
        const held = run(
            Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 3) * 10 * S, offNm: null })),
            sounding,
        ).state;
        expect(held.sounding).toBe(true);
        expect(held.status).toBe('no-fix');
    });

    it('a mute lasts 30 minutes and ends early when she is back inside', () => {
        const sounding = run(
            [
                { at: T0 + 10 * S, offNm: 0.6 },
                { at: T0 + 20 * S, offNm: 0.6 },
            ],
            latched(),
        ).state;
        const muted = muteXte(sounding, T0 + 30 * S);
        expect(xteAudible(muted, T0 + 30 * S)).toBe(false);
        expect(muted.sounding).toBe(true);
        expect(xteAudible(muted, T0 + 30 * S + 29 * 60 * S)).toBe(false);
        expect(xteAudible(muted, T0 + 30 * S + 30 * 60 * S)).toBe(true);
        // Back inside: the alarm clears and the mute goes with it, so the next excursion sounds.
        const back = run(
            [
                { at: T0 + 60 * S, offNm: 0.1 },
                { at: T0 + 80 * S, offNm: 0.1 },
            ],
            muted,
        ).state;
        expect(back.sounding).toBe(false);
        expect(back.mutedUntil).toBeNull();
        const again = run(
            [
                { at: T0 + 100 * S, offNm: 0.6 },
                { at: T0 + 110 * S, offNm: 0.6 },
            ],
            back,
        ).state;
        expect(xteAudible(again, T0 + 110 * S)).toBe(true);
    });

    it('a mute does nothing to an alarm that is not sounding', () => {
        expect(muteXte(latched(), T0).mutedUntil).toBeNull();
    });
});

describe('off route: measuring', () => {
    it('reads the same off-track distance either side of the antimeridian (Fiji)', () => {
        const west = measureXte(FIJI, { lat: -16.9, lon: 179.95 })!;
        const east = measureXte(FIJI, { lat: -16.9, lon: -179.95 })!;
        expect(west.offTrackNm).toBeCloseTo(6, 0);
        expect(Math.abs(west.offTrackNm - east.offTrackNm)).toBeLessThan(0.01);
        const nearWest = measureXte(FIJI, { lat: -17.004, lon: 179.999 })!;
        const nearEast = measureXte(FIJI, { lat: -17.004, lon: -179.999 })!;
        expect(nearWest.offTrackNm).toBeCloseTo(0.24, 1);
        expect(Math.abs(nearWest.offTrackNm - nearEast.offTrackNm)).toBeLessThan(0.01);
    });

    it('measures in the Solent and at 78N in Isfjorden', () => {
        expect(measureXte(SOLENT, beside(SOLENT, 255, 3, 0.3))!.offTrackNm).toBeCloseTo(0.3, 2);
        const svalbard = measureXte(ISFJORDEN, { lat: 78.2 + 0.3 / 60.04, lon: 14.5 })!;
        expect(svalbard.offTrackNm).toBeCloseTo(0.3, 2);
        expect(svalbard.leg.legLengthNm).toBeGreaterThan(20);
        // 18 NM from both ends of a 37 NM leg, no zone: open water, a mile.
        expect(xteLimitNm(null, svalbard.leg, OFF_ROUTE)).toMatchObject({ limitNm: 1, offshore: true });
    });

    it('is null with no route or no position: never a zero that reads as on the line', () => {
        expect(measureXte([], { lat: 50.7, lon: -1.3 })).toBeNull();
        expect(measureXte(SOLENT, null)).toBeNull();
    });
});

// ── Shoal water ─────────────────────────────────────────────────────────────

const MARGIN = underKeelClearanceM();

function shoal(
    readings: Array<Partial<ShoalObservation> & { depthM: number | null }>,
    vessel: { draft?: number } = KESTREL,
    from: ShoalState = SHOAL_START,
) {
    let state = from;
    const trail: ShoalState[] = [];
    readings.forEach((r, i) => {
        state = nextShoalState(state, {
            underWay: true,
            boatFeed: true,
            reference: 'below-keel',
            freshness: 'live',
            readingAt: T0 + i * 2 * S,
            draftM: vesselDraftMetres(vessel),
            draftAssumed: vesselDraftIsAssumed(vessel),
            marginM: MARGIN,
            ...r,
        });
        trail.push(state);
    });
    return { state, trail };
}

const times = (n: number, r: Partial<ShoalObservation> & { depthM: number | null }) =>
    Array.from({ length: n }, () => ({ ...r }));

describe('shoal water: the Instrument Panel’s depth rule, one function', () => {
    it('is the same keelOffsetFor the Instrument Panel uses (one function, never two)', () => {
        expect(keelOffsetFor).toBe(instrumentPanelKeelOffset);
        expect(underKeelM(2.1, 'below-keel', 2.4)).toBeCloseTo(2.1, 6);
        expect(underKeelM(2.8, 'below-waterline', 2.4)).toBeCloseTo(0.4, 6);
        expect(underKeelM(2.6, 'below-transducer', 2.4)).toBeCloseTo(0.2, 6);
        expect(underKeelM(2.6, null, 2.4)).toBeCloseTo(0.2, 6);
    });

    it('margin under the keel is 0.5 m until 126-06 makes it the skipper’s', () => {
        expect(MARGIN).toBe(0.5);
    });
});

describe('shoal water: Kestrel (draft 2.4 m), margin 0.5 m', () => {
    it('2.1 m below the keel is quiet', () => {
        const { trail } = shoal(times(10, { depthM: 2.1 }));
        expect(trail.every((s) => !s.sounding)).toBe(true);
    });

    it('0.4 m below the keel sounds on the third live reading', () => {
        const { trail } = shoal(times(3, { depthM: 0.4 }));
        expect(trail.map((s) => s.sounding)).toEqual([false, false, true]);
        const lines = shoalLines(trail[2]);
        expect(lines.value).toBe('0.4 m under the keel');
        expect(lines.detail).not.toMatch(/draft/);
        expect(lines.title).toBe('SHOAL WATER');
    });

    it('2.8 m below the waterline sounds: 0.4 m under the keel, and says how it got there', () => {
        const { state } = shoal(times(3, { depthM: 2.8, reference: 'below-waterline' }));
        expect(state.sounding).toBe(true);
        expect(state.underKeelM).toBeCloseTo(0.4, 6);
        const lines = shoalLines(state);
        expect(lines.value).toBe('about 0.4 m under the keel');
        expect(lines.detail).toContain('your sounder reads 2.8 m below the waterline, minus your 2.4 m draft');
    });

    it('2.6 m below the transducer, no offset: sounds, taking the transducer as at the waterline', () => {
        const { state } = shoal(times(3, { depthM: 2.6, reference: 'below-transducer' }));
        expect(state.sounding).toBe(true);
        expect(state.underKeelM).toBeCloseTo(0.2, 6);
        expect(shoalLines(state).detail).toContain('taken as at the waterline');
        expect(shoalLines(state).detail).toContain('minus your 2.4 m draft');
    });

    it('a depthOffsetM beside a below-transducer reading (should never happen) is ignored: still sounds', () => {
        const { state } = shoal(times(3, { depthM: 2.6, reference: 'below-transducer', offsetM: -1.8 }));
        expect(state.sounding).toBe(true);
        expect(state.underKeelM).toBeCloseTo(0.2, 6);
    });

    it('stale and dead readings neither sound nor clear', () => {
        for (const freshness of ['stale', 'dead'] as const) {
            const quiet = shoal(times(10, { depthM: 0.2, freshness })).state;
            expect(quiet.sounding).toBe(false);
            expect(quiet.status).toBe('stale');
        }
        const sounding = shoal(times(3, { depthM: 0.2 })).state;
        for (const freshness of ['stale', 'dead'] as const) {
            const held = shoal(times(10, { depthM: 3, freshness }), KESTREL, sounding).state;
            expect(held.sounding).toBe(true);
        }
        // A dead reading is retired to null by the store: still no change.
        const gone = shoal(times(10, { depthM: null, freshness: 'dead' }), KESTREL, sounding).state;
        expect(gone.sounding).toBe(true);
        expect(gone.status).toBe('stale');
    });

    it('clears only at 0.8 m (the margin + 0.3 m) held 10 s', () => {
        let state = shoal(times(3, { depthM: 0.3 })).state;
        // 0.79 m for 30 s: still sounding.
        for (let i = 0; i < 15; i++) {
            state = nextShoalState(state, {
                underWay: true,
                boatFeed: true,
                depthM: 0.79,
                reference: 'below-keel',
                freshness: 'live',
                readingAt: T0 + 100 * S + i * 2 * S,
                draftM: 2.4,
                draftAssumed: false,
                marginM: MARGIN,
            });
            expect(state.sounding).toBe(true);
        }
        const at = (t: number, depthM: number) =>
            nextShoalState(state, {
                underWay: true,
                boatFeed: true,
                depthM,
                reference: 'below-keel',
                freshness: 'live',
                readingAt: t,
                draftM: 2.4,
                draftAssumed: false,
                marginM: MARGIN,
            });
        state = at(T0 + 200 * S, 0.8);
        expect(state.sounding).toBe(true);
        state = at(T0 + 205 * S, 0.85);
        expect(state.sounding).toBe(true);
        state = at(T0 + 210 * S, 0.9);
        expect(state.sounding).toBe(false);
    });

    it('acknowledged: silent until it clears, then it re-arms', () => {
        const sounding = shoal(times(3, { depthM: 0.3 })).state;
        expect(shoalAudible(sounding)).toBe(true);
        let state = acknowledgeShoal(sounding);
        expect(shoalAudible(state)).toBe(false);
        state = shoal(times(10, { depthM: 0.2 }), KESTREL, { ...state, lastReadingAt: null }).state;
        expect(state.sounding).toBe(true);
        expect(shoalAudible(state)).toBe(false);
        state = shoal(
            Array.from({ length: 8 }, (_, i) => ({ depthM: 1.5, readingAt: T0 + 100 * S + i * 2 * S })),
            KESTREL,
            state,
        ).state;
        expect(state.sounding).toBe(false);
        expect(state.acknowledged).toBe(false);
        state = shoal(
            Array.from({ length: 3 }, (_, i) => ({ depthM: 0.3, readingAt: T0 + 200 * S + i * 2 * S })),
            KESTREL,
            state,
        ).state;
        expect(shoalAudible(state)).toBe(true);
    });

    it('only the boat’s own feed counts; stopped holds', () => {
        const cloud = shoal(times(10, { depthM: 0.2, boatFeed: false })).state;
        expect(cloud.sounding).toBe(false);
        expect(cloud.status).toBe('no-depth');
        const berth = shoal(times(10, { depthM: 0.2, underWay: false })).state;
        expect(berth.sounding).toBe(false);
        expect(berth.status).toBe('stopped');
    });

    it('three shallow readings must come in a row under way: a berth with GPS speed blips never sounds', () => {
        // Alongside at low water, 0.3 m under the keel, the sounder live every 2 s; now and then
        // the boat's GPS speed jumps to 0.7 kn for one reading (marina multipath).
        let state: ShoalState = SHOAL_START;
        let t = T0;
        for (let blip = 0; blip < 3; blip++) {
            for (let i = 0; i < 20; i++) {
                t += 2 * S;
                state = shoal([{ depthM: 0.3, underWay: false, readingAt: t }], KESTREL, state).state;
            }
            t += 2 * S;
            state = shoal([{ depthM: 0.3, underWay: true, readingAt: t }], KESTREL, state).state;
            expect(state.sounding).toBe(false);
        }
        // Three shallow readings far apart in time (a suspended app between them) are not three in a row either.
        let gapped: ShoalState = SHOAL_START;
        for (let i = 0; i < 3; i++) {
            gapped = shoal([{ depthM: 0.3, readingAt: T0 + i * 60 * 60 * S }], KESTREL, gapped).state;
        }
        expect(gapped.sounding).toBe(false);
    });

    it('a sounder lost under way is said; one lost after the boat stopped (a skipper walking off) is not', () => {
        // Live under way, then the gateway drops: the watch says it cannot see.
        const live = shoal(times(3, { depthM: 6 })).state;
        const lost = shoal([{ depthM: null, boatFeed: false, readingAt: T0 + 60 * S }], KESTREL, live).state;
        expect(lost.status).toBe('lost');
        // The Pi's cloud row turns up with a shallow number: never believed, still lost.
        const cloud = shoal(times(5, { depthM: 0.2, boatFeed: false }), KESTREL, lost).state;
        expect(cloud.status).toBe('lost');
        expect(cloud.sounding).toBe(false);
        // Alongside, the sounder live, then the skipper walks off with the phone (3 kn, out of the boat's Wi-Fi).
        const berthed = shoal(times(3, { depthM: 6, underWay: false }), KESTREL, live).state;
        const walking = shoal([{ depthM: null, boatFeed: false, readingAt: T0 + 60 * S }], KESTREL, berthed).state;
        expect(walking.status).toBe('no-depth');
    });

    it('reads the depth straight from the store’s fields, and nothing else', () => {
        const store = {
            depth: { value: 2.6, lastUpdated: T0, freshness: 'live' as const },
            depthReference: 'below-transducer' as const,
            depthOffsetM: -1.8,
        };
        expect(shoalDepthFrom(store, true)).toEqual({
            boatFeed: true,
            depthM: 2.6,
            reference: 'below-transducer',
            offsetM: -1.8,
            freshness: 'live',
            readingAt: T0,
        });
        expect(
            shoalDepthFrom({ ...store, depth: { value: null, lastUpdated: 0, freshness: 'dead' } }, true),
        ).toMatchObject({ depthM: null, freshness: 'dead' });
    });
});

describe('shoal water: Albatross (draft not set)', () => {
    it('a below-keel 0.3 m sounds with no draft line: it needs no draft', () => {
        const { state } = shoal(times(3, { depthM: 0.3 }), ALBATROSS);
        expect(state.sounding).toBe(true);
        const lines = shoalLines(state);
        expect(`${lines.value} ${lines.detail}`).not.toMatch(/draft/);
    });

    it('a below-waterline reading sounds, and every line says the draft is not set', () => {
        // vesselDraftMetres falls back to 2.5 m: 2.9 m below the waterline is 0.4 m under the keel.
        const { state } = shoal(times(3, { depthM: 2.9, reference: 'below-waterline' }), ALBATROSS);
        expect(state.sounding).toBe(true);
        expect(state.underKeelM).toBeCloseTo(0.4, 6);
        const lines = shoalLines(state);
        expect(lines.detail).toContain('draft not set: set it in Vessel');
        expect(lines.detail).not.toContain('your 2.5 m draft');
    });
});
