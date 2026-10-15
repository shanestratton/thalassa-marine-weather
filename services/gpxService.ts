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
import { createLogger } from '../utils/createLogger';
import { isTrackworthyEntry } from './shiplog/helpers';
import {
    accrualFields,
    accrueDistance,
    distanceAccrualGateM,
    freshAccrual,
    type AccrualCarry,
    type AccrualResult,
    type GeoPoint,
} from './shiplog/distanceAccrual';
import { calculateDistance as haversineNM, formatDMS } from '../utils/navigationCalculations';

const log = createLogger('GPX');

// --- GPX EXPORT ---

/**
 * Export voyage log entries as a GPX 1.1 XML string.
 * Creates a <trk> with <trkseg> containing all track points.
 * Weather data is included as GPX extensions.
 */
export function exportVoyageAsGPX(entries: ShipLogEntry[], voyageName: string, vesselName?: string): string {
    // Sort entries by timestamp
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (sorted.length === 0) {
        throw new Error('No entries to export');
    }

    const _firstEntry = sorted[0];
    const totalDistanceNM = sorted.reduce((acc, e) => Math.max(acc, e.cumulativeDistanceNM || 0), 0);

    // A loop, not Math.min over a spread: spreading a long voyage's positions
    // overflowed the call stack, the same crash as the import preview (132-B21).
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const e of sorted) {
        if (e.latitude < minLat) minLat = e.latitude;
        if (e.latitude > maxLat) maxLat = e.latitude;
        if (e.longitude < minLon) minLon = e.longitude;
        if (e.longitude > maxLon) maxLon = e.longitude;
    }

    // Build trackpoints — trackworthy entries only. Turn pins (past
    // positions) and (0,0) placeholders become <wpt> markers below, not
    // <trkseg> vertices, so exported tracks don't zig-zag in OpenCPN.
    const trackpoints = sorted
        .filter(isTrackworthyEntry)
        .map((entry) => {
            const time = new Date(entry.timestamp).toISOString();
            const extensions = buildExtensions(entry);

            return `      <trkpt lat="${entry.latitude}" lon="${entry.longitude}">
        <ele>0</ele>
        <time>${time}</time>${
            entry.speedKts !== undefined
                ? `
        <speed>${(entry.speedKts * 0.514444).toFixed(2)}</speed>`
                : ''
        }${
            entry.courseDeg !== undefined
                ? `
        <course>${entry.courseDeg}</course>`
                : ''
        }${
            extensions
                ? `
        <extensions>
${extensions}
        </extensions>`
                : ''
        }
      </trkpt>`;
        })
        .join('\n');

    // Build waypoint markers for manual/waypoint entries
    const waypoints = sorted
        .filter((e) => e.entryType === 'waypoint' || e.entryType === 'manual')
        .map((entry) => {
            const time = new Date(entry.timestamp).toISOString();
            const name = entry.waypointName || entry.notes || `${entry.entryType} entry`;
            return `  <wpt lat="${entry.latitude}" lon="${entry.longitude}">
    <ele>0</ele>
    <time>${time}</time>
    <name>${escapeXml(name)}</name>${
        entry.notes
            ? `
    <desc>${escapeXml(entry.notes)}</desc>`
            : ''
    }
    <type>${entry.entryType}</type>
  </wpt>`;
        })
        .join('\n');

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
    <bounds minlat="${minLat.toFixed(6)}"
            minlon="${minLon.toFixed(6)}"
            maxlat="${maxLat.toFixed(6)}"
            maxlon="${maxLon.toFixed(6)}" />
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
 * The most track points an import saves (132-B21). A 1 Hz logger writes
 * 50,000 points in fourteen hours; saving each one took 500 requests and drew
 * no better than one in ten. A longer track is thinned evenly to about this
 * many, AFTER its distance and times are worked out from every point.
 */
export const GPX_IMPORT_MAX_TRACK_POINTS = 5_000;

/** The area a file covers. When it crosses the 180° line the west edge (minLon) is east of the east edge. */
export interface GpxBounds {
    minLat: number;
    maxLat: number;
    /** West edge. */
    minLon: number;
    /** East edge. */
    maxLon: number;
}

/** A GPX track import: the entries to save, and what the preview should tell the skipper. */
export interface GpxTrackImport {
    /** Track points (thinned when asked) and waypoints, oldest first. */
    entries: Partial<ShipLogEntry>[];
    /** Track points in the file with a usable position. */
    trackPoints: number;
    /** Track points in `entries`: fewer than trackPoints when the track was thinned. */
    savedTrackPoints: number;
    /** Track segments with at least one point. Each starts fresh: gaps between them are not distance. */
    segments: number;
    /** Track points with no usable <time>. They get a placed time and never a speed. */
    untimedTrackPoints: number;
    /** Waypoints with no usable <time>. */
    untimedWaypoints: number;
    /** Points left out because their position was missing, impossible or the 0,0 placeholder. */
    skippedPoints: number;
    /** First and last time the file gives a track point, in ms, or null when it gives none. */
    firstTimeMs: number | null;
    lastTimeMs: number | null;
    /** Distance sailed, through the same gate as a recorded voyage. */
    totalDistanceNM: number;
    bounds: GpxBounds | null;
    /**
     * Set when the file had no times to date some points by: the date they
     * were logged under, from the file's own <metadata><time>, else the import.
     */
    fallbackDate: { source: 'file' | 'import'; timeMs: number } | null;
}

/** One track point as the file gives it. */
interface FileTrackPoint {
    lat: number;
    lon: number;
    /** The file's own time, or null. Never the import time (132-B21). */
    timeMs: number | null;
    fileSpeedKts?: number;
    courseDeg?: number;
    extensions: Partial<ShipLogEntry>;
}

/** A direct child's text, so a <time> or <name> inside <extensions> is never read as the point's own. */
function childText(el: Element, localName: string): string | undefined {
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
        if (children[i].localName === localName) return children[i].textContent?.trim() || undefined;
    }
    return undefined;
}

/** The first <speed> or <course> at any depth: GPX 1.0 puts it on the point, Garmin inside <extensions>. */
function anyDepthText(el: Element, localName: string): string | undefined {
    return el.getElementsByTagNameNS('*', localName)[0]?.textContent?.trim() || undefined;
}

/** A GPX <time> in ms, or null when it is missing or unreadable. */
function parseGpxTime(text: string | undefined): number | null {
    if (!text) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
}

/** A number from the file, or undefined when it is missing or not a number. */
function parseFileNumber(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : undefined;
}

/** Longitude folded into −180…180, so a file that writes 0…360 still lands on the right side of the 180° line. */
export function normalizeLongitude(lon: number): number {
    if (lon >= -180 && lon <= 180) return lon;
    return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** A point's position, or null when it is missing, impossible, or the 0,0 "no fix" placeholder. */
function readPosition(el: Element): { lat: number; lon: number } | null {
    const lat = parseFileNumber(el.getAttribute('lat') ?? undefined);
    const lon = parseFileNumber(el.getAttribute('lon') ?? undefined);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
    if (lat === 0 && lon === 0) return null;
    return { lat, lon: normalizeLongitude(lon) };
}

/**
 * The smallest box around a set of positions, across the 180° line when that
 * box is the narrower one (132-B21). A running loop, never Math.min over a spread:
 * spreading a 50,000-point track's latitudes overflowed the call stack and
 * took the preview down with it.
 */
function boundsAccumulator() {
    let count = 0;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    // The same longitudes measured 0…360, where a track across 180° is narrow.
    let minLon360 = Infinity;
    let maxLon360 = -Infinity;
    return {
        add(lat: number, lon: number) {
            count++;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            const lon360 = lon < 0 ? lon + 360 : lon;
            if (lon360 < minLon360) minLon360 = lon360;
            if (lon360 > maxLon360) maxLon360 = lon360;
        },
        result(): GpxBounds | null {
            if (count === 0) return null;
            if (maxLon360 - minLon360 < maxLon - minLon) {
                const fold = (lon: number) => (lon > 180 ? lon - 360 : lon);
                return { minLat, maxLat, minLon: fold(minLon360), maxLon: fold(maxLon360) };
            }
            return { minLat, maxLat, minLon, maxLon };
        },
    };
}

/** The box around these positions (see boundsAccumulator). Safe for any number of points. */
export function positionBounds(points: Iterable<{ latitude?: number; longitude?: number }>): GpxBounds | null {
    const bounds = boundsAccumulator();
    for (const p of points) {
        if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) bounds.add(p.latitude!, p.longitude!);
    }
    return bounds.result();
}

/**
 * A stored time for every track point. The file's own time where it has one.
 * An untimed point between two timed ones is placed evenly between them; one
 * before the first or after the last sits a millisecond outside it, so the
 * log keeps the file's order. Untimed points used to take the import time,
 * so two of them a few milliseconds apart read 36,000 kn and the voyage ended
 * today (132-B21). With no times at all, points run a millisecond apart from
 * the fallback start.
 */
function placeTrackTimes(times: (number | null)[], fallbackStartMs: number): number[] {
    const timed: number[] = [];
    for (let i = 0; i < times.length; i++) if (times[i] !== null) timed.push(i);
    if (timed.length === 0) return times.map((_, i) => fallbackStartMs + i);

    const placed = new Array<number>(times.length);
    const first = timed[0];
    const last = timed[timed.length - 1];
    for (let i = 0; i < first; i++) placed[i] = (times[first] as number) - (first - i);
    for (let i = last + 1; i < times.length; i++) placed[i] = (times[last] as number) + (i - last);
    for (let t = 0; t < timed.length; t++) {
        const a = timed[t];
        const ta = times[a] as number;
        placed[a] = ta;
        if (t + 1 === timed.length) break;
        const b = timed[t + 1];
        const tb = times[b] as number;
        for (let i = a + 1; i < b; i++) {
            placed[i] = tb > ta ? Math.round(ta + ((tb - ta) * (i - a)) / (b - a)) : ta;
        }
    }
    return placed;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Keep about one track point in every `stride`, plus each segment's first and
 * last and any point carrying the skipper's notes. Each kept point's leg is
 * the distance since the previous kept point, so the legs still add up to the
 * full track's distance.
 */
function thinTrack(
    entries: Partial<ShipLogEntry>[],
    cumulativeNM: number[],
    segmentStarts: number[],
    maxPoints: number,
): Partial<ShipLogEntry>[] {
    const stride = Math.ceil(entries.length / maxPoints);
    const kept: Partial<ShipLogEntry>[] = [];
    for (let s = 0; s < segmentStarts.length; s++) {
        const start = segmentStarts[s];
        const end = s + 1 < segmentStarts.length ? segmentStarts[s + 1] : entries.length;
        let lastKept = -1;
        for (let i = start; i < end; i++) {
            const keep = i === start || i === end - 1 || (i - start) % stride === 0 || Boolean(entries[i].notes);
            if (!keep) continue;
            const legNM = lastKept < 0 ? entries[i].distanceNM || 0 : cumulativeNM[i] - cumulativeNM[lastKept];
            kept.push({ ...entries[i], distanceNM: round2(legNM) });
            lastKept = i;
        }
    }
    return kept;
}

/**
 * Parse a GPX file's tracks and waypoints for the Ship's Log (132-B21).
 *
 * - Times are the file's own. An untimed point is placed between its timed
 *   neighbours (see placeTrackTimes) and never gets a speed; an untimed
 *   waypoint is logged when the track passed closest to it.
 * - Each <trkseg> starts fresh: the gap to the next segment, or the next
 *   <trk>, is not distance sailed and makes no speed.
 * - Distance runs through the recorded-voyage gate (distanceAccrual), so GPS
 *   jitter at anchor adds nothing here either. Speed still uses the raw leg.
 * - Longitudes fold into −180…180 and the bounds handle the 180° line.
 * - `maxTrackPoints` thins a long track after distance and times are known.
 */
export function parseGPXTrack(
    gpxXml: string,
    options: { maxTrackPoints?: number; nowMs?: number } = {},
): GpxTrackImport {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxXml, 'application/xml');

    // Check for parse errors
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`Invalid GPX file: ${parseError.textContent}`);
    }

    let skippedPoints = 0;
    const bounds = boundsAccumulator();

    // Track points, grouped by their segment (a <trkseg>, or a <trk>'s loose
    // points) in file order.
    const segmentsByParent = new Map<Element, FileTrackPoint[]>();
    const trkpts = doc.querySelectorAll('trkpt');
    for (let i = 0; i < trkpts.length; i++) {
        const trkpt = trkpts[i];
        const position = readPosition(trkpt);
        if (!position) {
            skippedPoints++;
            continue;
        }
        bounds.add(position.lat, position.lon);
        const fileSpeedMs = parseFileNumber(anyDepthText(trkpt, 'speed'));
        const point: FileTrackPoint = {
            ...position,
            timeMs: parseGpxTime(childText(trkpt, 'time')),
            // GPX speed is m/s
            fileSpeedKts: fileSpeedMs !== undefined ? fileSpeedMs / 0.514444 : undefined,
            courseDeg: parseFileNumber(anyDepthText(trkpt, 'course')),
            extensions: parseThalassaExtensions(trkpt),
        };
        const parent = trkpt.parentElement ?? doc.documentElement;
        const segment = segmentsByParent.get(parent);
        if (segment) segment.push(point);
        else segmentsByParent.set(parent, [point]);
    }
    let segments = [...segmentsByParent.values()];

    // Segments in time order when every one says when it started; a file
    // that lists its newest track first still runs oldest first.
    const segmentStartMs = segments.map((seg) => seg.find((p) => p.timeMs !== null)?.timeMs ?? null);
    if (segments.length > 1 && segmentStartMs.every((t) => t !== null)) {
        segments = segments
            .map((seg, i) => ({ seg, start: segmentStartMs[i] as number }))
            .sort((a, b) => a.start - b.start)
            .map(({ seg }) => seg);
    }

    const fileTimeMs = parseGpxTime(doc.querySelector('metadata > time')?.textContent?.trim());
    const fallbackStartMs = fileTimeMs ?? options.nowMs ?? Date.now();
    let fallbackUsed = false;

    const flat = segments.flat();
    let untimedTrackPoints = 0;
    let firstTimeMs: number | null = null;
    let lastTimeMs: number | null = null;
    for (const p of flat) {
        if (p.timeMs === null) {
            untimedTrackPoints++;
            continue;
        }
        if (firstTimeMs === null || p.timeMs < firstTimeMs) firstTimeMs = p.timeMs;
        if (lastTimeMs === null || p.timeMs > lastTimeMs) lastTimeMs = p.timeMs;
    }
    const placedMs = placeTrackTimes(
        flat.map((p) => p.timeMs),
        fallbackStartMs,
    );
    if (flat.length > 0 && firstTimeMs === null) fallbackUsed = true;

    // Distance, speed and the entry for every track point, segment by segment.
    const gateM = distanceAccrualGateM(null);
    const trackEntries: Partial<ShipLogEntry>[] = [];
    const cumulativeNM: number[] = [];
    const segmentStarts: number[] = [];
    let cumulative = 0;
    let k = 0;
    for (const segment of segments) {
        segmentStarts.push(trackEntries.length);
        let carry: (AccrualCarry & GeoPoint) | null = null;
        let prev: FileTrackPoint | null = null;
        for (const p of segment) {
            const fix = { latitude: p.lat, longitude: p.lon };
            const accrual: AccrualResult = carry ? accrueDistance(carry, fix, gateM) : freshAccrual(fix, cumulative);
            cumulative = accrual.cumulativeDistanceNM;
            carry = { ...fix, ...accrualFields(accrual), cumulativeDistanceNM: cumulative };

            // A speed only between two points the file timed, in one segment.
            let speedKts: number | undefined;
            if (prev && prev.timeMs !== null && p.timeMs !== null && p.timeMs > prev.timeMs) {
                const legNM = haversineNM(prev.lat, prev.lon, p.lat, p.lon);
                speedKts = legNM / ((p.timeMs - prev.timeMs) / 3_600_000);
            }
            if (p.fileSpeedKts !== undefined) speedKts = p.fileSpeedKts;

            trackEntries.push({
                timestamp: new Date(placedMs[k]).toISOString(),
                latitude: p.lat,
                longitude: p.lon,
                positionFormatted: formatDMS(p.lat, p.lon),
                distanceNM: round2(accrual.accruedNM),
                cumulativeDistanceNM: round2(cumulative),
                speedKts: speedKts !== undefined ? Math.round(speedKts * 10) / 10 : undefined,
                courseDeg: p.courseDeg,
                entryType: 'auto',
                source: 'gpx_import',
                ...p.extensions,
            });
            cumulativeNM.push(cumulative);
            prev = p;
            k++;
        }
    }

    const maxTrackPoints = options.maxTrackPoints;
    const savedTrack =
        maxTrackPoints && maxTrackPoints > 0 && trackEntries.length > maxTrackPoints
            ? thinTrack(trackEntries, cumulativeNM, segmentStarts, maxTrackPoints)
            : trackEntries;

    // Waypoints. An untimed one is logged when the track passed closest to
    // it; with no track, it takes the fallback date like an untimed track.
    // The nearest search samples at most ~5,000 track points.
    const candidateStep = Math.max(1, Math.ceil(flat.length / 5_000));
    const nearestTrackTime = (lat: number, lon: number): number => {
        const cosLat = Math.cos((lat * Math.PI) / 180);
        let best = Infinity;
        let bestIndex = 0;
        for (let i = 0; i < flat.length; i += candidateStep) {
            let dLon = Math.abs(flat[i].lon - lon);
            if (dLon > 180) dLon = 360 - dLon;
            const dLat = flat[i].lat - lat;
            const d = dLat * dLat + dLon * cosLat * (dLon * cosLat);
            if (d < best) {
                best = d;
                bestIndex = i;
            }
        }
        return placedMs[bestIndex];
    };
    const waypointEntries: Partial<ShipLogEntry>[] = [];
    let untimedWaypoints = 0;
    const wpts = doc.querySelectorAll('wpt');
    for (let i = 0; i < wpts.length; i++) {
        const wpt = wpts[i];
        const position = readPosition(wpt);
        if (!position) {
            skippedPoints++;
            continue;
        }
        bounds.add(position.lat, position.lon);
        let timeMs = parseGpxTime(childText(wpt, 'time'));
        if (timeMs === null) {
            untimedWaypoints++;
            if (flat.length > 0) {
                timeMs = nearestTrackTime(position.lat, position.lon);
            } else {
                timeMs = fallbackStartMs + i;
                fallbackUsed = true;
            }
        }
        waypointEntries.push({
            timestamp: new Date(timeMs).toISOString(),
            latitude: position.lat,
            longitude: position.lon,
            positionFormatted: formatDMS(position.lat, position.lon),
            entryType: childText(wpt, 'type') === 'manual' ? 'manual' : 'waypoint',
            source: 'gpx_import',
            waypointName: childText(wpt, 'name'),
            notes: childText(wpt, 'desc'),
        });
    }

    // Oldest first. The sort is stable, so equal times keep the file's order.
    const entries = [...savedTrack, ...waypointEntries]
        .map((entry) => ({ entry, ms: Date.parse(entry.timestamp as string) }))
        .sort((a, b) => a.ms - b.ms)
        .map(({ entry }) => entry);

    return {
        entries,
        trackPoints: flat.length,
        savedTrackPoints: savedTrack.length,
        segments: segments.length,
        untimedTrackPoints,
        untimedWaypoints,
        skippedPoints,
        firstTimeMs,
        lastTimeMs,
        totalDistanceNM: cumulative,
        bounds: bounds.result(),
        fallbackDate: fallbackUsed
            ? { source: fileTimeMs !== null ? 'file' : 'import', timeMs: fallbackStartMs }
            : null,
    };
}

/**
 * Parse a GPX XML string into an array of partial ShipLogEntry objects:
 * every track point and waypoint, oldest first (see parseGPXTrack).
 */
export function importGPXToEntries(gpxXml: string): Partial<ShipLogEntry>[] {
    return parseGPXTrack(gpxXml).entries;
}

// --- GPX ROUTE EXTRACTION (for Passage Planner) ---

/**
 * Extracted route waypoint for the Passage Planner.
 */
export interface GpxRouteWaypoint {
    lat: number;
    lon: number;
    name: string;
}

/**
 * Structured route data extracted from a GPX file.
 * Used to bridge GPX import → Passage Planner.
 */
export interface GpxRouteData {
    routeName: string;
    waypoints: GpxRouteWaypoint[];
    origin: GpxRouteWaypoint;
    destination: GpxRouteWaypoint;
    totalDistanceNM: number;
}

/**
 * Extract navigable route waypoints from a GPX XML string.
 *
 * Priority:
 *   1. <rte>/<rtept> elements — explicit planned routes (OpenCPN, qtVLM)
 *   2. <wpt> elements — standalone waypoints (Navionics, iSailor)
 *   3. <trk>/<trkpt> decimation — sample key points from recorded tracks
 *
 * Returns null if fewer than 2 navigable points are found.
 */
export function extractGPXRouteWaypoints(gpxXml: string): GpxRouteData | null {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxXml, 'application/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) return null;

    let waypoints: GpxRouteWaypoint[] = [];
    let routeName = '';

    // ── Strategy 1: Parse <rte> elements (planned routes) ──
    const rtes = doc.querySelectorAll('rte');
    if (rtes.length > 0) {
        const rte = rtes[0]; // Use first route
        const nameEl = rte.querySelector('name');
        routeName = nameEl?.textContent || 'Imported Route';

        const rtepts = rte.querySelectorAll('rtept');
        rtepts.forEach((rtept, idx) => {
            const lat = parseFloat(rtept.getAttribute('lat') || '0');
            const lon = parseFloat(rtept.getAttribute('lon') || '0');
            const ptName = rtept.querySelector('name')?.textContent || `WP ${idx + 1}`;
            if (lat !== 0 || lon !== 0) {
                waypoints.push({ lat, lon, name: ptName });
            }
        });

        if (waypoints.length >= 2) {
            return buildRouteData(waypoints, routeName);
        }
    }

    // ── Strategy 2: Use <wpt> standalone waypoints ──
    const wpts = doc.querySelectorAll('wpt');
    if (wpts.length >= 2) {
        routeName = doc.querySelector('metadata > name')?.textContent || 'Imported Waypoints';
        waypoints = [];

        wpts.forEach((wpt, idx) => {
            const lat = parseFloat(wpt.getAttribute('lat') || '0');
            const lon = parseFloat(wpt.getAttribute('lon') || '0');
            const ptName = wpt.querySelector('name')?.textContent || `WP ${idx + 1}`;
            if (lat !== 0 || lon !== 0) {
                waypoints.push({ lat, lon, name: ptName });
            }
        });

        if (waypoints.length >= 2) {
            return buildRouteData(waypoints, routeName);
        }
    }

    // ── Strategy 3: Decimate <trk> track points ──
    const trkpts = doc.querySelectorAll('trkpt');
    if (trkpts.length >= 2) {
        routeName =
            doc.querySelector('trk > name')?.textContent ||
            doc.querySelector('metadata > name')?.textContent ||
            'Imported Track';

        const allPoints: GpxRouteWaypoint[] = [];
        trkpts.forEach((trkpt) => {
            const lat = parseFloat(trkpt.getAttribute('lat') || '0');
            const lon = parseFloat(trkpt.getAttribute('lon') || '0');
            if (lat !== 0 || lon !== 0) {
                allPoints.push({ lat, lon, name: '' });
            }
        });

        if (allPoints.length >= 2) {
            // Decimate: keep first, last, and one point every ~20 NM
            waypoints = decimateTrackToWaypoints(allPoints, 20);
            // Name the decimated waypoints
            waypoints.forEach((wp, idx) => {
                if (idx === 0) wp.name = 'Departure';
                else if (idx === waypoints.length - 1) wp.name = 'Arrival';
                else wp.name = `WP ${idx}`;
            });

            return buildRouteData(waypoints, routeName);
        }
    }

    return null;
}

/**
 * Build a GpxRouteData from ordered waypoints.
 */
function buildRouteData(waypoints: GpxRouteWaypoint[], routeName: string): GpxRouteData {
    let totalDistanceNM = 0;
    for (let i = 1; i < waypoints.length; i++) {
        totalDistanceNM += haversineNM(waypoints[i - 1].lat, waypoints[i - 1].lon, waypoints[i].lat, waypoints[i].lon);
    }

    return {
        routeName,
        waypoints,
        origin: waypoints[0],
        destination: waypoints[waypoints.length - 1],
        totalDistanceNM: Math.round(totalDistanceNM * 10) / 10,
    };
}

/**
 * Decimate a dense track into key waypoints using distance-based sampling.
 * Keeps first + last point, and inserts a waypoint every ~targetSpacingNM.
 */
function decimateTrackToWaypoints(points: GpxRouteWaypoint[], targetSpacingNM: number): GpxRouteWaypoint[] {
    if (points.length <= 3) return [...points];

    const result: GpxRouteWaypoint[] = [points[0]];
    let lastKept = points[0];

    for (let i = 1; i < points.length - 1; i++) {
        const dist = haversineNM(lastKept.lat, lastKept.lon, points[i].lat, points[i].lon);

        if (dist >= targetSpacingNM) {
            result.push(points[i]);
            lastKept = points[i];
        }
    }

    // Always include the last point
    result.push(points[points.length - 1]);

    // Cap at 20 waypoints max for the passage planner
    if (result.length > 20) {
        const step = (result.length - 2) / 18;
        const decimated: GpxRouteWaypoint[] = [result[0]];
        for (let i = 1; i < 19; i++) {
            decimated.push(result[Math.round(i * step)]);
        }
        decimated.push(result[result.length - 1]);
        return decimated;
    }

    return result;
}

// --- HELPERS ---

/**
 * Build Thalassa-specific GPX extension XML for weather/navigation data
 */
function buildExtensions(entry: ShipLogEntry): string {
    const lines: string[] = [];

    if (entry.windSpeed !== undefined)
        lines.push(`          <thalassa:windSpeed>${entry.windSpeed}</thalassa:windSpeed>`);
    if (entry.windDirection)
        lines.push(`          <thalassa:windDirection>${escapeXml(entry.windDirection)}</thalassa:windDirection>`);
    if (entry.waveHeight !== undefined)
        lines.push(`          <thalassa:waveHeight>${entry.waveHeight}</thalassa:waveHeight>`);
    if (entry.pressure !== undefined) lines.push(`          <thalassa:pressure>${entry.pressure}</thalassa:pressure>`);
    if (entry.airTemp !== undefined) lines.push(`          <thalassa:airTemp>${entry.airTemp}</thalassa:airTemp>`);
    if (entry.waterTemp !== undefined)
        lines.push(`          <thalassa:waterTemp>${entry.waterTemp}</thalassa:waterTemp>`);
    if (entry.beaufortScale !== undefined)
        lines.push(`          <thalassa:beaufort>${entry.beaufortScale}</thalassa:beaufort>`);
    if (entry.seaState !== undefined) lines.push(`          <thalassa:seaState>${entry.seaState}</thalassa:seaState>`);
    if (entry.visibility !== undefined)
        lines.push(`          <thalassa:visibility>${entry.visibility}</thalassa:visibility>`);
    if (entry.engineStatus)
        lines.push(`          <thalassa:engineStatus>${entry.engineStatus}</thalassa:engineStatus>`);
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
        const el =
            extensions.getElementsByTagName(tag)?.[0] ||
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

        // Trigger native share sheet with the file as an attachment
        await Share.share({
            title: safeName,
            files: [writeResult.uri],
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
