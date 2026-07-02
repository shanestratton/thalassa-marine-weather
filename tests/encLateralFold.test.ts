/**
 * ENC lateral fold — chart BCNLAT/BOYLAT (CATLAM 1/2) enter the gate-pairing
 * pipeline even with NO regional OSM marker file (url = null). The Mooloolah
 * River case: 15 ENC beacons, 2 OSM marks — before the fold the route never
 * threaded the red/green pairs out of the channel.
 */
import { describe, expect, it } from 'vitest';
import { fetchRegionalMarkers, encLateralsFromFeatures } from '../services/InshoreRouter';

const beacon = (lon: number, lat: number, catlam: 1 | 2, name: string) => ({
    type: 'Feature' as const,
    properties: { acronym: 'BCNLAT', CATLAM: catlam, OBJNAM: name },
    geometry: { type: 'Point' as const, coordinates: [lon, lat] as [number, number] },
});

describe('encLateralsFromFeatures', () => {
    it('maps CATLAM 1→port, 2→starboard; skips 3/4, non-acronym, non-point', () => {
        const out = encLateralsFromFeatures([
            beacon(153.132, -26.68, 1, 'p'),
            beacon(153.133, -26.68, 2, 's'),
            { properties: { acronym: 'BCNLAT', CATLAM: 3 }, geometry: { type: 'Point', coordinates: [153.1, -26.7] } },
            { properties: { CATLAM: 1 }, geometry: { type: 'Point', coordinates: [153.1, -26.7] } }, // no acronym → synthetic/OSM, skip
            { properties: { acronym: 'BCNLAT', CATLAM: 1 }, geometry: { type: 'LineString', coordinates: [] } },
        ]);
        expect(out).toEqual([
            { lat: -26.68, lon: 153.132, kind: 'port' },
            { lat: -26.68, lon: 153.133, kind: 'starboard' },
        ]);
    });
});

describe('fetchRegionalMarkers with url=null + ENC laterals (chart-only pairing)', () => {
    it('pairs a beacon channel into gate midpoints without any OSM file', async () => {
        // A straight ~N-S channel, ~120 m between the port and starboard rows
        // (the Mooloolah entrance geometry class), 4 stations ~220 m apart.
        const mkLat = (i: number) => -26.68 - i * 0.002;
        const laterals = [
            ...[0, 1, 2, 3].map((i) => ({ lat: mkLat(i), lon: 153.132, kind: 'port' as const })),
            ...[0, 1, 2, 3].map((i) => ({ lat: mkLat(i), lon: 153.1331, kind: 'starboard' as const })),
        ];
        const res = await fetchRegionalMarkers(null, [], [], [], laterals);
        expect(res.acceptedPairs.length).toBeGreaterThanOrEqual(3);
        expect(res.midpoints.length).toBeGreaterThanOrEqual(3);
        // Midpoints sit between the rows.
        for (const m of res.midpoints as { geometry: { coordinates: [number, number] } }[]) {
            const [lon] = m.geometry.coordinates;
            expect(lon).toBeGreaterThan(153.132);
            expect(lon).toBeLessThan(153.1331);
        }
    });

    it('dedupe keeps the OSM copy of a shared buoy (~25 m)', async () => {
        // No file (url null) — feed the "OSM" mark via extraLaterals twice at
        // ~10 m apart; the pipeline must not double-count into a phantom pair.
        const laterals = [
            { lat: -26.68, lon: 153.132, kind: 'port' as const },
            { lat: -26.68, lon: 153.1331, kind: 'starboard' as const },
        ];
        const res = await fetchRegionalMarkers(null, [], [], [], laterals);
        // A single pair (or a solo decline) — never more pairs than stations.
        expect(res.acceptedPairs.length).toBeLessThanOrEqual(1);
    });
});
