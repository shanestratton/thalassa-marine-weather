/**
 * trackMapFeatures — what the big Log track map draws, as GeoJSON for Mapbox
 * GL (125-13b; components/TrackMapViewerGL.tsx). Pure: the same partition the
 * Leaflet viewer made, kept so every overlay it drew is still drawn:
 *
 *  - the track, one line per voyage (several voyages never join with a
 *    phantom diagonal), split where its colour changes, the boundary fix
 *    shared so the line never gaps: by the FORECAST wind at each fix
 *    ('wind', trackViz's buckets) or water/land ('plain'); a planned route
 *    is the violet plan line and never wind-coloured;
 *  - a small GPS dot on each fix (a named waypoint is a vertex, not a dot);
 *  - turn dots derived from the sailed geometry (never stored);
 *  - the start and the end.
 *
 * Only plausible, trackworthy fixes draw (no turn pins, manual entries or
 * (0, 0) placeholders), in time order. Longitudes are unwrapped along the
 * line, so a passage across the antimeridian is one short line and every dot
 * sits on it (Mapbox draws longitudes past ±180 in place).
 */
import type { ShipLogEntry } from '../../types';
import { isPlausibleTrackPoint, isTrackworthyEntry } from '../../services/shiplog/helpers';
import { stripInitialTrackWarmupRebounds } from '../../services/shiplog/initialTrackWarmupGuard';
import { windBucket } from '../../services/shiplog/trackViz';
import { deriveTurnMarkers } from '../../services/shiplog/turnMarkers';
import { sanitizeRouteCoordinates, type RouteCoordinate } from '../../utils/routeCoordinates';
import { logMapBounds, nearLongitude, unwrapLongitudes, type LonLat } from './logMap';
import { END_DOT, FOLLOWED_ROUTE_CORE, START_DOT } from './logMapColours';

export type TrackColourMode = 'wind' | 'plain';

/** A planned route's glow; its core is the followed route's lilac. */
export const PLANNED_GLOW = '#7c3aed';
/** 'plain' mode: sky on water, emerald ashore (neon on the dark base). */
export const TRACK_WATER = '#38bdf8';
export const TRACK_LAND = '#34d399';
/** The GPS dots: deeper fills, read on imagery and on the sea. */
export const FIX_WATER = '#0284c7';
export const FIX_LAND = '#059669';
export const TURN_DOT = '#f59e0b';

type Line = GeoJSON.Feature<GeoJSON.LineString, { glow: string; core: string }>;
type Dot<P> = GeoJSON.Feature<GeoJSON.Point, P>;

export interface TrackMapDrawing {
    track: GeoJSON.FeatureCollection<GeoJSON.LineString, { glow: string; core: string }>;
    fixes: GeoJSON.FeatureCollection<GeoJSON.Point, { fill: string }>;
    turns: GeoJSON.FeatureCollection<GeoJSON.Point, { from: string; to: string; time: string }>;
    ends: GeoJSON.FeatureCollection<GeoJSON.Point, { role: 'start' | 'end'; core: string; glow: string }>;
    /** Every vertex drawn, unwrapped: what a frame takes in. */
    line: LonLat[];
}

/** A fix's time as the viewer shows it everywhere (header, HUD, popups). */
export const trackTime = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

const collection = <T extends GeoJSON.Feature>(features: T[]) => ({
    type: 'FeatureCollection' as const,
    features,
});

const dot = <P>(coordinates: LonLat, properties: P): Dot<P> => ({
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates },
});

export function trackMapDrawing(entries: ShipLogEntry[], colorMode: TrackColourMode): TrackMapDrawing {
    const empty: TrackMapDrawing = {
        track: collection<Line>([]),
        fixes: collection<Dot<{ fill: string }>>([]),
        turns: collection<Dot<{ from: string; to: string; time: string }>>([]),
        ends: collection<Dot<{ role: 'start' | 'end'; core: string; glow: string }>>([]),
        line: [],
    };
    // Markers may come from any plausible entry; line VERTICES only from
    // trackworthy ones: turn pins sit at past positions and bend the line back.
    const valid = stripInitialTrackWarmupRebounds(entries).filter((e) =>
        isPlausibleTrackPoint(e.latitude, e.longitude),
    );
    if (valid.length < 2) return empty;
    const lineEntries = [...valid]
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .filter(isTrackworthyEntry);
    if (lineEntries.length < 2) return empty;

    const unwrapped = unwrapLongitudes(lineEntries.map((e) => [e.longitude, e.latitude]));
    const at = new Map<ShipLogEntry, LonLat>(lineEntries.map((e, i) => [e, unwrapped[i]]));
    const [[west], [east]] = logMapBounds(unwrapped)!;
    const centre = (west + east) / 2;

    const segOf = (entry: ShipLogEntry): { key: string; color: string } => {
        if (colorMode === 'wind') {
            const bucket = windBucket(entry.windSpeed);
            return { key: bucket.key, color: bucket.color };
        }
        const water = entry.isOnWater ?? true;
        return { key: water ? 'water' : 'land', color: water ? TRACK_WATER : TRACK_LAND };
    };

    const lines: Line[] = [];
    const addLine = (coordinates: LonLat[], glow: string, core: string) => {
        if (coordinates.length < 2) return;
        lines.push({ type: 'Feature', properties: { glow, core }, geometry: { type: 'LineString', coordinates } });
    };
    const turns: Dot<{ from: string; to: string; time: string }>[] = [];

    const voyages = new Map<string, ShipLogEntry[]>();
    for (const e of lineEntries) {
        const key = e.voyageId || 'default_voyage';
        const group = voyages.get(key);
        if (group) group.push(e);
        else voyages.set(key, [e]);
    }
    for (const group of voyages.values()) {
        if (group.length < 2) continue;
        // A planned route carries no telemetry: always the plan line.
        if (group.some((e) => e.source === 'planned_route')) {
            addLine(
                group.map((e) => at.get(e)!),
                PLANNED_GLOW,
                FOLLOWED_ROUTE_CORE,
            );
            continue;
        }
        let segment: LonLat[] = [];
        let seg = segOf(group[0]);
        for (const entry of group) {
            const next = segOf(entry);
            const coord = at.get(entry)!;
            if (next.key !== seg.key && segment.length > 0) {
                segment.push(coord);
                addLine(segment, seg.color, seg.color);
                segment = [coord];
                seg = next;
            } else segment.push(coord);
        }
        addLine(segment, seg.color, seg.color);
        for (const m of deriveTurnMarkers(group))
            turns.push(
                dot([nearLongitude(m.lon, centre), m.lat], {
                    from: m.fromCardinal,
                    to: m.toCardinal,
                    time: trackTime(m.timestamp),
                }),
            );
    }

    const fixes = lineEntries
        .filter((e) => e.entryType !== 'waypoint')
        .map((e) => dot(at.get(e)!, { fill: e.isOnWater ? FIX_WATER : FIX_LAND }));
    const ends = [
        dot(unwrapped[0], { role: 'start' as const, core: START_DOT, glow: 'rgba(52, 211, 153, 0.55)' }),
        dot(unwrapped[unwrapped.length - 1], { role: 'end' as const, core: END_DOT, glow: 'rgba(239, 68, 68, 0.55)' }),
    ];
    return {
        track: collection(lines),
        fixes: collection(fixes),
        turns: collection(turns),
        ends: collection(ends),
        line: unwrapped,
    };
}

/**
 * The followed route, unwrapped, and moved by whole turns to lie beside the
 * track (`nearLon`, its middle) when there is one.
 */
export function followedRouteLine(route: readonly RouteCoordinate[], nearLon?: number): LonLat[] {
    const line = unwrapLongitudes(sanitizeRouteCoordinates(route).map((c) => [c.lon, c.lat]));
    if (line.length === 0 || nearLon === undefined) return line;
    const shift = nearLongitude(line[0][0], nearLon) - line[0][0];
    return shift === 0 ? line : line.map(([lon, lat]) => [lon + shift, lat]);
}

/** The middle longitude of what is drawn, for placing taps and the boat beside it. */
export function middleLongitude(line: readonly LonLat[]): number | undefined {
    const bounds = logMapBounds(line);
    return bounds ? (bounds[0][0] + bounds[1][0]) / 2 : undefined;
}
