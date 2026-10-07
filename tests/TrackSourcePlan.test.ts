/**
 * Which receiver feeds a voyage's track, decided once at Start (build 123,
 * package VL — voyage logging uses the vessel GPS).
 *
 * Shane 2026-10-07, with a red "needs Always Location" toast and the phone's
 * "GPS Accuracy Notice" on screen while the app knew exactly where the boat
 * was: "we need it to use the vessel gps if and when available".
 *
 * The table, row by row (voyagelog.md, design §1):
 *   - her lane live (the bus, the Pi on her LAN, the Pi direct, her cloud row
 *     ≤ 60 s): the boat is the source; never Always, never the phone notice;
 *     the phone may stand in aboard, never ashore;
 *   - a Pi that records her track: nothing needs to be asked of the phone;
 *   - a gateway-only boat: While Using is enough;
 *   - a boat configured but silent at Start: ask (aboard), never (ashore);
 *   - no boat at all: the phone, with Always advised (not demanded) and the
 *     phone notice;
 *   - a Bad Elf / MFi accessory feeding Core Location: the phone, no notice.
 *
 * Global fixtures: Airlie Beach, the Solent, the Chesapeake and Nouméa. WHERE
 * comes from gwstate's own resolveWhere, by position — never by which address
 * answered.
 */
import { describe, expect, it } from 'vitest';
import { resolveWhere, type DataState, type Lane, type LinkKind } from '../services/boatLink/boatLinkModel';
import {
    applyStandInAnswer,
    planTrackSource,
    BOAT_POSITION_MAX_AGE_MS,
    type TrackSourceInput,
} from '../services/shiplog/trackSourcePlan';

const NOW = Date.parse('2026-10-07T05:00:00Z');

const AIRLIE = { lat: -20.2701, lon: 148.7232 };
const SOLENT = { lat: 50.7712, lon: -1.3005 }; // Cowes
const CHESAPEAKE = { lat: 38.9784, lon: -76.4922 }; // Annapolis
const NOUMEA = { lat: -22.2796, lon: 166.4389 }; // Port Moselle

/** WHERE as gwstate decides it: the phone's fix against the boat's. */
function whereFor(phone: { lat: number; lon: number } | null, boat: { lat: number; lon: number } | null) {
    return resolveWhere({
        now: NOW,
        phone: phone ? { ...phone, at: NOW - 5_000, accuracyM: 8 } : null,
        boat: boat ? { ...boat, at: NOW - 3_000, accuracyM: 5 } : null,
    }).where;
}

function input(over: Partial<TrackSourceInput> & { link?: Partial<TrackSourceInput['link']> } = {}): TrackSourceInput {
    const { link, ...rest } = over;
    return {
        boatConfigured: true,
        piRecorderOn: false,
        boatPosition: { lane: 'bus', ageMs: 2_000 },
        phoneAccessory: false,
        ...rest,
        link: {
            where: 'aboard',
            lane: 'socket' as Lane,
            kind: 'boat-wifi' as LinkKind,
            data: 'live' as DataState,
            ...link,
        },
    };
}

describe('planTrackSource — the boat owns the track when she can', () => {
    it('Pi on her LAN at Airlie, phone aboard, Pi recording: vessel, While Using (never Always), no notice, stand-in allowed', () => {
        const where = whereFor(AIRLIE, AIRLIE);
        expect(where).toBe('aboard');
        const plan = planTrackSource(
            input({
                piRecorderOn: true,
                boatPosition: { lane: 'bus', ageMs: 1_500 },
                link: { where, lane: 'pi-direct', kind: 'boat-wifi', data: 'live' },
            }),
        );
        // Build 123 review: her Pi's own track does not reach a voyage until
        // the backfill (phase 2) ships, so this phone's keep-alive is still
        // what records her lanes with the screen locked. While Using, taken in
        // the foreground, is enough — a voyage never starts without one aboard.
        expect(plan).toMatchObject({
            source: 'vessel',
            lane: 'bus',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
            standIn: 'allowed',
            standInOptIn: false,
        });
    });

    it('gateway-only boat in the Solent (YDWG-02 socket, no Pi): vessel, While Using is enough', () => {
        const where = whereFor(SOLENT, SOLENT);
        const plan = planTrackSource(
            input({
                piRecorderOn: false,
                boatPosition: { lane: 'bus', ageMs: 900 },
                link: { where, lane: 'socket', kind: 'boat-wifi', data: 'live' },
            }),
        );
        expect(plan).toMatchObject({
            source: 'vessel',
            keepAlive: 'when-in-use',
            showPhoneNotice: false,
            standIn: 'allowed',
        });
        // Never an Always demand for a boat-fed log.
        expect(plan.keepAlive).not.toBe('always-required');
    });

    it('cloud-only from ashore — skipper in Annapolis, the boat in Nouméa: a boat-only voyage, the phone never stands in, nothing asked', () => {
        const where = whereFor(CHESAPEAKE, NOUMEA);
        expect(where).toBe('ashore');
        const plan = planTrackSource(
            input({
                piRecorderOn: false,
                boatPosition: { lane: 'cloud', ageMs: 20_000 },
                link: { where, lane: 'cloud', kind: 'cloud', data: 'live' },
            }),
        );
        expect(plan).toMatchObject({
            source: 'vessel',
            lane: 'cloud',
            keepAlive: 'none-needed',
            showPhoneNotice: false,
            standIn: 'never',
        });
    });

    it('a cloud fix older than a minute is where she WAS: not a live boat lane', () => {
        const plan = planTrackSource(
            input({
                boatPosition: { lane: 'cloud', ageMs: BOAT_POSITION_MAX_AGE_MS + 1 },
                link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' },
            }),
        );
        expect(plan.source).toBe('vessel-silent');
    });

    it('nothing configured — a phone-only punter in Nouméa: the phone, Always advised (never required), the notice once', () => {
        const plan = planTrackSource(
            input({
                boatConfigured: false,
                boatPosition: null,
                link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' },
            }),
        );
        expect(plan).toMatchObject({
            source: 'phone',
            keepAlive: 'always-advised',
            showPhoneNotice: true,
            standIn: 'allowed',
        });
    });

    it('configured but silent at Start, aboard in the Solent: vessel-silent, ask the skipper', () => {
        const plan = planTrackSource(
            input({
                boatPosition: null,
                link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' },
            }),
        );
        expect(plan).toMatchObject({
            source: 'vessel-silent',
            lane: 'none',
            showPhoneNotice: false,
            standIn: 'ask',
        });
    });

    it('configured but silent at Start from ashore: never asks, never lets the phone in', () => {
        const where = whereFor(CHESAPEAKE, NOUMEA);
        const plan = planTrackSource(
            input({ boatPosition: null, link: { where, lane: 'none', kind: 'none', data: 'none' } }),
        );
        expect(plan).toMatchObject({ source: 'vessel-silent', standIn: 'never', keepAlive: 'none-needed' });
    });

    it('a lane that has just gone stale is patience, not silence: vessel, no question', () => {
        const plan = planTrackSource(
            input({ boatPosition: null, link: { where: 'aboard', lane: 'none', kind: 'none', data: 'stale' } }),
        );
        expect(plan.source).toBe('vessel');
        expect(plan.standIn).toBe('allowed');
    });

    it('a Bad Elf / MFi accessory feeding Core Location: the phone source, no accuracy notice', () => {
        const plan = planTrackSource(
            input({
                boatConfigured: false,
                boatPosition: null,
                phoneAccessory: true,
                link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' },
            }),
        );
        expect(plan).toMatchObject({ source: 'phone-accessory', showPhoneNotice: false, keepAlive: 'always-advised' });
    });

    it('a crew phone sharing its own readings (lane "shared") is never the boat', () => {
        const plan = planTrackSource(
            input({ boatPosition: null, link: { where: 'unknown', lane: 'shared', kind: 'cloud', data: 'live' } }),
        );
        expect(plan.source).toBe('vessel-silent');
    });
});

describe('applyStandInAnswer — the one question at Start', () => {
    const silent = planTrackSource(
        input({ boatPosition: null, link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' } }),
    );

    it('"Wait for the boat" starts a boat-only voyage: the phone never stands in, no notice', () => {
        expect(applyStandInAnswer(silent, 'wait')).toMatchObject({
            source: 'vessel-silent',
            standIn: 'never',
            standInOptIn: false,
            showPhoneNotice: false,
        });
    });

    it('"Log from this phone" makes the phone the source, opted in, with the phone notice and Always advised', () => {
        expect(applyStandInAnswer(silent, 'phone')).toMatchObject({
            source: 'phone',
            standIn: 'allowed',
            standInOptIn: true,
            showPhoneNotice: true,
            keepAlive: 'always-advised',
        });
    });

    it('"Log from this phone" with a Bad Elf feeding Core Location: no notice', () => {
        const accessory = planTrackSource(
            input({
                boatPosition: null,
                phoneAccessory: true,
                link: { where: 'unknown', lane: 'none', kind: 'none', data: 'none' },
            }),
        );
        expect(applyStandInAnswer(accessory, 'phone')).toMatchObject({
            source: 'phone-accessory',
            showPhoneNotice: false,
            standInOptIn: true,
        });
    });
});
