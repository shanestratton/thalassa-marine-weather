/**
 * Ship's Log Export — Shared Helpers
 * Utilities shared between CSV and PDF export modules
 */

import { ShipLogEntry, VesselProfile, VesselDimensionUnits, UnitPreferences } from '../types';

// Vessel data interface for PDF export
export interface VesselData {
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
    units?: UnitPreferences;
}

export const NAVY = '#1a2a3a';
export const GOLD = '#c9a227';
export const GRAY = '#6a7a8a';
export const LIGHT_GRAY = '#e8eef4';

/** 16-point compass rose: N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW */
export function degreesToCardinal16(deg: number): string {
    const cardinals = [
        'N',
        'NNE',
        'NE',
        'ENE',
        'E',
        'ESE',
        'SE',
        'SSE',
        'S',
        'SSW',
        'SW',
        'WSW',
        'W',
        'WNW',
        'NW',
        'NNW',
    ];
    const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return cardinals[index];
}

// Helper to decode HTML entities (fixes &amp; &#34; etc in notes)
export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&"/g, '') // Broken entity
        .replace(/&'/g, "'") // Broken entity
        .replace(/&#x27;/g, "'") // Hex apostrophe
        .replace(/&#x22;/g, '"') // Hex quote
        .replace(/\u2693/g, '>>') // anchor emoji
        .replace(/[\u2000-\u206F]/g, ' ') // unicode spaces/control
        .replace(/\s+/g, ' ') // collapse multiple spaces
        .trim();
}

/**
 * Reverse geocode coordinates to get a place name
 * Returns a simplified location name suitable for PDF display
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string> {
    try {
        const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
        if (!mapboxToken)
            return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=neighborhood,locality,place,region&limit=5&access_token=${mapboxToken}`;
        const response = await fetch(url);

        if (!response.ok) throw new Error('Geocoding failed');

        const data = await response.json();
        if (data.features && data.features.length > 0) {
            // Prefer most specific: neighborhood > locality > place > region
            const priority = ['neighborhood', 'locality', 'place', 'region'];
            const sorted = [...data.features].sort(
                (
                    a: { place_type?: string[]; properties?: { time?: string } },
                    b: { place_type?: string[]; properties?: { time?: string } },
                ) => {
                    const ai = priority.indexOf(a.place_type?.[0] ?? '');
                    const bi = priority.indexOf(b.place_type?.[0] ?? '');
                    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                },
            );
            const feature = sorted[0];
            return (
                feature.text ||
                feature.place_name?.split(',')[0] ||
                `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`
            );
        }
    } catch (err) {
        // Silently ignored — non-critical failure
    }
    // Fallback to coordinates
    return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
}

/**
 * Fetch a static map image from Mapbox for the voyage track
 * Includes voyage track line and start/end markers
 */
export async function fetchMapboxStaticImage(
    entries: ShipLogEntry[],
    mapWidth: number,
    mapHeight: number,
): Promise<string | null> {
    try {
        // Try multiple ways to get the token
        const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

        // Debug: log what we got

        if (!mapboxToken) {
            return null;
        }

        const validEntries = entries.filter((e) => e.latitude && e.longitude);

        if (validEntries.length < 2) {
            return null;
        }

        // Get chronologically sorted points
        const sorted = [...validEntries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        // Simplify to max 50 points for the track (keeps URL reasonable)
        const maxPoints = 50;
        const step = Math.max(1, Math.floor(sorted.length / maxPoints));
        const simplified: typeof sorted = [];
        for (let i = 0; i < sorted.length; i += step) {
            simplified.push(sorted[i]);
        }
        // Always include end point
        if (simplified[simplified.length - 1] !== sorted[sorted.length - 1]) {
            simplified.push(sorted[sorted.length - 1]);
        }

        const start = simplified[0];
        const end = simplified[simplified.length - 1];

        // Build path coordinates string: lon,lat;lon,lat;...
        // Also build coordinates array for polyline encoding
        const coordsForPolyline = simplified.map((e) => [e.latitude, e.longitude]);

        // Polyline encode function (Google Polyline Algorithm)
        const encodePolyline = (coords: number[][]): string => {
            let result = '';
            let prevLat = 0;
            let prevLng = 0;

            for (const [lat, lng] of coords) {
                // Multiply by 1e5 and round
                const latE5 = Math.round(lat * 1e5);
                const lngE5 = Math.round(lng * 1e5);

                // Calculate deltas
                const dLat = latE5 - prevLat;
                const dLng = lngE5 - prevLng;

                prevLat = latE5;
                prevLng = lngE5;

                // Encode each delta
                for (const delta of [dLat, dLng]) {
                    let value = delta < 0 ? ~(delta << 1) : delta << 1;
                    while (value >= 0x20) {
                        result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
                        value >>= 5;
                    }
                    result += String.fromCharCode(value + 63);
                }
            }
            return result;
        };

        const encodedPath = encodePolyline(coordsForPolyline);

        // Calculate bounds for zoom calculation
        const lats = simplified.map((e) => e.latitude);
        const lons = simplified.map((e) => e.longitude);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);

        // Center point
        const centerLon = (minLon + maxLon) / 2;
        const centerLat = (minLat + maxLat) / 2;

        // Calculate zoom level based on bounds span
        const latSpan = maxLat - minLat;
        const lonSpan = maxLon - minLon;
        const maxSpan = Math.max(latSpan, lonSpan);

        // Approximate zoom: smaller span = higher zoom
        let zoom = 5; // Default
        if (maxSpan > 20) zoom = 3;
        else if (maxSpan > 10) zoom = 4;
        else if (maxSpan > 5) zoom = 5;
        else if (maxSpan > 2) zoom = 6;
        else if (maxSpan > 1) zoom = 7;
        else if (maxSpan > 0.5) zoom = 8;
        else if (maxSpan > 0.2) zoom = 9;
        else zoom = 10;

        // Path overlay with polyline encoding: path-{strokeWidth}+{strokeColor}({encoded_polyline})
        // Using navy blue (#1e3a5f) with 3px line for clean look
        const pathOverlay = `path-3+1e3a5f(${encodeURIComponent(encodedPath)})`;

        // Markers: pin-{size}-{label}+{color}(lon,lat)
        const startPin = `pin-l-a+22c55e(${start.longitude.toFixed(4)},${start.latitude.toFixed(4)})`;
        const endPin = `pin-l-b+ef4444(${end.longitude.toFixed(4)},${end.latitude.toFixed(4)})`;

        // Waypoint markers (orange, smaller pins)
        const waypointEntries = sorted.filter((e) => e.entryType === 'waypoint' && e !== start && e !== end);
        const waypointPins = waypointEntries
            .slice(0, 10)
            .map((wp, i) => `pin-s-${i + 1}+f59e0b(${wp.longitude!.toFixed(4)},${wp.latitude!.toFixed(4)})`)
            .join(',');

        // Size - higher resolution
        const w = Math.min(1280, Math.round(mapWidth * 3));
        const h = Math.min(1280, Math.round(mapHeight * 3));

        // Use light-v11 for cleaner, less colorful look (nautical-friendly)
        const mapStyle = 'mapbox/light-v11';

        // Build overlays string (path, start, waypoints, end)
        const overlays = waypointPins
            ? `${pathOverlay},${startPin},${waypointPins},${endPin}`
            : `${pathOverlay},${startPin},${endPin}`;

        // Build URL with explicit center/zoom instead of auto (auto fails with markers)
        const url = `https://api.mapbox.com/styles/v1/${mapStyle}/static/${overlays}/${centerLon.toFixed(4)},${centerLat.toFixed(4)},${zoom}/${w}x${h}@2x?access_token=${mapboxToken}&logo=false&attribution=false`;

        const response = await fetch(url);

        if (!response.ok) {
            const _errorText = await response.text().catch(() => 'no error text');
            return null;
        }

        const blob = await response.blob();

        if (blob.size < 1000) {
            return null;
        }

        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result as string;
                resolve(result);
            };
            reader.onerror = (e) => {
                resolve(null);
            };
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        return null;
    }
}

/**
 * Export log entries as CSV for GPS import
 * Format: Name, Latitude (decimal degrees), Longitude (decimal degrees), Description
 * Uses share dialog for export options
 */

export function downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
