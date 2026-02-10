/**
 * GPX Service
 * Import and export voyage tracks in GPX 1.1 format
 * 
 * GPX (GPS Exchange Format) is the industry standard for sharing
 * GPS tracks between navigation software (OpenCPN, Navionics, etc.)
 */

import { ShipLogEntry } from '../types';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createLogger } from '../utils/logger';

const log = createLogger('GPX');

// --- GPX EXPORT ---

/**
 * Export voyage log entries as a GPX 1.1 XML string.
 * Creates a <trk> with <trkseg> containing all track points.
 * Weather data is included as GPX extensions.
 */
export function exportVoyageAsGPX(
    entries: ShipLogEntry[],
    voyageName: string,
    vesselName?: string
): string {
    // Sort entries by timestamp
    const sorted = [...entries].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (sorted.length === 0) {
        throw new Error('No entries to export');
    }

    const firstEntry = sorted[0];
    const lastEntry = sorted[sorted.length - 1];
    const totalDistanceNM = lastEntry.cumulativeDistanceNM || 0;

    // Build trackpoints
    const trackpoints = sorted.map(entry => {
        const time = new Date(entry.timestamp).toISOString();
        const extensions = buildExtensions(entry);

        return `      <trkpt lat="${entry.latitude}" lon="${entry.longitude}">
        <ele>0</ele>
        <time>${time}</time>${entry.speedKts !== undefined ? `
        <speed>${(entry.speedKts * 0.514444).toFixed(2)}</speed>` : ''}${entry.courseDeg !== undefined ? `
        <course>${entry.courseDeg}</course>` : ''}${extensions ? `
        <extensions>
${extensions}
        </extensions>` : ''}
      </trkpt>`;
    }).join('\n');

    // Build waypoint markers for manual/waypoint entries
    const waypoints = sorted
        .filter(e => e.entryType === 'waypoint' || e.entryType === 'manual')
        .map(entry => {
            const time = new Date(entry.timestamp).toISOString();
            const name = entry.waypointName || entry.notes || `${entry.entryType} entry`;
            return `  <wpt lat="${entry.latitude}" lon="${entry.longitude}">
    <ele>0</ele>
    <time>${time}</time>
    <name>${escapeXml(name)}</name>${entry.notes ? `
    <desc>${escapeXml(entry.notes)}</desc>` : ''}
    <type>${entry.entryType}</type>
  </wpt>`;
        }).join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Thalassa Marine Weather"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:thalassa="https://thalassa.app/gpx/1"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(voyageName)}</name>
    <desc>Voyage track exported from Thalassa Marine Weather${vesselName ? ` — ${escapeXml(vesselName)}` : ''}</desc>
    <author>
      <name>Thalassa Marine Weather</name>
    </author>
    <time>${new Date().toISOString()}</time>
    <keywords>marine,sailing,navigation,voyage</keywords>
    <bounds minlat="${Math.min(...sorted.map(e => e.latitude)).toFixed(6)}"
            minlon="${Math.min(...sorted.map(e => e.longitude)).toFixed(6)}"
            maxlat="${Math.max(...sorted.map(e => e.latitude)).toFixed(6)}"
            maxlon="${Math.max(...sorted.map(e => e.longitude)).toFixed(6)}" />
  </metadata>
${waypoints ? waypoints + '\n' : ''}  <trk>
    <name>${escapeXml(voyageName)}</name>
    <desc>Distance: ${totalDistanceNM.toFixed(1)} NM | Points: ${sorted.length}</desc>
    <type>sailing</type>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;

    return gpx;
}

// --- GPX IMPORT ---

/**
 * Parse a GPX XML string into an array of partial ShipLogEntry objects.
 * Handles <trk>/<trkseg>/<trkpt> and <wpt> elements.
 * Calculates distance and speed between consecutive points.
 */
export function importGPXToEntries(gpxXml: string): Partial<ShipLogEntry>[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxXml, 'application/xml');

    // Check for parse errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`Invalid GPX file: ${parseError.textContent}`);
    }

    const entries: Partial<ShipLogEntry>[] = [];

    // Parse track points
    const trkpts = doc.querySelectorAll('trkpt');
    let prevLat: number | undefined;
    let prevLon: number | undefined;
    let prevTime: number | undefined;
    let cumulativeDistanceNM = 0;

    trkpts.forEach((trkpt) => {
        const lat = parseFloat(trkpt.getAttribute('lat') || '0');
        const lon = parseFloat(trkpt.getAttribute('lon') || '0');
        const timeEl = trkpt.querySelector('time');
        const timestamp = timeEl?.textContent || new Date().toISOString();
        const speedEl = trkpt.querySelector('speed');
        const courseEl = trkpt.querySelector('course');

        // Calculate distance from previous point
        let distanceNM = 0;
        let speedKts: number | undefined;

        if (prevLat !== undefined && prevLon !== undefined) {
            distanceNM = haversineNM(prevLat, prevLon, lat, lon);
            cumulativeDistanceNM += distanceNM;

            // Calculate speed if we have timestamps
            if (prevTime !== undefined) {
                const currentTime = new Date(timestamp).getTime();
                const timeDiffHours = (currentTime - prevTime) / (1000 * 60 * 60);
                if (timeDiffHours > 0) {
                    speedKts = distanceNM / timeDiffHours;
                }
            }
        }

        // Override with GPX speed if available (convert from m/s to knots)
        if (speedEl?.textContent) {
            speedKts = parseFloat(speedEl.textContent) / 0.514444;
        }

        let courseDeg: number | undefined;
        if (courseEl?.textContent) {
            courseDeg = parseFloat(courseEl.textContent);
        }

        // Parse Thalassa extensions
        const extensions = parseThalassaExtensions(trkpt);

        const entry: Partial<ShipLogEntry> = {
            timestamp,
            latitude: lat,
            longitude: lon,
            positionFormatted: formatDMS(lat, lon),
            distanceNM: Math.round(distanceNM * 100) / 100,
            cumulativeDistanceNM: Math.round(cumulativeDistanceNM * 100) / 100,
            speedKts: speedKts !== undefined ? Math.round(speedKts * 10) / 10 : undefined,
            courseDeg,
            entryType: 'auto',
            source: 'gpx_import',
            ...extensions
        };

        entries.push(entry);

        prevLat = lat;
        prevLon = lon;
        prevTime = new Date(timestamp).getTime();
    });

    // Parse waypoints
    const wpts = doc.querySelectorAll('wpt');
    wpts.forEach((wpt) => {
        const lat = parseFloat(wpt.getAttribute('lat') || '0');
        const lon = parseFloat(wpt.getAttribute('lon') || '0');
        const timeEl = wpt.querySelector('time');
        const nameEl = wpt.querySelector('name');
        const descEl = wpt.querySelector('desc');
        const typeEl = wpt.querySelector('type');

        const entry: Partial<ShipLogEntry> = {
            timestamp: timeEl?.textContent || new Date().toISOString(),
            latitude: lat,
            longitude: lon,
            positionFormatted: formatDMS(lat, lon),
            entryType: typeEl?.textContent === 'manual' ? 'manual' : 'waypoint',
            source: 'gpx_import',
            waypointName: nameEl?.textContent || undefined,
            notes: descEl?.textContent || undefined
        };

        entries.push(entry);
    });

    // Sort all entries by timestamp
    entries.sort((a, b) =>
        new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
    );

    return entries;
}

// --- HELPERS ---

/**
 * Build Thalassa-specific GPX extension XML for weather/navigation data
 */
function buildExtensions(entry: ShipLogEntry): string {
    const lines: string[] = [];

    if (entry.windSpeed !== undefined) lines.push(`          <thalassa:windSpeed>${entry.windSpeed}</thalassa:windSpeed>`);
    if (entry.windDirection) lines.push(`          <thalassa:windDirection>${escapeXml(entry.windDirection)}</thalassa:windDirection>`);
    if (entry.waveHeight !== undefined) lines.push(`          <thalassa:waveHeight>${entry.waveHeight}</thalassa:waveHeight>`);
    if (entry.pressure !== undefined) lines.push(`          <thalassa:pressure>${entry.pressure}</thalassa:pressure>`);
    if (entry.airTemp !== undefined) lines.push(`          <thalassa:airTemp>${entry.airTemp}</thalassa:airTemp>`);
    if (entry.waterTemp !== undefined) lines.push(`          <thalassa:waterTemp>${entry.waterTemp}</thalassa:waterTemp>`);
    if (entry.beaufortScale !== undefined) lines.push(`          <thalassa:beaufort>${entry.beaufortScale}</thalassa:beaufort>`);
    if (entry.seaState !== undefined) lines.push(`          <thalassa:seaState>${entry.seaState}</thalassa:seaState>`);
    if (entry.visibility !== undefined) lines.push(`          <thalassa:visibility>${entry.visibility}</thalassa:visibility>`);
    if (entry.engineStatus) lines.push(`          <thalassa:engineStatus>${entry.engineStatus}</thalassa:engineStatus>`);
    if (entry.entryType) lines.push(`          <thalassa:entryType>${entry.entryType}</thalassa:entryType>`);
    if (entry.notes) lines.push(`          <thalassa:notes>${escapeXml(entry.notes)}</thalassa:notes>`);

    return lines.join('\n');
}

/**
 * Parse Thalassa extensions from a GPX trackpoint element
 */
function parseThalassaExtensions(trkpt: Element): Partial<ShipLogEntry> {
    const ext: Partial<ShipLogEntry> = {};
    const extensions = trkpt.querySelector('extensions');
    if (!extensions) return ext;

    const getText = (tag: string): string | undefined => {
        // Note: querySelector('thalassa:windSpeed') throws because ':' is a CSS pseudo-class.
        // Use getElementsByTagName (literal match) and getElementsByTagNameNS (namespace match) instead.
        const localName = tag.replace('thalassa:', '');
        const el = extensions.getElementsByTagName(tag)?.[0] ||
            extensions.getElementsByTagNameNS('https://thalassa.app/gpx/1', localName)?.[0] ||
            extensions.getElementsByTagName(localName)?.[0];
        return el?.textContent || undefined;
    };

    const windSpeed = getText('thalassa:windSpeed');
    if (windSpeed) ext.windSpeed = parseFloat(windSpeed);

    const windDir = getText('thalassa:windDirection');
    if (windDir) ext.windDirection = windDir;

    const waveHeight = getText('thalassa:waveHeight');
    if (waveHeight) ext.waveHeight = parseFloat(waveHeight);

    const pressure = getText('thalassa:pressure');
    if (pressure) ext.pressure = parseFloat(pressure);

    const airTemp = getText('thalassa:airTemp');
    if (airTemp) ext.airTemp = parseFloat(airTemp);

    const waterTemp = getText('thalassa:waterTemp');
    if (waterTemp) ext.waterTemp = parseFloat(waterTemp);

    const beaufort = getText('thalassa:beaufort');
    if (beaufort) ext.beaufortScale = parseInt(beaufort);

    const seaState = getText('thalassa:seaState');
    if (seaState) ext.seaState = parseInt(seaState);

    const visibility = getText('thalassa:visibility');
    if (visibility) ext.visibility = parseFloat(visibility);

    const engineStatus = getText('thalassa:engineStatus');
    if (engineStatus && ['running', 'stopped', 'maneuvering'].includes(engineStatus)) {
        ext.engineStatus = engineStatus as ShipLogEntry['engineStatus'];
    }

    const notes = getText('thalassa:notes');
    if (notes) ext.notes = notes;

    return ext;
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Haversine formula — distance between two coordinates in nautical miles
 */
function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth radius in NM
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Format coordinates as DMS for imported entries
 */
function formatDMS(lat: number, lon: number): string {
    const formatCoord = (value: number, posChar: string, negChar: string): string => {
        const absVal = Math.abs(value);
        const degrees = Math.floor(absVal);
        const minutes = (absVal - degrees) * 60;
        const dir = value >= 0 ? posChar : negChar;
        return `${degrees}°${minutes.toFixed(1)}'${dir}`;
    };
    return `${formatCoord(lat, 'N', 'S')} ${formatCoord(lon, 'E', 'W')}`;
}

// --- FILE SHARING ---

/**
 * Share a GPX file via native share sheet (email, AirDrop, Save to Files, etc.)
 * Falls back to browser download when native Share API is unavailable.
 */
export async function shareGPXFile(gpxXml: string, filename: string): Promise<void> {
    const safeName = filename.endsWith('.gpx') ? filename : `${filename}.gpx`;

    try {
        // Write GPX to cache directory
        const writeResult = await Filesystem.writeFile({
            path: safeName,
            data: gpxXml,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
        });

        // Trigger native share sheet with the file URI
        await Share.share({
            title: safeName,
            url: writeResult.uri,
            dialogTitle: 'Export Voyage Track',
        });
    } catch (err: unknown) {
        // If user cancelled the share sheet, that's fine — not an error
        const errMsg = err instanceof Error ? err.message : '';
        if (errMsg?.includes('cancel') || errMsg?.includes('dismissed')) {
            return;
        }

        // Fallback: browser blob download (web dev mode or Share API unavailable)
        log.warn('Native share unavailable, falling back to browser download:', errMsg);
        browserDownloadGPX(gpxXml, safeName);
    }
}

/**
 * Browser-only fallback for GPX download (used in web dev mode)
 */
function browserDownloadGPX(gpxXml: string, filename: string): void {
    const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Read a GPX file from a File input
 */
export function readGPXFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!file.name.toLowerCase().endsWith('.gpx') && !file.name.toLowerCase().endsWith('.xml')) {
            reject(new Error('Invalid file type. Please select a .gpx file.'));
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target?.result;
            if (typeof content === 'string') {
                resolve(content);
            } else {
                reject(new Error('Failed to read file'));
            }
        };
        reader.onerror = () => reject(new Error('Error reading file'));
        reader.readAsText(file);
    });
}
