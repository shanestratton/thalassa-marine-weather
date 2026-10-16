import { describe, expect, it } from 'vitest';
import { piTrackCsv, piTrackGpx, piTrackMapEntries, trackGraph } from '../services/piTrackReplay';
import type { PiTrackHistory, PiTrackHistoryPoint } from '../services/piTrackHistory';
const from = Date.parse('2026-01-01T00:00:00Z');
const point = (id: number, at: number, over = {}): PiTrackHistoryPoint => ({
    sample_id: id,
    at_ms: from + at,
    lat: 0,
    lon: id % 2 ? 179.9 : -179.9,
    reason: 'first',
    sog_kts: 0,
    cog_deg: 0,
    stw_kts: null,
    hdg_deg: null,
    depth_m: null,
    tws_kts: null,
    twd_deg: null,
    water_temp_c: null,
    pressure_hpa: null,
    heel_deg: null,
    engine_rpm: null,
    twa_deg: null,
    ...over,
});
const history = (points: PiTrackHistoryPoint[], truncated = false): PiTrackHistory => ({
    points,
    truncated,
    from,
    to: from + 3_600_000,
    nextCursor: null,
    snapshot: 20,
});
describe('logged track presentation and exports', () => {
    it('does not join nulls or long gaps; keeps zero and a transient peak at its actual time', () => {
        const result = trackGraph(
            history([
                point(1, 0),
                point(2, 60_000, { sog_kts: 25 }),
                point(3, 120_000, { sog_kts: null }),
                point(4, 180_000),
                point(5, 900_000),
            ]),
            'sog_kts',
        );
        expect(result.count).toBe(4);
        expect(result.minimum).toBe(0);
        expect(result.maximum).toBe(25);
        expect(result.paths).toHaveLength(3);
        expect(trackGraph(history([point(1, 0)]), 'pressure_hpa')).toMatchObject({
            paths: [],
            count: 0,
            minimum: null,
        });
    });
    it('maps only logged measurements and preserves dateline coordinates and absolute UTC', () => {
        const entries = piTrackMapEntries(history([point(1, 0), point(2, 1000, { tws_kts: 12, twd_deg: 0 })]));
        expect(entries.map((entry) => entry.longitude)).toEqual([179.9, -179.9]);
        expect(entries[0]).toMatchObject({
            timestamp: '2026-01-01T00:00:00.000Z',
            speedKts: 0,
            positionSource: 'vessel-pi-log',
        });
        expect(entries[0].windSpeed).toBeUndefined();
        expect(entries[0].pressure).toBeUndefined();
        expect(entries[1].windDirection).toBe('0 deg true');
    });
    it('CSV states partial scope and units, preserves missing cells, and neutralizes formula text', () => {
        const text = piTrackCsv(history([point(1, 0, { reason: '=HYPERLINK("evil")', heel_deg: -8 })], true));
        expect(text).toContain('partial_window,timestamp_utc,sample_id,lat,lon,reason,sog_kts');
        expect(text).toContain('"true","2026-01-01T00:00:00.000Z"');
        expect(text).toContain('"\'=HYPERLINK(""evil"")"');
        expect(text).toContain('"-8"');
        const parser = text.split('\r\n')[1];
        expect(parser).not.toContain('undefined');
        expect(parser).not.toContain('null');
    });
    it('GPX is valid XML with escaped text, explicit partial metadata, separate gaps and no invented values', () => {
        const text = piTrackGpx(history([point(1, 0, { reason: '<private & quoted>' }), point(2, 900_000)], true));
        const document = new DOMParser().parseFromString(text, 'application/xml');
        expect(document.querySelector('parsererror')).toBeNull();
        expect(document.getElementsByTagName('trkseg')).toHaveLength(2);
        expect(document.getElementsByTagName('trkpt')[1].getAttribute('lon')).toBe('-179.9');
        expect(text).toContain('PARTIAL: remaining data is not included');
        expect(text).toContain('&lt;private &amp; quoted&gt;');
        expect(text).toContain('<thalassa:sog_kts>0</thalassa:sog_kts>');
        expect(text).not.toContain('<thalassa:pressure_hpa>');
        expect(text).toContain('2026-01-01T00:00:00.000Z');
    });
});
