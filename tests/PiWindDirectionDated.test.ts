/**
 * Her true wind DIRECTION carries its own reading time, from the Pi's Signal K
 * leaf to Obs's close-in wind ashore (Pi update 1, build 125, 125-10).
 *
 * Until now only the TWS sample was dated (extra.wind_tws_at_ms), and the TWD
 * rode on that date. On a boat whose TWD comes from the gateway's MDA, which
 * needs heading, while TWS comes from VWT, a heading dropout freezes the TWD
 * beside a fresh TWS, and the phone painted the frozen direction as hers now.
 * The Pi now sends the TWD leaf's own time (extra.wind_twd_at_ms), and the
 * phone holds the TWD to the cloud lane's 60 s gate on it. An older Pi sends
 * no TWD time, and its TWD still rides on the TWS date, as before.
 *
 * Real: the Pi's reader and publisher body, the relay's parser, the phone's
 * wire parser and the close-in wind's cloud reading. Every position and
 * reading is fictional: a boat off Cape Town and one in Chesapeake Bay.
 */
import { describe, expect, it } from 'vitest';
import { readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import { snapshotFromWire } from '../services/telemetryWire';
import { CLOUD_WIND_MAX_AGE_MS, pickCloudTrueWind, type CloudWindRow } from '../components/map/closeInWind';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');
const RAD = Math.PI / 180;
const iso = (ms: number) => new Date(ms).toISOString();

/** A Signal K self document: TWS (VWT) and TWD (MDA) each on their own leaf clock. */
function selfDoc(opts: {
    at: { lat: number; lon: number };
    twsAt: number;
    twdAt: number | null;
    twd?: number;
    twa?: number;
    headingAt?: number | null;
    heading?: number;
}) {
    const leaf = (value: number, at: number | null) => ({
        value,
        $source: 'ydwg-tcp.YD',
        ...(at === null ? {} : { timestamp: iso(at) }),
    });
    return {
        navigation: {
            datetime: { value: iso(NOW) },
            position: { value: { latitude: opts.at.lat, longitude: opts.at.lon }, timestamp: iso(NOW - 1_000) },
            ...(opts.headingAt === null || opts.headingAt === undefined
                ? {}
                : { headingTrue: leaf((opts.heading ?? 0) * RAD, opts.headingAt) }),
        },
        environment: {
            wind: {
                speedTrue: leaf(7.2, opts.twsAt), // 14.0 kt
                angleTrueWater: leaf((opts.twa ?? -40) * RAD, opts.twsAt),
                directionTrue: leaf((opts.twd ?? 200) * RAD, opts.twdAt),
            },
        },
    };
}

const CAPE_TOWN = { lat: -34.05, lon: 18.35 };
const CHESAPEAKE = { lat: 36.95, lon: -76.3 };

/** Pi → relay → phone, as the cloud lane carries it; the LAN reads the Pi's body directly. */
function overTheWire(doc: unknown, via: 'cloud' | 'lan') {
    const body = buildTelemetryBody(readTelemetrySnapshot(doc, () => NOW)!, 'test-vessel');
    const wire = via === 'cloud' ? parseTelemetryBody(body, NOW) : { ok: true as const, row: body };
    if (!wire.ok) throw new Error(wire.error);
    return snapshotFromWire(wire.row as unknown as Record<string, unknown>, via)!.snapshot;
}

/** Her cloud row's wind fields, as the boat chain hands them to the close-in wind. */
function cloudRow(snapshot: ReturnType<typeof overTheWire>): CloudWindRow {
    const row: CloudWindRow = {};
    for (const [key, value] of [
        ['twsKts', snapshot.twsKts],
        ['twdDeg', snapshot.twdDeg],
        ['twaDeg', snapshot.twaDeg],
        ['windSampleAt', snapshot.windSampleAt],
        ['twdSampleAt', snapshot.twdSampleAt],
        ['headingTrueDeg', snapshot.headingTrueDeg],
        ['headingTrueAt', snapshot.headingTrueAt],
    ] as const) {
        if (typeof value === 'number') row[key] = value;
    }
    return row;
}

describe('the TWD reading time, Pi to phone', () => {
    it('arrives over the cloud relay and the LAN as the TWD leaf’s own time', () => {
        const doc = selfDoc({ at: CAPE_TOWN, twsAt: NOW - 1_500, twdAt: NOW - 2_500 });
        for (const via of ['cloud', 'lan'] as const) {
            const snapshot = overTheWire(doc, via);
            expect(snapshot.twdSampleAt).toBe(NOW - 2_500);
            expect(snapshot.windSampleAt).toBe(NOW - 1_500);
        }
    });

    it('a fresh TWD is her wind direction ashore', () => {
        const row = cloudRow(overTheWire(selfDoc({ at: CAPE_TOWN, twsAt: NOW - 1_500, twdAt: NOW - 2_500 }), 'cloud'));
        expect(pickCloudTrueWind(row, NOW)).toEqual({
            kt: expect.closeTo(14, 1),
            fromDeg: expect.closeTo(200, 6),
            stale: false,
        });
    });

    it('a TWD frozen beside a fresh TWS is not her direction now: a fresh heading plus the TWA, else no boat wind', () => {
        const frozen = NOW - 5 * 60_000;
        // A fresh true heading: the direction comes from heading + signed TWA, not the frozen TWD.
        const withHeading = cloudRow(
            overTheWire(
                selfDoc({
                    at: CHESAPEAKE,
                    twsAt: NOW - 1_000,
                    twdAt: frozen,
                    twd: 200,
                    twa: 30,
                    heading: 350,
                    headingAt: NOW - 1_000,
                }),
                'cloud',
            ),
        );
        expect(withHeading.twdSampleAt).toBe(frozen);
        const wind = pickCloudTrueWind(withHeading, NOW)!;
        expect(wind.fromDeg).toBeCloseTo(20, 6);
        // No heading either: no direction, and above calm that is no boat wind (Obs paints the model).
        const noHeading = cloudRow(
            overTheWire(selfDoc({ at: CHESAPEAKE, twsAt: NOW - 1_000, twdAt: frozen }), 'cloud'),
        );
        expect(pickCloudTrueWind(noHeading, NOW)).toBeNull();
    });

    it('holds the TWD to the cloud lane’s 60 s gate on its own clock, and refuses one from the future', () => {
        const at = (twdAt: number) =>
            pickCloudTrueWind(
                cloudRow(overTheWire(selfDoc({ at: CAPE_TOWN, twsAt: NOW - 1_000, twdAt }), 'cloud')),
                NOW,
            );
        expect(CLOUD_WIND_MAX_AGE_MS).toBe(60_000);
        expect(at(NOW - 60_000)?.fromDeg).toBeCloseTo(200, 6);
        expect(at(NOW - 60_001)).toBeNull();
        expect(at(NOW + 5_000)).toBeNull();
    });

    it('an older Pi, which dates no TWD: the TWD rides on the TWS date, as it always did', () => {
        const doc = selfDoc({ at: CAPE_TOWN, twsAt: NOW - 1_000, twdAt: NOW - 1_000 });
        const body = buildTelemetryBody(readTelemetrySnapshot(doc, () => NOW)!, 'older-pi');
        delete (body.extra as Record<string, unknown>).wind_twd_at_ms;
        const relayed = parseTelemetryBody(body, NOW);
        if (!relayed.ok) throw new Error(relayed.error);
        const snapshot = snapshotFromWire(relayed.row as unknown as Record<string, unknown>, 'cloud')!.snapshot;
        expect(snapshot.twdSampleAt).toBeUndefined();
        expect(pickCloudTrueWind(cloudRow(snapshot), NOW)?.fromDeg).toBeCloseTo(200, 6);
    });
});
