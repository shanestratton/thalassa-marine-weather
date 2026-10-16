import { describe, expect, it } from 'vitest';
import { RadarFeed } from '../utils/radarFeed';
import { radarDisplayRows, radarAisEvidence } from '../services/radar/radarPresentation';
import { DEFAULT_COLLISION_PREFS } from '../utils/collisionRule';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function picture() {
    const f = new RadarFeed('gateway:generated');
    for (const body of [
        'GPRMC,120000,A,0000.000,N,17959.940,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,0,R,10,180,R,0,6,N,<img src=x onerror=alert(1)>,T,,120000,A',
    ])
        f.ingest(frame(body), T, T);
    return {
        version: 1,
        contacts: f.contacts(T),
        feeds: [
            {
                feedId: f.feedId,
                source: 'gateway' as const,
                ownship: f.ownshipSnapshot(),
                lastFrameAt: T,
                lastTargetAt: T,
            },
        ],
    };
}
describe('private real-sensor presentation', () => {
    it('one proven AIS match renders one combined row with independent original radar evidence and worse risk', () => {
        const p = picture(),
            c = p.contacts[0];
        const ais: GeoJSON.Feature<GeoJSON.Point> = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.position!.lon, c.position!.lat] },
            properties: {
                mmsi: 123456789,
                source: 'local',
                name: 'Generated ship',
                sog: c.motion!.sogKn,
                cog: c.motion!.cogTrueDeg,
                lastUpdated: T,
            },
        };
        const copy = JSON.stringify(p),
            rows = radarDisplayRows(p, [ais], T);
        expect(rows).toHaveLength(1);
        expect(rows[0].ais).toBe(ais);
        expect(rows[0].name).toBe('Generated ship');
        expect(rows[0].assessment!.alarm).toBe(true);
        expect(rows[0].contact.contactKey).toBe(c.contactKey);
        expect(JSON.stringify(p)).toBe(copy);
        const higher = { ...rows[0].assessment!, closeQuarters: true };
        expect(
            radarDisplayRows(p, [ais], T, DEFAULT_COLLISION_PREFS, false, new Map([[123456789, higher]]))[0].assessment,
        ).toBe(higher);
    });
    it('does not turn stale radar, app-reported positions or approximate age into an association', () => {
        const p = picture(),
            c = p.contacts[0];
        const feature: GeoJSON.Feature<GeoJSON.Point> = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [c.position!.lon, c.position!.lat] },
            properties: {
                mmsi: 123456789,
                source: 'app',
                sog: c.motion!.sogKn,
                cog: c.motion!.cogTrueDeg,
                lastUpdated: T,
                staleMinutes: 0,
            },
        };
        expect(radarAisEvidence([feature])).toEqual([]);
        expect(radarDisplayRows(p, [feature], T)[0].ais).toBeNull();
        feature.properties = { ...feature.properties, source: 'local', lastUpdated: undefined };
        expect(radarDisplayRows(p, [feature], T)[0].ais).toBeNull();
        expect(radarDisplayRows(p, [], T + 16000)[0]).toMatchObject({
            ais: null,
            rangeNm: null,
            bearingDeg: null,
            grade: null,
        });
    });
});
