import { describe, it, expect } from 'vitest';
import { normaliseInternetAisFeature } from '../components/map/useAisStreamLayer';
const now = Date.parse('2026-10-16T00:00:00Z');
const feature = (dataSource?: string) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [1, 50] },
    properties: { mmsi: 123456789, source: 'local', dataSource, updatedAt: new Date(now).toISOString() },
});
describe('per-row internet AIS attribution', () => {
    it.each(['AISHub', 'Relayed receiver', 'AISStream'])(
        'preserves%s as informational network transport, never this boat’s receiver',
        (source) => {
            expect(normaliseInternetAisFeature(feature(source), now)?.properties).toMatchObject({
                source: 'cloud',
                dataSource: source,
                informational: true,
            });
        },
    );
    it('does not infer AISHub when a row has no provenance', () => {
        expect(normaliseInternetAisFeature(feature(), now)?.properties?.dataSource).toBe('Internet AIS');
    });
    it('carries actual draught/ETA and message14 clocks without manufacturing them', () => {
        const input = feature('AISHub');
        Object.assign(input.properties, {
            draught: 1.8,
            eta: '10-20 12:00',
            safetyText: 'SART ACTIVE',
            safetyTextAt: new Date(now - 60000).toISOString(),
        });
        expect(normaliseInternetAisFeature(input, now)?.properties).toMatchObject({
            draught: 1.8,
            eta: '10-20 12:00',
            safetyText: 'SART ACTIVE',
            safetyTextAt: now - 60000,
        });
    });
});
