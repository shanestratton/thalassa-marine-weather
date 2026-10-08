/**
 * AIS truth over the Pi lane (build 125, package 125-10b).
 *
 * Aboard a boat with a Pi, the phone reads AIS off the Pi first
 * (services/PiTelemetryService.ts), so the collision alarm (125-01) and the
 * distress alarm (125-02) are only as good as what crosses that lane. Two
 * things were lost on the way, and three were invented:
 *
 *  - a course or speed Signal K did not have went out as 0: due north and
 *    stopped, so a moving ship with an unknown speed graded as a berthed one;
 *  - a beacon heard before its GNSS fix (status 14, lat 91 / lon 181, which
 *    Signal K files with no position at all) never left the Pi;
 *  - a message 14 text Signal K carries (PGN 129802, N2K-fed Pis) never left
 *    the Pi either. Signal K 2.32.0's NMEA 0183 parser drops message 14's
 *    text, so on an 0183-fed Pi the beacon's status and MMSI are all there is;
 *  - a missing navigation.state became 15, which on a 97x MMSI is a TEST;
 *  - a course, speed or status Signal K kept from an earlier report (its
 *    newest said 'not available', or carried a status Signal K has no string
 *    for) went out as current, stamped with the newest position's time.
 *
 * The documents below are shaped as Signal K 2.32.0 files them (read off the
 * boat's Pi, read-only, 2026-10-09), and travel through the Pi's own reader
 * (pi-cache/src/lanTelemetry.ts), JSON, the phone's lane, the AIS store and
 * the alarms' own rules. Fictional MMSIs (970/972/974 and MID 123); positions
 * worldwide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pi = vi.hoisted(() => ({ body: '{}' }));
const mocks = vi.hoisted(() => ({
    audio: {
        startAlarm: vi.fn().mockResolvedValue({ playing: true }),
        stopAlarm: vi.fn().mockResolvedValue({ stopped: true }),
        isAlarmPlaying: vi.fn().mockResolvedValue({ playing: false }),
    },
    notify: {
        checkReadiness: vi.fn(),
        scheduleAlarm: vi.fn(),
        cancelAlarm: vi.fn(),
        scheduleSafetyAlert: vi.fn().mockResolvedValue({ scheduled: 0 }),
        cancelSafetyAlert: vi.fn().mockResolvedValue({ cancelled: true }),
    },
}));

vi.mock('@capacitor/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@capacitor/core')>()),
    Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false },
    registerPlugin: (name: string) => (name === 'AlarmAudio' ? mocks.audio : mocks.notify),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => ({ deviceId: 'pi', boatName: 'Fictional' }),
    pinnedPiRequest: async () => ({ status: 200, data: pi.body }),
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getBaseUrl: () => 'https://192.168.1.50:3001',
        getRemoteBaseUrl: () => null,
        getStatus: () => ({ reachable: true }),
    },
}));

import { readAisTargets, readLanTelemetry } from '../pi-cache/src/lanTelemetry';
import { AisStore } from '../services/AisStore';
import { PiTelemetryService, aisSafetyTextFromWire, aisTargetFromWire } from '../services/PiTelemetryService';
import { collectDistressBeacons } from '../services/DistressAlarmService';
import { distressLines } from '../services/aisGuardAlertStore';
import { gradeCollisionTargets } from '../services/AisGuardWatch';
import { targetPresentation } from '../components/map/useAisStreamLayer';
import { DEFAULT_COLLISION_PREFS, aisCogDeg, aisSogKn, assessCollision } from '../utils/collisionRule';

const SART = 970_123_001;
const MOB = 972_123_002;
const EPIRB = 974_123_003;
const SHIP = 123_456_001;

const iso = (now: number, agoMs: number) => new Date(now - agoMs).toISOString();
const leaf = (now: number, value: unknown, agoMs: number) => ({
    value,
    $source: 'ydwg-tcp.AI',
    timestamp: iso(now, agoMs),
});

/** A target as Signal K 2.32.0's VDM.js files it: no leaf at all for anything 'not available'. */
function classA(
    now: number,
    mmsi: number,
    agoMs: number,
    fields: {
        position?: { latitude: number; longitude: number };
        cogRad?: number;
        sogMs?: number;
        state?: string;
        text?: string;
    },
): [string, Record<string, unknown>] {
    return [
        `urn:mrn:imo:mmsi:${mmsi}`,
        {
            mmsi: String(mmsi),
            navigation: {
                ...(fields.position ? { position: leaf(now, fields.position, agoMs) } : {}),
                ...(fields.cogRad !== undefined ? { courseOverGroundTrue: leaf(now, fields.cogRad, agoMs) } : {}),
                ...(fields.sogMs !== undefined ? { speedOverGround: leaf(now, fields.sogMs, agoMs) } : {}),
                ...(fields.state !== undefined ? { state: leaf(now, fields.state, agoMs) } : {}),
            },
            sensors: { ais: { class: leaf(now, 'A', agoMs) } },
            ...(fields.text
                ? { communication: { ais: { safetyRelatedBroadcast: leaf(now, fields.text, agoMs) } } }
                : {}),
        },
    ];
}

/** Signal K on the Pi: the traffic, and a quiet bus (no vessels/self document). */
function signalK(vessels: Record<string, unknown>): typeof fetch {
    return (async (url: string) => {
        const path = String(url);
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
        if (path.endsWith('/signalk'))
            return ok({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } });
        if (path.endsWith('/vessels/self')) return { ok: false, json: async () => null } as unknown as Response;
        if (path.endsWith('/vessels')) return ok(vessels);
        if (path.endsWith('/self')) return ok('vessels.urn:mrn:imo:mmsi:123456999');
        return { ok: false, json: async () => null } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** Signal K → the Pi's /api/telemetry body → JSON → one read of the phone's Pi lane → the AIS store. */
async function throughThePi(now: number, targets: Array<[string, Record<string, unknown>]>) {
    const body = await readLanTelemetry({
        fetchImpl: signalK(Object.fromEntries(targets)),
        signalkOrigin: 'http://sk',
        deviceLabel: 'calypso',
        now: () => now,
    });
    pi.body = JSON.stringify(body);
    await PiTelemetryService.pollOnce();
    return body;
}

/** The phone's AIS store as the guard reads it: the receiver's GeoJSON, tagged 'local'. */
function localFeatures(): GeoJSON.Feature[] {
    return AisStore.toGeoJSON().features.map((f) => ({
        ...f,
        properties: { ...f.properties, source: 'local' },
    })) as GeoJSON.Feature[];
}

describe('aisTargetFromWire: what the Pi does not know stays unknown on the phone', () => {
    const base = { mmsi: SHIP, lat: 37.0, lon: -76.1, lastUpdated: 1 };

    it('a missing nav status is null, not 15; real ITU codes pass', () => {
        expect(aisTargetFromWire(base)!.navStatus).toBeNull();
        expect(aisTargetFromWire({ ...base, navStatus: null })!.navStatus).toBeNull();
        expect(aisTargetFromWire({ ...base, navStatus: 16 })!.navStatus).toBeNull();
        expect(aisTargetFromWire({ ...base, navStatus: 2.5 })!.navStatus).toBeNull();
        expect(aisTargetFromWire({ ...base, navStatus: 'sailing' })!.navStatus).toBeNull();
        for (const code of [0, 1, 5, 8, 14, 15])
            expect(aisTargetFromWire({ ...base, navStatus: code })!.navStatus).toBe(code);
    });

    it('a null course or speed is "not available", never 0', () => {
        const t = aisTargetFromWire({ ...base, cog: null, sog: null })!;
        expect(aisSogKn(t.sog)).toBeNull();
        expect(aisCogDeg(t.cog)).toBeNull();
        const real = aisTargetFromWire({ ...base, cog: 0, sog: 0 })!;
        expect(real.cog).toBe(0);
        expect(real.sog).toBe(0);
    });

    it('a beacon heard before its fix comes through with no position; nothing else does', () => {
        const sart = aisTargetFromWire({ mmsi: SART, lat: null, lon: null, navStatus: 14, lastUpdated: 5 })!;
        expect(sart).not.toBeNull();
        expect('lat' in sart).toBe(false);
        expect('lon' in sart).toBe(false);
        expect(sart.navStatus).toBe(14);
        expect(sart.lastUpdated).toBe(5);
        // Status 14 makes any MMSI a beacon; a 97x needs no status.
        expect(aisTargetFromWire({ mmsi: SHIP, lat: null, lon: null, navStatus: 14, lastUpdated: 5 })).not.toBeNull();
        expect(aisTargetFromWire({ mmsi: MOB, lastUpdated: 5 })).not.toBeNull();
        // An ordinary target without a position cannot be drawn or graded.
        expect(aisTargetFromWire({ mmsi: SHIP, lat: null, lon: null, navStatus: 0, lastUpdated: 5 })).toBeNull();
        expect(aisTargetFromWire({ mmsi: 1, lat: 91, lon: 1, lastUpdated: 1 })).toBeNull();
        // An ITU 'not available' position on a beacon is no position, not a place.
        const odd = aisTargetFromWire({ mmsi: SART, lat: 91, lon: 181, navStatus: 14, lastUpdated: 5 })!;
        expect('lat' in odd).toBe(false);
    });

    it('a message 14 text comes off its own fields, with the time it was heard', () => {
        expect(aisSafetyTextFromWire({ mmsi: SART, safetyText: 'SART ACTIVE', safetyTextAt: 7 })).toEqual({
            mmsi: SART,
            text: 'SART ACTIVE',
            at: 7,
        });
        expect(aisSafetyTextFromWire({ mmsi: SART, safetyText: '', safetyTextAt: 7 })).toBeNull();
        expect(aisSafetyTextFromWire({ mmsi: SART, safetyText: 'SART ACTIVE' })).toBeNull();
        expect(aisSafetyTextFromWire({ mmsi: SART, lat: 1, lon: 1, lastUpdated: 1 })).toBeNull();
        expect(aisSafetyTextFromWire(null)).toBeNull();
    });

    it("Signal K's state strings reach the phone as the ITU numbers, through the Pi's own reader", () => {
        const now = Date.parse('2026-10-09T03:00:00Z');
        const table: Array<[string | undefined, number | null]> = [
            ['motoring', 0],
            ['anchored', 1],
            ['not under command', 2],
            ['restricted manouverability', 3],
            ['constrained by draft', 4],
            ['moored', 5],
            ['aground', 6],
            ['fishing', 7],
            ['sailing', 8],
            ['hazardous material high speed', 9],
            ['hazardous material wing in ground', 10],
            ['ais-sart', 14],
            ['default', 15],
            [undefined, null],
            ['towing < 200m', null],
        ];
        for (const [state, code] of table) {
            const doc = Object.fromEntries([
                classA(now, SHIP, 1_000, { position: { latitude: 50.77, longitude: -1.3 }, state }),
            ]);
            const wire = JSON.parse(JSON.stringify(readAisTargets(doc, null, () => now)));
            expect(aisTargetFromWire(wire[0])!.navStatus, String(state)).toBe(code);
        }
    });
});

describe('end to end: Signal K → the Pi → the phone → the alarms', () => {
    const OWN = { lat: 50.77, lon: -1.3 }; // the Solent

    beforeEach(() => {
        PiTelemetryService.resetForTests();
        AisStore.stop();
    });
    afterEach(() => {
        AisStore.stop();
        PiTelemetryService.resetForTests();
    });

    it('an unknown speed never grades as stopped', async () => {
        const now = Date.now();
        // A ship 0.25 NM dead ahead, her course known, her speed not.
        await throughThePi(now, [
            classA(now, SHIP, 3_000, {
                position: { latitude: OWN.lat + 0.25 / 60, longitude: OWN.lon },
                cogRad: Math.PI,
                state: 'motoring',
            }),
        ]);
        const target = AisStore.getTargets().get(SHIP)!;
        expect(aisSogKn(target.sog)).toBeNull();

        const motion = { sogKn: 6, cogDeg: 0, source: 'nmea' as const, pair: 'offshore' as const };
        const [graded] = gradeCollisionTargets(OWN, motion, localFeatures(), DEFAULT_COLLISION_PREFS, new Set(), now);
        expect(graded.mmsi).toBe(SHIP);
        expect(graded.assessment.rangeOnly).toBe(true);
        expect(graded.assessment.reason).toBe('target-motion-unknown');
        expect(graded.assessment.cpaNm).toBeNull();
        expect(graded.assessment.alarm).toBe(false);

        // What the old wire's 0 made of her: a stopped boat, CPA and all.
        const asStopped = assessCollision(
            { ...OWN, sogKn: 6, cogDeg: 0, pair: 'offshore' },
            { lat: target.lat, lon: target.lon, sogKn: 0, cogDeg: 0, source: 'local' },
        )!;
        expect(asStopped.rangeOnly).toBe(false);
        expect(asStopped.cpaNm).not.toBeNull();
    });

    it("an active SART heard only via the Pi, before its fix, alarms 'Position not yet received'", async () => {
        const now = Date.now();
        await throughThePi(now, [classA(now, SART, 4_000, { state: 'ais-sart' })]);

        const [beacon] = collectDistressBeacons({ own: OWN, ownMmsis: new Set(), internet: [], nowMs: now });
        expect(beacon).toMatchObject({ mmsi: SART, kind: 'sart', state: 'active', source: 'local', sounds: true });
        expect(beacon.lat).toBeNull();
        const lines = distressLines(beacon, now);
        expect(lines.where).toBe('Position not yet received');
        expect(lines.canGoTo).toBe(false);
        // Nothing is drawn at 0,0 for it.
        expect(AisStore.toGeoJSON().features.some((f) => f.properties.mmsi === SART)).toBe(false);
    });

    it('a 97x with no nav status is a caution, not a test, on the card and on the chart', async () => {
        const now = Date.now();
        // A man overboard beacon off Cape Town whose status Signal K never filed.
        await throughThePi(now, [
            classA(now, MOB, 6_000, { position: { latitude: -34.05, longitude: 18.35 }, cogRad: 0, sogMs: 0.4 }),
        ]);
        expect(AisStore.getTargets().get(MOB)!.navStatus).toBeNull();

        const [beacon] = collectDistressBeacons({
            own: { lat: -34.0, lon: 18.3 },
            ownMmsis: new Set(),
            internet: [],
            nowMs: now,
        });
        expect(beacon).toMatchObject({ mmsi: MOB, kind: 'mob', state: 'caution', sounds: false });
        expect(beacon.lat).toBe(-34.05);

        const [feature] = localFeatures();
        expect(targetPresentation(feature.properties as Record<string, unknown>).distressLabel).toMatch(
            /^MOB: UNCLEAR/,
        );
    });

    it('a speed and course Signal K kept from an earlier report never grade as stopped', async () => {
        const now = Date.now();
        // A ship 0.25 NM dead ahead, heard 2 s ago. Her newest report said
        // speed and course not available; Signal K still holds the 0s from her
        // mooring 40 minutes ago.
        await throughThePi(now, [
            [
                `urn:mrn:imo:mmsi:${SHIP}`,
                {
                    mmsi: String(SHIP),
                    navigation: {
                        position: leaf(now, { latitude: OWN.lat + 0.25 / 60, longitude: OWN.lon }, 2_000),
                        speedOverGround: leaf(now, 0, 40 * 60_000),
                        courseOverGroundTrue: leaf(now, 0, 40 * 60_000),
                        state: leaf(now, 'moored', 40 * 60_000),
                    },
                },
            ],
        ]);
        const target = AisStore.getTargets().get(SHIP)!;
        expect(aisSogKn(target.sog)).toBeNull();
        expect(aisCogDeg(target.cog)).toBeNull();
        expect(target.navStatus).toBeNull();

        const motion = { sogKn: 6, cogDeg: 0, source: 'nmea' as const, pair: 'offshore' as const };
        const [graded] = gradeCollisionTargets(OWN, motion, localFeatures(), DEFAULT_COLLISION_PREFS, new Set(), now);
        expect(graded.assessment.rangeOnly).toBe(true);
        expect(graded.assessment.reason).toBe('target-motion-unknown');
        expect(graded.assessment.cpaNm).toBeNull();
    });

    it('an N2K SART switched from ACTIVE to TEST stops sounding: her old status does not outvote the newer text', async () => {
        const now = Date.now();
        // n2k-signalk writes no state for status 15, so 'ais-sart' from her
        // activation 30 minutes ago sits under each new position; 'SART TEST'
        // was heard 20 s ago, between two position reports.
        await throughThePi(now, [
            [
                `urn:mrn:imo:mmsi:${SART}`,
                {
                    mmsi: String(SART),
                    navigation: {
                        position: leaf(now, { latitude: 60.39, longitude: 5.32 }, 2_000), // off Bergen
                        state: leaf(now, 'ais-sart', 30 * 60_000),
                    },
                    communication: { ais: { safetyRelatedBroadcast: leaf(now, 'SART TEST', 20_000) } },
                },
            ],
        ]);
        expect(AisStore.getTargets().get(SART)!.navStatus).toBeNull();
        const [beacon] = collectDistressBeacons({
            own: { lat: 60.4, lon: 5.3 },
            ownMmsis: new Set(),
            internet: [],
            nowMs: now,
        });
        expect(beacon).toMatchObject({ mmsi: SART, kind: 'sart', state: 'test', sounds: false });
    });

    it('a SART tested before its fix is a test, not the activation left from two hours ago', async () => {
        const now = Date.now();
        await throughThePi(now, [
            [
                `urn:mrn:imo:mmsi:${SART}`,
                {
                    mmsi: String(SART),
                    navigation: { state: leaf(now, 'ais-sart', 2 * 3_600_000) },
                    communication: { ais: { safetyRelatedBroadcast: leaf(now, 'SART TEST', 5_000) } },
                },
            ],
        ]);
        const [beacon] = collectDistressBeacons({ own: OWN, ownMmsis: new Set(), internet: [], nowMs: now });
        expect(beacon).toMatchObject({ mmsi: SART, kind: 'sart', state: 'test', sounds: false, lat: null });
    });

    it("a beacon's own text from an N2K-fed Pi reaches the distress watch, before any position or status", async () => {
        const now = Date.now();
        // Off Fiji, across the antimeridian: an EPIRB-AIS heard only by its message 14.
        await throughThePi(now, [
            [
                `urn:mrn:imo:mmsi:${EPIRB}`,
                {
                    mmsi: String(EPIRB),
                    communication: { ais: { safetyRelatedBroadcast: leaf(now, 'EPIRB ACTIVE', 2_000) } },
                },
            ],
        ]);
        expect(AisStore.getSafetyText(EPIRB)).toEqual({ text: 'EPIRB ACTIVE', at: now - 2_000 });

        const [beacon] = collectDistressBeacons({
            own: { lat: -17.0, lon: 179.9 },
            ownMmsis: new Set(),
            internet: [],
            nowMs: now,
        });
        expect(beacon).toMatchObject({ mmsi: EPIRB, kind: 'epirb', state: 'active', sounds: true, lat: null });
        expect(distressLines(beacon, now).where).toBe('Position not yet received');

        // The next read of the same text changes nothing.
        await PiTelemetryService.pollOnce();
        expect(AisStore.getSafetyText(EPIRB)).toEqual({ text: 'EPIRB ACTIVE', at: now - 2_000 });
    });
});
