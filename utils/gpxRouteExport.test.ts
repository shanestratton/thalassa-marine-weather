/**
 * gpxRouteExport — Unit tests for GPX route export utility.
 */
import { describe, it, expect } from 'vitest';
import { generateRouteGPX } from './gpxRouteExport';
import type { VoyagePlan } from '../types';

describe('generateRouteGPX', () => {
    const mockPlan: VoyagePlan = {
        origin: 'Brisbane',
        destination: 'Airlie Beach',
        departureDate: '2026-03-20',
        originCoordinates: { lat: -27.5, lon: 153.0 },
        destinationCoordinates: { lat: -20.0, lon: 148.7 },
        distanceApprox: '520nm',
        durationApprox: '3 days',
        overview: 'Coastal passage north along the Queensland coast',
        waypoints: [
            { name: 'Brisbane', coordinates: { lat: -27.5, lon: 153.0 } },
            { name: 'Bundaberg', coordinates: { lat: -24.0, lon: 152.0 } },
            { name: 'Airlie Beach', coordinates: { lat: -20.0, lon: 148.7 } },
        ],
    };

    it('returns valid XML string', () => {
        const gpx = generateRouteGPX(mockPlan);
        expect(gpx).toContain('<?xml');
        expect(gpx).toContain('<gpx');
    });

    it('includes route points', () => {
        const gpx = generateRouteGPX(mockPlan);
        expect(gpx).toContain('<rtept');
        expect(gpx).toContain('lat=');
        expect(gpx).toContain('lon=');
    });

    it('includes waypoint names', () => {
        const gpx = generateRouteGPX(mockPlan);
        expect(gpx).toContain('Brisbane');
        expect(gpx).toContain('Airlie Beach');
    });

    it('includes proper GPX closing tag', () => {
        const gpx = generateRouteGPX(mockPlan);
        expect(gpx).toContain('</gpx>');
    });

    it('is valid XML structure', () => {
        const gpx = generateRouteGPX(mockPlan);
        expect(gpx).toContain('xmlns');
        expect(gpx).toContain('</rte>');
    });
});
