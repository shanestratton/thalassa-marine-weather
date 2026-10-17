import { describe, expect, it } from 'vitest';
import { readOwnInstrumentSource } from '../pi-cache/src/ownBoatSkill/source';
import { decodeOwnWindForecast } from '../pi-cache/src/ownBoatSkill/forecast';
import { wxFixture } from './fixtures/wxPublishedFixture';
import type { OwnBoatModel } from '../utils/ownBoatSkill';
const NOW = Date.parse('2026-10-16T12:30:00Z');
const document = () => ({
    uuid: 'urn:mrn:imo:mmsi:000000001',
    timestamp: new Date(NOW).toISOString(),
    navigation: {
        position: {
            value: { latitude: -27.2, longitude: 153.1 },
            timestamp: new Date(NOW - 2000).toISOString(),
            $source: 'nmea0183.GP',
        },
    },
    environment: {
        wind: { speedTrue: { value: 0, timestamp: new Date(NOW - 1000).toISOString(), $source: 'nmea0183.WI' } },
    },
});
const decode = (v = wxFixture(), model: OwnBoatModel = 'dwd_icon', cell = '-2725_15300', captured = NOW) =>
    decodeOwnWindForecast(
        Buffer.from(JSON.stringify([{ payload: v.payload, run_at: v.runAt }])),
        model,
        cell,
        captured,
    );
describe('private instrument admission', () => {
    it('retains calm zero and the true-wind leaf original clock independently of GPS/receipt clocks', () => {
        const source = readOwnInstrumentSource(document(), NOW)!;
        expect(source.sample).toMatchObject({
            windMps: 0,
            at: NOW - 1000,
            receivedAt: NOW,
            positionAt: NOW - 2000,
            cell: '-2725_15300',
        });
        expect(JSON.parse(source.sample.rawWind).timestamp).toBe(new Date(NOW - 1000).toISOString());
        expect(source.windSourceKey).toMatch(/^[a-f0-9]{64}$/);
        expect(source.positionSourceKey).not.toBe(source.windSourceKey);
    });
    it.each([
        'parent-time',
        'stale-wind',
        'future-wind',
        'unknown-source',
        'stale-gps',
        'future-gps',
        'missing-self',
        'apparent-only',
        'nonfinite',
    ])('refuses %s instead of inventing a measured envelope', (kind) => {
        const d = document();
        if (kind === 'parent-time') delete (d.environment.wind.speedTrue as { timestamp?: string }).timestamp;
        if (kind === 'stale-wind') d.environment.wind.speedTrue.timestamp = new Date(NOW - 20001).toISOString();
        if (kind === 'future-wind') d.environment.wind.speedTrue.timestamp = new Date(NOW + 1).toISOString();
        if (kind === 'unknown-source') d.environment.wind.speedTrue.$source = '';
        if (kind === 'stale-gps') d.navigation.position.timestamp = new Date(NOW - 13001).toISOString();
        if (kind === 'future-gps') d.navigation.position.timestamp = new Date(NOW + 1).toISOString();
        if (kind === 'missing-self') d.uuid = '';
        if (kind === 'apparent-only') delete (d.environment.wind as { speedTrue?: unknown }).speedTrue;
        if (kind === 'nonfinite') d.environment.wind.speedTrue.value = NaN;
        expect(readOwnInstrumentSource(d, NOW)).toBeNull();
    });
    it('changes the confirmation identity for another boat/source, without manufacturing a vessel association', () => {
        const a = readOwnInstrumentSource(document(), NOW)!;
        for (const changed of ['self', 'wind', 'position']) {
            const d = document();
            if (changed === 'self') d.uuid = 'urn:mrn:imo:mmsi:000000002';
            if (changed === 'wind') d.environment.wind.speedTrue.$source = 'nmea0183.WI2';
            if (changed === 'position') d.navigation.position.$source = 'nmea0183.GP2';
            const b = readOwnInstrumentSource(d, NOW)!;
            expect([b.selfKey, b.windSourceKey, b.positionSourceKey]).not.toEqual([
                a.selfKey,
                a.windSourceKey,
                a.positionSourceKey,
            ]);
        }
    });
});
describe('private issued own-server wind captures', () => {
    it('keeps original raw bytes/hash/run/domain/cell and only future valid hours, independent of stored current weather', () => {
        const result = decode()!;
        expect(result.model).toBe('dwd_icon');
        expect(result.runAt).toBe(Date.parse('2026-10-16T06:00:00Z'));
        expect(result.capturedAt).toBe(NOW);
        expect(result.points[0]).toEqual([Date.parse('2026-10-16T13:00:00Z'), 23 / 3.6]);
        expect(result.points.every(([at]) => at > NOW)).toBe(true);
        expect(result.raw).toEqual(
            Buffer.from(JSON.stringify([{ payload: wxFixture().payload, run_at: wxFixture().runAt }])),
        );
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
    it('does not borrow IFS 0.25 degree data for IFS9km or a different forecast cell', () => {
        expect(decode(wxFixture('ecmwf_ifs025'), 'ecmwf_ifs025')).not.toBeNull();
        expect(decode(wxFixture('ecmwf_ifs025'), 'ecmwf_ifs' as OwnBoatModel)).toBeNull();
        expect(decode(wxFixture(), 'dwd_icon', '-2750_15300')).toBeNull();
    });
    it.each([
        'hindcast',
        'wrong-run',
        'stale',
        'future',
        'short-source',
        'wrong-source',
        'wrong-resolution',
        'wrong-units',
        'duplicate-hour',
        'naive-time',
        'short-array',
        'null-near-future',
    ])('refuses %s original provenance', (kind) => {
        const f = wxFixture();
        const p = f.payload.thalassa_provenance;
        if (kind === 'hindcast') p.version = 1;
        if (kind === 'wrong-run') p.source_runs[0].run_at = '2026-10-16T03:00:00Z';
        if (kind === 'stale') f.runAt = p.run_at = p.source_runs[0].run_at = '2026-10-15T09:00:00Z';
        if (kind === 'future') f.runAt = p.run_at = p.source_runs[0].run_at = '2026-10-16T15:00:00Z';
        if (kind === 'short-source') p.source_runs[0].data_end_at = '2026-10-16T18:00:00Z';
        if (kind === 'wrong-source') p.source = 'paid-retrospective';
        if (kind === 'wrong-resolution') p.cell_degrees = 0.125;
        if (kind === 'wrong-units') f.payload.hourly_units.wind_speed_10m = 'kn';
        if (kind === 'duplicate-hour') f.payload.hourly.time[1] = f.payload.hourly.time[0];
        if (kind === 'naive-time') f.payload.hourly.time[0] = '2026-10-16T00:00';
        if (kind === 'short-array') f.payload.hourly.wind_speed_10m.pop();
        if (kind === 'null-near-future') f.payload.hourly.wind_speed_10m[13] = null;
        expect(decode(f)).toBeNull();
    });
    it('holds mixed GFS seamless issuer clocks and refuses oversized original bodies', () => {
        const f = wxFixture('gfs_seamless');
        expect(decode(f, 'gfs_seamless')).not.toBeNull();
        f.payload.thalassa_provenance.source_runs[1].run_at = '2026-10-16T09:00:00Z';
        expect(decode(f, 'gfs_seamless')).toBeNull();
        expect(decodeOwnWindForecast(Buffer.alloc(131073), 'dwd_icon', '-2725_15300', NOW)).toBeNull();
    });
});
