import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    canPublishInstruments,
    publicInstrumentSnapshot,
    redactPublicTelemetry,
    redactPublicTrackPoint,
} from '../supabase/functions/_shared/public-instruments';

const now = Date.parse('2026-09-07T02:00:00Z');
const options = {
    enabled: true,
    boatId: 'boat-a',
    requestedTrip: 'latest',
    visibilityReadable: true,
    activeVoyageAllowed: true,
};
const row = {
    boat_id: 'boat-a',
    owner_id: 'owner-a',
    source: 'pi',
    reported_at: new Date(now).toISOString(),
    lat: -23.9,
    lon: 152.4,
    device_label: 'private',
    extra: { secret: 'private' },
    sog_kts: 0,
    voltage_v: 12.8,
    pressure_hpa: 1013.2,
};

describe('public instruments consent and provenance', () => {
    it('exposes only fresh bounded house SOC and same-sensor three-hour pressure history', () => {
        const snapshot = publicInstrumentSnapshot(
            {
                ...row,
                extra: {
                    house_battery_soc_pct: 0,
                    house_battery_at: now,
                    pressure_at: now,
                    pressure_3h_hpa: 1017,
                    pressure_3h_at: now - 10_800_000,
                    ship_time_zone: 'Australia/Brisbane',
                    crew_name: 'PRIVATE',
                },
            },
            'boat-a',
            now,
        )!;
        expect(snapshot).toMatchObject({
            house_battery_soc: 0,
            pressure_3h: 1017,
            ship_time_zone: 'Australia/Brisbane',
        });
        expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
        expect(
            publicInstrumentSnapshot(
                {
                    ...row,
                    extra: {
                        house_battery_soc_pct: 100.1,
                        house_battery_at: now,
                        pressure_at: now,
                        pressure_3h_hpa: 1017,
                        pressure_3h_at: now - 3_600_000,
                        ship_time_zone: 'bad-zone',
                    },
                },
                'boat-a',
                now,
            ),
        ).toMatchObject({ house_battery_soc: null, pressure_3h: null, ship_time_zone: null });
    });
    it('fresh GPS cannot revive stale extra sensors', () => {
        expect(
            publicInstrumentSnapshot(
                {
                    ...row,
                    heel_deg: 4,
                    pitch_deg: 2,
                    extra: {
                        house_battery_soc_pct: 94.6,
                        house_battery_at: now - 180_001,
                        pressure_at: now - 180_001,
                        heel_at: now - 30_001,
                        pitch_at: now + 5_001,
                    },
                },
                'boat-a',
                now,
            ),
        ).toMatchObject({ house_battery_soc: null, baro: null, heel: null, pitch: null });
    });
    it.each([false, null, undefined, 'true', 1])('fails closed for consent %s', (enabled) => {
        expect(canPublishInstruments({ ...options, enabled })).toBe(false);
    });
    it.each(['latest', '', null])('allows a moored/no-trip snapshot in %s mode', (requestedTrip) => {
        expect(canPublishInstruments({ ...options, requestedTrip })).toBe(true);
    });
    it.each(['all-diary', 'historical-id'])('does not attach today’s instruments to %s', (requestedTrip) => {
        expect(canPublishInstruments({ ...options, requestedTrip })).toBe(false);
    });
    it('requires a boat and readable, non-hidden voyage authority', () => {
        expect(canPublishInstruments({ ...options, boatId: null })).toBe(false);
        expect(canPublishInstruments({ ...options, visibilityReadable: false })).toBe(false);
        expect(canPublishInstruments({ ...options, activeVoyageAllowed: false })).toBe(false);
    });
    it('allowlists real sensors, preserves zero, and never exposes location or device metadata', () => {
        const snapshot = publicInstrumentSnapshot(row, 'boat-a', now);
        expect(snapshot).toMatchObject({ sog: 0, voltage: 12.8, baro: 1013.2, depth: null });
        for (const key of ['lat', 'lon', 'boat_id', 'owner_id', 'device_label', 'extra'])
            expect(snapshot).not.toHaveProperty(key);
    });
    it('rejects cross-boat, absent, stale, invalid and materially future snapshots', () => {
        expect(publicInstrumentSnapshot(row, 'boat-b', now)).toBeNull();
        expect(publicInstrumentSnapshot(null, 'boat-a', now)).toBeNull();
        for (const time of [now - 600_000, now + 60_001, NaN]) {
            expect(
                publicInstrumentSnapshot(
                    { ...row, reported_at: Number.isFinite(time) ? new Date(time).toISOString() : 'bad' },
                    'boat-a',
                    now,
                ),
            ).toBeNull();
        }
    });
    it('does not convert invalid numbers or strings into measurements', () => {
        expect(
            publicInstrumentSnapshot({ ...row, sog_kts: NaN, voltage_v: '12.8', rpm: Infinity }, 'boat-a', now),
        ).toMatchObject({ sog: null, voltage: null, rpm: null });
    });
    it('removes readings from alternate track/telemetry responses while retaining published geometry', () => {
        expect(
            redactPublicTrackPoint({
                lat: 1,
                lon: 2,
                timestamp: 'time',
                pressure: 1013,
                speed_kts: 7,
                unexpected_sensor: 9,
            }),
        ).toMatchObject({ lat: 1, lon: 2, timestamp: 'time', pressure: null, speed_kts: null });
        expect(redactPublicTrackPoint({ unexpected_sensor: 9 })).not.toHaveProperty('unexpected_sensor');
        expect(redactPublicTelemetry({ lat: 1, lon: 2, baro: 1013, sog: 7 })).toMatchObject({
            lat: 1,
            lon: 2,
            baro: null,
            sog: null,
        });
        expect(redactPublicTelemetry(null)).toBeNull();
    });
    it('wires default-off migration, boat-filtered lookup, final redaction and no-store responses', () => {
        const migration = readFileSync('supabase/migrations/20260907120000_public_instruments_opt_in.sql', 'utf8');
        expect(migration).toContain('BOOLEAN NOT NULL DEFAULT FALSE');
        const source = readFileSync('supabase/functions/voyage-log/index.ts', 'utf8');
        expect(source).toContain('if (instrumentsAllowed && boatId)');
        expect(
            source.slice(source.indexOf(".from('vessel_telemetry')"), source.indexOf('if (!instrumentError)')),
        ).toContain(".eq('boat_id', boatId)");
        expect(source).toContain('track: instrumentsEnabled ? track : track.map(redactPublicTrackPoint)');
        expect(source).toContain('telemetry: instrumentsEnabled ? telemetry : redactPublicTelemetry(telemetry)');
        expect(source).toContain("'Cache-Control': 'no-store'");
    });
});
