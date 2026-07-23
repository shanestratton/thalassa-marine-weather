import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTideStationPopupHtml } from '../components/map/useTideStationLayer';

describe('tide station proxy boundary', () => {
    it('keeps the commercial WorldTides credential out of the client bundle', () => {
        const source = readFileSync(resolve(process.cwd(), 'components/map/useTideStationLayer.ts'), 'utf8');
        expect(source).toContain('/functions/v1/proxy-tides');
        expect(source).not.toContain('VITE_WORLDTIDES_API_KEY');
        expect(source).not.toContain('CapacitorHttp');
        expect(source).not.toContain('worldtides.info/api');
    });

    it('returns one balanced popup root for Mapbox', () => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildTideStationPopupHtml(
            { id: 'station-1', name: 'Brisbane Bar', lat: -27.3, lon: 153.2, distance: 2 },
            [{ date: '2026-07-24T00:00:00.000Z', height: 1.2, type: 'High' }],
            false,
        );
        expect(wrapper.children).toHaveLength(1);
        expect(wrapper.querySelectorAll('div').length).toBeGreaterThan(1);
    });
});
