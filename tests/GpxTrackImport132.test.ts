/**
 * 132-B21: GPX tracks import with true times, speeds and distances.
 *
 * Real-shaped files: an OpenCPN weekend with two segments, a Navionics-style
 * track with untimed points and an untimed waypoint, a file with no times at
 * all, a passage across the 180° line near Fiji, and a 50,000-point 1 Hz
 * logger track for the crash case. Pure parsing; nothing touches the network.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    exportVoyageAsGPX,
    extractGPXRouteWaypoints,
    GPX_IMPORT_MAX_TRACK_POINTS,
    importGPXToEntries,
    normalizeLongitude,
    parseGPXTrack,
    positionBounds,
} from '../services/gpxService';
import { accrueDistance, freshAccrual, DEFAULT_ACCRUAL_GATE_M } from '../services/shiplog/distanceAccrual';
import { calculateDistance } from '../utils/navigationCalculations';
import type { ShipLogEntry } from '../types';

// ── Fixture builders ──

interface Pt {
    lat: number;
    lon: number;
    time?: string;
}

const trkpt = (p: Pt) =>
    `<trkpt lat="${p.lat}" lon="${p.lon}">${p.time ? `<ele>0</ele><time>${p.time}</time>` : '<ele>0</ele>'}</trkpt>`;

const gpx = (body: string, opts: { creator?: string; metaTime?: string } = {}) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${opts.creator ?? 'OpenCPN'}" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test passage</name>${opts.metaTime ? `<time>${opts.metaTime}</time>` : ''}</metadata>
${body}
</gpx>`;

const iso = (startIso: string, plusSeconds: number) =>
    new Date(Date.parse(startIso) + plusSeconds * 1000).toISOString();

/** A straight run north from a start, one point every `stepS` seconds at `kts`. */
function run(start: { lat: number; lon: number }, startIso: string, count: number, stepS: number, kts: number): Pt[] {
    const stepDeg = (kts * (stepS / 3600)) / 60; // NM per step -> degrees of latitude
    return Array.from({ length: count }, (_, i) => ({
        lat: +(start.lat + i * stepDeg).toFixed(7),
        lon: start.lon,
        time: iso(startIso, i * stepS),
    }));
}

const seg = (pts: Pt[]) => `<trkseg>${pts.map(trkpt).join('')}</trkseg>`;
const trk = (name: string, ...segs: string[]) => `<trk><name>${name}</name>${segs.join('')}</trk>`;

/** What the recorded-voyage gate makes of a run of positions. */
function gatedDistanceNM(pts: Pt[]): number {
    let carry = {
        ...freshAccrual({ latitude: pts[0].lat, longitude: pts[0].lon }),
        latitude: pts[0].lat,
        longitude: pts[0].lon,
    };
    for (const p of pts.slice(1)) {
        const fix = { latitude: p.lat, longitude: p.lon };
        carry = { ...accrueDistance(carry, fix, DEFAULT_ACCRUAL_GATE_M), ...fix };
    }
    return carry.cumulativeDistanceNM;
}

const track = (entries: Partial<ShipLogEntry>[]) => entries.filter((e) => e.entryType === 'auto');
const ms = (e: Partial<ShipLogEntry>) => Date.parse(e.timestamp as string);

// Saturday out of Manly, Sunday back from Tangalooma: two segments, the boat
// at anchor overnight 13 NM from where Saturday's segment began.
const SATURDAY = run({ lat: -27.45, lon: 153.19 }, '2026-09-19T22:00:00Z', 40, 60, 5);
const SUNDAY = run({ lat: -27.18, lon: 153.37 }, '2026-09-20T21:00:00Z', 40, 60, 5);
const WEEKEND = gpx(trk('Moreton Bay weekend', seg(SATURDAY), seg(SUNDAY)), { metaTime: '2026-09-21T08:00:00Z' });

describe('true times (132-B21)', () => {
    it('never gives an untimed point the import time, so no 36,000-knot legs and no voyage ending today', () => {
        // A Navionics-style track: the logger dropped the time on a run of points.
        const pts = run({ lat: -27.4, lon: 153.2 }, '2026-08-01T00:00:00Z', 12, 60, 6);
        const untimed = pts.map((p, i) => (i >= 4 && i <= 7 ? { lat: p.lat, lon: p.lon } : p));
        const nowMs = Date.parse('2026-10-15T06:00:00Z');
        const parsed = parseGPXTrack(gpx(trk('Navionics track', seg(untimed)), { creator: 'Navionics' }), { nowMs });

        const entries = track(parsed.entries);
        expect(entries).toHaveLength(12);
        expect(parsed.untimedTrackPoints).toBe(4);
        // Speeds only where the file timed both ends: ~6 kn, never thousands.
        for (const e of entries) if (e.speedKts !== undefined) expect(e.speedKts).toBeLessThan(10);
        expect(entries.slice(4, 9).every((e) => e.speedKts === undefined)).toBe(true);
        // The untimed points sit between their timed neighbours, in order.
        for (let i = 1; i < entries.length; i++) expect(ms(entries[i])).toBeGreaterThan(ms(entries[i - 1]));
        expect(ms(entries[5])).toBeGreaterThan(Date.parse(pts[3].time!));
        expect(ms(entries[5])).toBeLessThan(Date.parse(pts[8].time!));
        // The voyage ends when the file says, not at the import.
        expect(Math.max(...entries.map(ms))).toBe(Date.parse(pts[11].time!));
        expect(parsed.entries.some((e) => ms(e) >= nowMs - 86_400_000)).toBe(false);
        expect(parsed.fallbackDate).toBeNull();
    });

    it('keeps two untimed points in a row from making a speed (the 36,000 kn case)', () => {
        const file = gpx(
            trk(
                'Two untimed',
                seg([
                    { lat: -27.4, lon: 153.2 },
                    { lat: -27.4002, lon: 153.2 }, // 0.01 NM: 1 ms apart read 36,000 kn
                    { lat: -27.4004, lon: 153.2 },
                ]),
            ),
            { metaTime: '2026-07-04T00:00:00Z' },
        );
        const parsed = parseGPXTrack(file, { nowMs: Date.parse('2026-10-15T00:00:00Z') });
        expect(parsed.entries.every((e) => e.speedKts === undefined)).toBe(true);
    });

    it('dates a file with no times at all from its own <metadata><time>, and says so', () => {
        const pts = run({ lat: -27.4, lon: 153.2 }, '2026-01-01T00:00:00Z', 6, 60, 6).map(({ lat, lon }) => ({
            lat,
            lon,
        }));
        const parsed = parseGPXTrack(gpx(trk('Untimed', seg(pts)), { metaTime: '2026-03-14T02:00:00Z' }), {
            nowMs: Date.parse('2026-10-15T00:00:00Z'),
        });
        expect(parsed.fallbackDate).toEqual({ source: 'file', timeMs: Date.parse('2026-03-14T02:00:00Z') });
        expect(parsed.firstTimeMs).toBeNull();
        expect(parsed.lastTimeMs).toBeNull();
        expect(parsed.entries.every((e) => e.speedKts === undefined)).toBe(true);
        // In file order, starting at the file's date.
        expect(ms(parsed.entries[0])).toBe(Date.parse('2026-03-14T02:00:00Z'));
        for (let i = 1; i < parsed.entries.length; i++)
            expect(ms(parsed.entries[i])).toBeGreaterThan(ms(parsed.entries[i - 1]));
        expect(parsed.totalDistanceNM).toBeGreaterThan(0.4);
    });

    it('falls back to the import date only when the file has no date anywhere', () => {
        const nowMs = Date.parse('2026-10-15T00:00:00Z');
        const parsed = parseGPXTrack(
            gpx(
                trk(
                    'Untimed',
                    seg([
                        { lat: -27.4, lon: 153.2 },
                        { lat: -27.41, lon: 153.2 },
                    ]),
                ),
            ),
            { nowMs },
        );
        expect(parsed.fallbackDate).toEqual({ source: 'import', timeMs: nowMs });
    });

    it('logs an untimed waypoint when the track passed closest to it, so it never ends the voyage', () => {
        const pts = run({ lat: -27.4, lon: 153.2 }, '2026-08-01T00:00:00Z', 10, 300, 6);
        const wpt = `<wpt lat="${pts[3].lat + 0.0001}" lon="${pts[3].lon}"><name>Fish trap</name></wpt>`;
        const parsed = parseGPXTrack(gpx(`${wpt}${trk('Day sail', seg(pts))}`), {
            nowMs: Date.parse('2026-10-15T00:00:00Z'),
        });

        const waypoint = parsed.entries.find((e) => e.entryType === 'waypoint')!;
        expect(waypoint.waypointName).toBe('Fish trap');
        expect(waypoint.timestamp).toBe(pts[3].time);
        expect(parsed.untimedWaypoints).toBe(1);
        expect(ms(parsed.entries[parsed.entries.length - 1])).toBe(Date.parse(pts[9].time!));
        // Waypoints stay out of the distance and the duration.
        expect(parsed.firstTimeMs).toBe(Date.parse(pts[0].time!));
        expect(parsed.lastTimeMs).toBe(Date.parse(pts[9].time!));
    });

    it('treats an unreadable <time> as untimed instead of throwing', () => {
        const file = gpx(
            trk(
                'Bad time',
                seg([
                    { lat: -27.4, lon: 153.2, time: '2026-08-01T00:00:00Z' },
                    { lat: -27.41, lon: 153.2, time: 'yesterday afternoon' },
                    { lat: -27.42, lon: 153.2, time: '2026-08-01T00:20:00Z' },
                ]),
            ),
        );
        const parsed = parseGPXTrack(file);
        expect(parsed.untimedTrackPoints).toBe(1);
        expect(parsed.entries).toHaveLength(3);
    });

    it("reads the point's own <time>, not one inside <extensions>", () => {
        const file = gpx(
            `<trk><trkseg>
                <trkpt lat="-27.4" lon="153.2"><extensions><time>2001-01-01T00:00:00Z</time></extensions></trkpt>
                <trkpt lat="-27.41" lon="153.2"><time>2026-08-01T00:10:00Z</time></trkpt>
            </trkseg></trk>`,
        );
        const parsed = parseGPXTrack(file);
        expect(parsed.untimedTrackPoints).toBe(1);
        expect(parsed.firstTimeMs).toBe(Date.parse('2026-08-01T00:10:00Z'));
    });
});

describe('segments and distance (132-B21)', () => {
    it('starts each segment fresh: the overnight gap is not distance sailed and makes no speed', () => {
        const parsed = parseGPXTrack(WEEKEND);
        expect(parsed.segments).toBe(2);

        const entries = track(parsed.entries);
        const sundayFirst = entries[SATURDAY.length];
        expect(sundayFirst.distanceNM).toBe(0);
        expect(sundayFirst.speedKts).toBeUndefined();

        const expected = gatedDistanceNM(SATURDAY) + gatedDistanceNM(SUNDAY);
        expect(parsed.totalDistanceNM).toBeCloseTo(expected, 6);
        // The same points as one segment would have sailed the 13 NM gap too.
        const asOne = parseGPXTrack(gpx(trk('One segment', seg([...SATURDAY, ...SUNDAY]))));
        expect(asOne.totalDistanceNM - parsed.totalDistanceNM).toBeGreaterThan(10);
    });

    it('treats a second <trk> as a new segment too, and runs segments oldest first', () => {
        // Some apps list the newest track first.
        const parsed = parseGPXTrack(gpx(`${trk('Sunday', seg(SUNDAY))}${trk('Saturday', seg(SATURDAY))}`));
        expect(parsed.segments).toBe(2);
        const entries = track(parsed.entries);
        expect(entries[0].timestamp).toBe(SATURDAY[0].time);
        // Cumulative distance only grows along the voyage.
        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].cumulativeDistanceNM!).toBeGreaterThanOrEqual(entries[i - 1].cumulativeDistanceNM!);
        }
    });

    it('uses the recorded-voyage gate: a night of anchor jitter adds nothing', () => {
        // 1 Hz positions wandering ±4 m round the anchor for ten minutes.
        const pts: Pt[] = Array.from({ length: 600 }, (_, i) => ({
            lat: -27.2 + Math.sin(i * 1.7) * 0.00003,
            lon: 153.36 + Math.cos(i * 2.3) * 0.00003,
            time: iso('2026-09-20T12:00:00Z', i),
        }));
        let raw = 0;
        for (let i = 1; i < pts.length; i++)
            raw += calculateDistance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        expect(raw).toBeGreaterThan(0.5); // what the old importer called sailed

        const parsed = parseGPXTrack(gpx(trk('At anchor', seg(pts))));
        expect(parsed.totalDistanceNM).toBe(0);
    });

    it('keeps the <speed> the file gives, in knots', () => {
        const file = gpx(
            `<trk><trkseg>
                <trkpt lat="-27.4" lon="153.2"><time>2026-08-01T00:00:00Z</time><speed>3.08666</speed><course>12</course></trkpt>
            </trkseg></trk>`,
        );
        const [entry] = parseGPXTrack(file).entries;
        expect(entry.speedKts).toBe(6);
        expect(entry.courseDeg).toBe(12);

        // Garmin puts them inside <extensions>.
        const garmin = gpx(
            `<trk><trkseg>
                <trkpt lat="-27.4" lon="153.2"><time>2026-08-01T00:00:00Z</time><extensions>
                    <gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">
                        <gpxtpx:speed>2.5722</gpxtpx:speed><gpxtpx:course>45</gpxtpx:course>
                    </gpxtpx:TrackPointExtension>
                </extensions></trkpt>
            </trkseg></trk>`,
            { creator: 'Garmin' },
        );
        const [garminEntry] = parseGPXTrack(garmin).entries;
        expect(garminEntry.speedKts).toBe(5);
        expect(garminEntry.courseDeg).toBe(45);
    });

    it('leaves out points with no usable position and counts them', () => {
        const file = gpx(
            `<trk><trkseg>
                <trkpt lat="abc" lon="153.2"><time>2026-08-01T00:00:00Z</time></trkpt>
                <trkpt lat="-27.4"><time>2026-08-01T00:01:00Z</time></trkpt>
                <trkpt lat="0" lon="0"><time>2026-08-01T00:02:00Z</time></trkpt>
                <trkpt lat="-27.4" lon="153.2"><time>2026-08-01T00:03:00Z</time></trkpt>
            </trkseg></trk>
            <wpt lat="95" lon="153.2"><name>Impossible</name></wpt>`,
        );
        const parsed = parseGPXTrack(file);
        expect(parsed.skippedPoints).toBe(4);
        expect(parsed.trackPoints).toBe(1);
        expect(parsed.entries).toHaveLength(1);
    });

    it('still returns plain entries through importGPXToEntries', () => {
        expect(importGPXToEntries(WEEKEND)).toEqual(parseGPXTrack(WEEKEND).entries);
    });
});

describe('the 180° line (132-B21)', () => {
    // Suva to the Lau Group, crossing 180° east-about at about 17°S.
    const CROSSING: Pt[] = [
        { lat: -17.1, lon: 179.9, time: '2026-06-01T00:00:00Z' },
        { lat: -17.12, lon: 179.97, time: '2026-06-01T00:40:00Z' },
        { lat: -17.14, lon: -179.96, time: '2026-06-01T01:20:00Z' },
        { lat: -17.16, lon: -179.89, time: '2026-06-01T02:00:00Z' },
    ];

    it('measures across the line, not the long way round', () => {
        const parsed = parseGPXTrack(gpx(trk('Across 180', seg(CROSSING))));
        // ~0.21° of longitude at 17°S is ~12 NM; the long way is ~20,000.
        expect(parsed.totalDistanceNM).toBeGreaterThan(8);
        expect(parsed.totalDistanceNM).toBeLessThan(16);
        for (const e of parsed.entries) if (e.speedKts !== undefined) expect(e.speedKts).toBeLessThan(10);
    });

    it('bounds the area across the line: the west edge is east longitude', () => {
        const { bounds } = parseGPXTrack(gpx(trk('Across 180', seg(CROSSING))));
        expect(bounds).not.toBeNull();
        expect(bounds!.minLon).toBeCloseTo(179.9, 6);
        expect(bounds!.maxLon).toBeCloseTo(-179.89, 6);
        expect(bounds!.minLat).toBeCloseTo(-17.16, 6);
        expect(bounds!.maxLat).toBeCloseTo(-17.1, 6);
    });

    it('keeps ordinary bounds for a track that does not cross it', () => {
        const { bounds } = parseGPXTrack(WEEKEND);
        expect(bounds!.minLon).toBeCloseTo(153.19, 6);
        expect(bounds!.maxLon).toBeCloseTo(153.37, 6);
    });

    it('folds 0…360 longitudes back into −180…180', () => {
        expect(normalizeLongitude(181)).toBeCloseTo(-179, 9);
        expect(normalizeLongitude(359.5)).toBeCloseTo(-0.5, 9);
        expect(normalizeLongitude(-181)).toBeCloseTo(179, 9);
        expect(normalizeLongitude(180)).toBe(180);
        const parsed = parseGPXTrack(gpx(trk('360', seg([{ lat: -17.1, lon: 181, time: '2026-06-01T00:00:00Z' }]))));
        expect(parsed.entries[0].longitude).toBeCloseTo(-179, 9);
    });
});

describe('long tracks (132-B21)', () => {
    // A 1 Hz logger for 50,000 s (13 h 53 m) at 6 kn: the crash case.
    const START = '2026-09-01T20:00:00Z';
    const LONG = run({ lat: -27.6, lon: 153.25 }, START, 50_000, 1, 6);
    const LONG_GPX = gpx(trk('Overnight passage', seg(LONG)), { creator: 'Garmin' });

    it('parses 50,000 points and thins them, with distance and times from every point', () => {
        const parsed = parseGPXTrack(LONG_GPX, { maxTrackPoints: GPX_IMPORT_MAX_TRACK_POINTS });

        expect(parsed.trackPoints).toBe(50_000);
        expect(parsed.savedTrackPoints).toBeLessThanOrEqual(GPX_IMPORT_MAX_TRACK_POINTS + 1);
        expect(parsed.savedTrackPoints).toBeGreaterThan(GPX_IMPORT_MAX_TRACK_POINTS * 0.9);
        expect(parsed.entries).toHaveLength(parsed.savedTrackPoints);

        // 49,999 s at 6 kn is 83.3 NM; the gate straightens nothing on a straight run.
        expect(parsed.totalDistanceNM).toBeGreaterThan(83.0);
        expect(parsed.totalDistanceNM).toBeLessThan(83.5);
        expect(parsed.firstTimeMs).toBe(Date.parse(START));
        expect(parsed.lastTimeMs).toBe(Date.parse(LONG[49_999].time!));

        // First and last points kept; the legs still add up to the whole.
        const first = parsed.entries[0];
        const last = parsed.entries[parsed.entries.length - 1];
        expect(first.timestamp).toBe(LONG[0].time);
        expect(last.timestamp).toBe(LONG[49_999].time);
        expect(last.cumulativeDistanceNM).toBe(Math.round(parsed.totalDistanceNM * 100) / 100);
        const legs = parsed.entries.reduce((sum, e) => sum + (e.distanceNM || 0), 0);
        expect(legs).toBeCloseTo(parsed.totalDistanceNM, 0);
        // Speeds are the points' own, ~6 kn, not stretched by thinning.
        const speeds = parsed.entries.filter((e) => e.speedKts !== undefined).map((e) => e.speedKts!);
        expect(Math.max(...speeds.slice(0, 1000))).toBeLessThan(7);

        expect(parsed.bounds!.minLat).toBeCloseTo(-27.6, 6);
    }, 60_000);

    it("keeps every segment's start and end, and points with notes, when thinning", () => {
        const segs = [0, 1, 2].map((d) =>
            run({ lat: -27.6 + d * 0.5, lon: 153.25 }, iso(START, d * 86_400), 4_000, 2, 6),
        );
        const noted = segs[1].map((p, i) =>
            i === 1_501
                ? `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${p.time}</time><extensions><thalassa:notes xmlns:thalassa="https://thalassa.app/gpx/1">Reefed</thalassa:notes></extensions></trkpt>`
                : trkpt(p),
        );
        const file = gpx(trk('Three days', seg(segs[0]), `<trkseg>${noted.join('')}</trkseg>`, seg(segs[2])));
        const parsed = parseGPXTrack(file, { maxTrackPoints: 1_000 });

        expect(parsed.trackPoints).toBe(12_000);
        expect(parsed.savedTrackPoints).toBeLessThan(1_100);
        const times = new Set(parsed.entries.map((e) => e.timestamp));
        for (const s of segs) {
            expect(times.has(s[0].time)).toBe(true);
            expect(times.has(s[s.length - 1].time)).toBe(true);
        }
        expect(parsed.entries.some((e) => e.notes === 'Reefed')).toBe(true);
        // The start of each later segment adds no distance.
        const day2 = parsed.entries.find((e) => e.timestamp === segs[1][0].time)!;
        expect(day2.distanceNM).toBe(0);
    }, 30_000);

    it('works out bounds for any number of points without spreading them into Math.min', () => {
        const points = Array.from({ length: 200_000 }, (_, i) => ({
            latitude: -27 - i * 1e-6,
            longitude: 153 + i * 1e-6,
        }));
        const bounds = positionBounds(points);
        expect(bounds!.minLat).toBeCloseTo(-27.199999, 6);
        expect(bounds!.maxLon).toBeCloseTo(153.199999, 6);
    });

    it('exports a 130,000-entry voyage without the same spread crash', () => {
        const entries = Array.from(
            { length: 130_000 },
            (_, i) =>
                ({
                    id: `e${i}`,
                    timestamp: iso(START, i),
                    latitude: -27 - i * 1e-6,
                    longitude: 153 + i * 1e-6,
                    entryType: 'auto',
                }) as ShipLogEntry,
        );
        const xml = exportVoyageAsGPX(entries, 'Long voyage');
        expect(xml).toContain('minlat="-27.129999"');
        expect(xml).toContain('maxlon="153.129999"');
    }, 30_000);

    it('has no Math.min/Math.max over a spread left in the import path', () => {
        for (const path of ['services/gpxService.ts', 'components/vessel/GpxImportPage.tsx']) {
            const src = readFileSync(path, 'utf8');
            expect(src, path).not.toMatch(/Math\.(min|max)\(\s*\.\.\./);
        }
    });
});

describe('routes keep working (126-B5)', () => {
    it('a route-only file has no log entries but still hands a route to the planner', () => {
        const file = gpx(
            `<rte><name>Manly to Tangalooma</name>
                <rtept lat="-27.45" lon="153.19"><name>Manly</name></rtept>
                <rtept lat="-27.3" lon="153.3"><name>Hope Banks</name></rtept>
                <rtept lat="-27.18" lon="153.37"><name>Tangalooma</name></rtept>
            </rte>`,
        );
        expect(parseGPXTrack(file).entries).toHaveLength(0);
        const route = extractGPXRouteWaypoints(file);
        expect(route?.waypoints.map((w) => w.name)).toEqual(['Manly', 'Hope Banks', 'Tangalooma']);
    });
});
