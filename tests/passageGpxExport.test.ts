/**
 * passageGpxExport — Unit tests for passage GPX export from isochrone data.
 */
import { describe, it, expect } from 'vitest';
import { exportBasicPassageGPX } from '../services/passageGpxExport';

describe('exportBasicPassageGPX', () => {
    const departure = { lat: -27.5, lon: 153.0, name: 'Brisbane' };
    const arrival = { lat: -20.0, lon: 148.7, name: 'Airlie Beach' };
    const departureTime = '2026-03-25T08:00:00Z';

    it('returns valid GPX XML', () => {
        const gpx = exportBasicPassageGPX(departure, arrival, departureTime);
        expect(gpx).toContain('<?xml');
        expect(gpx).toContain('<gpx');
        expect(gpx).toContain('</gpx>');
    });

    it('contains route points with coordinates', () => {
        const gpx = exportBasicPassageGPX(departure, arrival, departureTime);
        expect(gpx).toContain('lat=');
        expect(gpx).toContain('lon=');
    });

    it('includes departure and arrival names', () => {
        const gpx = exportBasicPassageGPX(departure, arrival, departureTime);
        expect(gpx).toContain('Brisbane');
        expect(gpx).toContain('Airlie Beach');
    });

    it('includes distance/duration when provided', () => {
        const gpx = exportBasicPassageGPX(departure, arrival, departureTime, 520, 72);
        expect(gpx).toContain('520');
    });
});
