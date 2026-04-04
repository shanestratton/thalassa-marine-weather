/**
 * GPX Route Extraction — Unit tests
 *
 * Tests the extractGPXRouteWaypoints function that bridges
 * GPX imports → Passage Planner.
 */

import { describe, it, expect } from 'vitest';
import { extractGPXRouteWaypoints, type GpxRouteData } from '../services/gpxService';

// ── Test fixtures ──

const OPENCPN_ROUTE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="OpenCPN" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Brisbane to Sydney</name>
  </metadata>
  <rte>
    <name>Brisbane to Sydney</name>
    <rtept lat="-27.4698" lon="153.0251">
      <name>Brisbane River Mouth</name>
    </rtept>
    <rtept lat="-27.9500" lon="153.4300">
      <name>Cape Moreton</name>
    </rtept>
    <rtept lat="-30.3000" lon="153.1500">
      <name>Coffs Harbour</name>
    </rtept>
    <rtept lat="-33.8688" lon="151.2093">
      <name>Sydney Harbour</name>
    </rtept>
  </rte>
</gpx>`;

const NAVIONICS_WAYPOINTS_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Navionics">
  <metadata>
    <name>Whitsundays Tour</name>
  </metadata>
  <wpt lat="-20.0762" lon="148.7199">
    <name>Airlie Beach</name>
  </wpt>
  <wpt lat="-20.0500" lon="148.9400">
    <name>Hamilton Island</name>
  </wpt>
  <wpt lat="-20.1100" lon="148.9500">
    <name>Whitehaven Beach</name>
  </wpt>
</gpx>`;

const TRACK_ONLY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin">
  <trk>
    <name>Morning Sail</name>
    <trkseg>
      <trkpt lat="-33.8688" lon="151.2093"><time>2026-01-01T06:00:00Z</time></trkpt>
      <trkpt lat="-33.8700" lon="151.2200"><time>2026-01-01T06:15:00Z</time></trkpt>
      <trkpt lat="-33.8800" lon="151.2300"><time>2026-01-01T06:30:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const EMPTY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <metadata><name>Empty</name></metadata>
</gpx>`;

const SINGLE_WAYPOINT_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <wpt lat="-33.8688" lon="151.2093">
    <name>Only One</name>
  </wpt>
</gpx>`;

// ── Tests ──

describe('extractGPXRouteWaypoints', () => {
    it('parses <rte>/<rtept> elements (OpenCPN route)', () => {
        const result = extractGPXRouteWaypoints(OPENCPN_ROUTE_GPX);

        expect(result).not.toBeNull();
        expect(result!.routeName).toBe('Brisbane to Sydney');
        expect(result!.waypoints.length).toBe(4);
        expect(result!.origin.name).toBe('Brisbane River Mouth');
        expect(result!.destination.name).toBe('Sydney Harbour');
        expect(result!.totalDistanceNM).toBeGreaterThan(0);
    });

    it('falls back to <wpt> elements when no <rte> exists', () => {
        const result = extractGPXRouteWaypoints(NAVIONICS_WAYPOINTS_GPX);

        expect(result).not.toBeNull();
        expect(result!.routeName).toBe('Whitsundays Tour');
        expect(result!.waypoints.length).toBe(3);
        expect(result!.origin.name).toBe('Airlie Beach');
        expect(result!.destination.name).toBe('Whitehaven Beach');
    });

    it('falls back to track decimation when only <trk> exists', () => {
        const result = extractGPXRouteWaypoints(TRACK_ONLY_GPX);

        expect(result).not.toBeNull();
        expect(result!.routeName).toBe('Morning Sail');
        expect(result!.origin.name).toBe('Departure');
        expect(result!.destination.name).toBe('Arrival');
        expect(result!.waypoints.length).toBeGreaterThanOrEqual(2);
    });

    it('returns null for empty GPX file', () => {
        const result = extractGPXRouteWaypoints(EMPTY_GPX);
        expect(result).toBeNull();
    });

    it('returns null for single waypoint (not navigable)', () => {
        const result = extractGPXRouteWaypoints(SINGLE_WAYPOINT_GPX);
        expect(result).toBeNull();
    });

    it('returns null for invalid XML', () => {
        const result = extractGPXRouteWaypoints('not xml at all');
        expect(result).toBeNull();
    });

    it('calculates total distance in NM', () => {
        const result = extractGPXRouteWaypoints(OPENCPN_ROUTE_GPX);
        expect(result).not.toBeNull();
        // Brisbane to Sydney is roughly 400-500 NM
        expect(result!.totalDistanceNM).toBeGreaterThan(300);
        expect(result!.totalDistanceNM).toBeLessThan(600);
    });

    it('origin and destination match first/last waypoint', () => {
        const result = extractGPXRouteWaypoints(OPENCPN_ROUTE_GPX);
        expect(result).not.toBeNull();
        expect(result!.origin.lat).toBe(result!.waypoints[0].lat);
        expect(result!.destination.lat).toBe(result!.waypoints[result!.waypoints.length - 1].lat);
    });

    it('preserves waypoint names from <rtept> <name>', () => {
        const result = extractGPXRouteWaypoints(OPENCPN_ROUTE_GPX);
        expect(result).not.toBeNull();
        expect(result!.waypoints[1].name).toBe('Cape Moreton');
        expect(result!.waypoints[2].name).toBe('Coffs Harbour');
    });
});
