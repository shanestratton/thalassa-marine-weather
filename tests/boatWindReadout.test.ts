/**
 * Her own wind on her own icon whenever Obs's wind field is not showing it
 * (build 123, W1-WC). Shane 2026-10-07: "what about if it is just the highest
 * zoom (14) as soon as the punter zooms out from there, then the wind models
 * kick in??", then "go do it" — on the recommendation that her reading moves
 * onto her boat icon as a small arrow and number once the models take over,
 * so a skipper zoomed out never loses sight of what she measures.
 *
 * These are the pure halves: what the overlay publishes (one readout, one
 * truth with the field) and what her marker makes of it. Fictional values.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    BOAT_WIND_ARROW_STEP_DEG,
    boatWindChipFor,
    getBoatWindReadout,
    resolveBoatWindReadout,
    setBoatWindReadout,
    subscribeBoatWindReadout,
    type BoatWindReadout,
} from '../components/map/boatWindReadout';
import type { OwnshipSubject } from '../components/map/ownshipBoatFix';

const OWN: OwnshipSubject = { kind: 'boat', crewOwnerId: null };
const CREWED: OwnshipSubject = { kind: 'boat', crewOwnerId: 'skipper-wind-dancer' };
const PHONE: OwnshipSubject = { kind: 'phone' };

/** Her live reading: 14 kt from the south-south-west. */
const LIVE = { kt: 14, fromDeg: 200, stale: false };

function readout(patch: Partial<BoatWindReadout> = {}): BoatWindReadout {
    return { wind: LIVE, boat: { crewOwnerId: null }, fieldShowsHers: false, ...patch };
}

afterEach(() => setBoatWindReadout(null));

describe('what the overlay publishes', () => {
    it('her usable wind, at now, for the followed boat; whether the field is already painting it', () => {
        expect(
            resolveBoatWindReadout({
                wind: LIVE,
                boat: { crewOwnerId: null },
                scrubAtNow: true,
                fieldShowsHers: false,
            }),
        ).toEqual({ wind: LIVE, boat: { crewOwnerId: null }, fieldShowsHers: false });
        expect(
            resolveBoatWindReadout({ wind: LIVE, boat: { crewOwnerId: null }, scrubAtNow: true, fieldShowsHers: true }),
        ).toEqual({ wind: LIVE, boat: { crewOwnerId: null }, fieldShowsHers: true });
    });

    it('nothing scrubbed away from now: an hour ahead is the model’s, never her reading', () => {
        expect(
            resolveBoatWindReadout({
                wind: LIVE,
                boat: { crewOwnerId: null },
                scrubAtNow: false,
                fieldShowsHers: false,
            }),
        ).toBeNull();
    });

    it('nothing while the box follows the phone, and nothing without a usable reading of hers', () => {
        expect(resolveBoatWindReadout({ wind: LIVE, boat: null, scrubAtNow: true, fieldShowsHers: false })).toBeNull();
        expect(
            resolveBoatWindReadout({
                wind: null,
                boat: { crewOwnerId: null },
                scrubAtNow: true,
                fieldShowsHers: false,
            }),
        ).toBeNull();
    });

    it('one shared readout that notifies only on a change her icon would show', () => {
        let calls = 0;
        const unsubscribe = subscribeBoatWindReadout(() => {
            calls += 1;
        });
        setBoatWindReadout(readout({ wind: { kt: 14.02, fromDeg: 200.2, stale: false } }));
        const first = getBoatWindReadout();
        expect(calls).toBe(1);
        // An instrument tick that changes nothing on screen: no notification.
        setBoatWindReadout(readout({ wind: { kt: 14.04, fromDeg: 200.4, stale: false } }));
        expect(getBoatWindReadout()).toBe(first);
        expect(calls).toBe(1);
        // The field taking her wind over, the stale tier, another boat, a new number: each notifies.
        setBoatWindReadout(readout({ fieldShowsHers: true }));
        setBoatWindReadout(readout({ wind: { ...LIVE, stale: true } }));
        setBoatWindReadout(readout({ boat: { crewOwnerId: 'skipper-wind-dancer' } }));
        setBoatWindReadout(readout({ wind: { kt: 15, fromDeg: 200, stale: false } }));
        expect(calls).toBe(5);
        setBoatWindReadout(null);
        setBoatWindReadout(null);
        expect(calls).toBe(6);
        unsubscribe();
        setBoatWindReadout(readout());
        expect(calls).toBe(6);
    });

    it('a reading that crosses a line her icon draws notifies, however small the step', () => {
        let calls = 0;
        const unsubscribe = subscribeBoatWindReadout(() => {
            calls += 1;
        });
        /** Her icon as painted from what was last notified. */
        const shown = (unit: string) => boatWindChipFor(getBoatWindReadout(), OWN, unit)!.text;
        /** Each pair is under a tenth of a knot and a whole degree apart, yet her icon reads differently. */
        const step = (
            unit: string,
            [kt, fromDeg, before]: [number, number, string],
            [nextKt, nextFromDeg, after]: [number, number, string],
        ) => {
            setBoatWindReadout(readout({ wind: { kt, fromDeg, stale: false } }));
            expect(shown(unit)).toBe(before);
            const was = calls;
            setBoatWindReadout(readout({ wind: { kt: nextKt, fromDeg: nextFromDeg, stale: false } }));
            expect(calls).toBe(was + 1);
            expect(shown(unit)).toBe(after);
        };
        // The Calm line.
        step('kts', [0.96, 90, 'Calm'], [1.04, 90, '1 kt E']);
        // The tenth of a metre per second (a skipper who works in m/s, fictional).
        step('mps', [7.46, 90, '3.8 m/s E'], [7.54, 90, '3.9 m/s E']);
        // The whole kilometre per hour.
        step('kmh', [9.951, 90, '18 km/h E'], [9.99, 90, '19 km/h E']);
        // A 16-point edge: from 11.2 reads N, from 11.4 reads NNE.
        step('kts', [12, 11.2, '12 kt N'], [12, 11.4, '12 kt NNE']);
        // And a tick that changes nothing in any unit still does not notify.
        const was = calls;
        setBoatWindReadout(readout({ wind: { kt: 12.02, fromDeg: 11.45, stale: false } }));
        expect(calls).toBe(was);
        unsubscribe();
    });
});

describe('what her icon shows', () => {
    it('her speed and 16-point direction, an arrow the way the streaks fly, and a spelled-out name', () => {
        expect(boatWindChipFor(readout(), OWN, 'kts')).toEqual({
            text: '14 kt SSW',
            // From 200: it blows towards 20, the way the streaks fly.
            arrowDeg: 20,
            stale: false,
            label: 'Boat wind 14 knots from south-south-west',
        });
    });

    it('in the user’s own speed unit, spelled out in the name', () => {
        // A boat in the Solent, read by a skipper who works in km/h (fictional).
        const solent = readout({ wind: { kt: 10, fromDeg: 292, stale: false } });
        expect(boatWindChipFor(solent, OWN, 'kmh')).toMatchObject({
            text: '19 km/h WNW',
            label: 'Boat wind 19 kilometres per hour from west-north-west',
        });
        expect(boatWindChipFor(solent, OWN, 'mph')).toMatchObject({
            text: '12 mph WNW',
            label: 'Boat wind 12 miles per hour from west-north-west',
        });
        expect(boatWindChipFor(solent, OWN, 'mps')).toMatchObject({
            text: '5.1 m/s WNW',
            label: 'Boat wind 5.1 metres per second from west-north-west',
        });
        expect(
            boatWindChipFor(readout({ wind: { kt: 1.2, fromDeg: 45, stale: false } }), OWN, undefined),
        ).toMatchObject({ text: '1 kt NE', label: 'Boat wind 1 knot from north-east' });
    });

    it('the arrow turns in 5 degree steps, so a wandering vane is not a new drawing every tick', () => {
        expect(BOAT_WIND_ARROW_STEP_DEG).toBe(5);
        const arrow = (fromDeg: number) =>
            boatWindChipFor(readout({ wind: { kt: 12, fromDeg, stale: false } }), OWN, 'kts')!.arrowDeg;
        expect(arrow(200)).toBe(20);
        expect(arrow(201.4)).toBe(20);
        expect(arrow(203)).toBe(25);
        expect(arrow(178)).toBe(0);
        expect(arrow(358.9)).toBe(180);
    });

    it('Calm, with no arrow', () => {
        const calm = boatWindChipFor(readout({ wind: { kt: 0.4, fromDeg: null, stale: false } }), OWN, 'kts');
        expect(calm).toEqual({ text: 'Calm', arrowDeg: null, stale: false, label: 'Boat wind calm' });
        // A calm with a vane still pointing somewhere: still Calm, still no arrow.
        expect(boatWindChipFor(readout({ wind: { kt: 0.6, fromDeg: 90, stale: false } }), OWN, 'kts')).toMatchObject({
            text: 'Calm',
            arrowDeg: null,
        });
    });

    it('no direction: the speed only, with no arrow', () => {
        expect(boatWindChipFor(readout({ wind: { kt: 6, fromDeg: null, stale: false } }), OWN, 'kts')).toEqual({
            text: '6 kt',
            arrowDeg: null,
            stale: false,
            label: 'Boat wind 6 knots',
        });
    });

    it('the stale tier: shown, marked stale, and the name says so', () => {
        const chip = boatWindChipFor(readout({ wind: { ...LIVE, stale: true } }), OWN, 'kts')!;
        expect(chip.text).toBe('14 kt SSW');
        expect(chip.stale).toBe(true);
        expect(chip.label).toMatch(/\bstale\b/i);
    });

    it('hidden wherever the field already shows her wind: the two never both claim it', () => {
        expect(boatWindChipFor(readout({ fieldShowsHers: true }), OWN, 'kts')).toBeNull();
    });

    it('only on the boat whose wind it is: never the phone, never another boat', () => {
        expect(boatWindChipFor(null, OWN, 'kts')).toBeNull();
        expect(boatWindChipFor(readout(), PHONE, 'kts')).toBeNull();
        expect(boatWindChipFor(readout(), CREWED, 'kts')).toBeNull();
        const crewed = readout({
            boat: { crewOwnerId: 'skipper-wind-dancer' },
            wind: { kt: 22, fromDeg: 90, stale: false },
        });
        expect(boatWindChipFor(crewed, OWN, 'kts')).toBeNull();
        expect(boatWindChipFor(crewed, CREWED, 'kts')).toMatchObject({ text: '22 kt E', arrowDeg: 270 });
    });
});
