import { loadReferenceTile } from '../anchorages/CruisingReferenceService';
import { resolveTimeZone } from '../../utils/timezone';
import {
    referenceTiles,
    validCachedReference,
    type CruisingPoint,
    type ReferenceTile,
} from '../anchorages/cruisingReference';
import { dayPlanDistanceNM, type DayPlanCandidate, type DayPlanRequest, type DayPlanResult } from './engine';
import { isDayPlanTimeZone } from './presentation';

export const DAY_PLANNER_REFERENCE_MAX_AGE_MS = 24 * 60 * 60_000;
export const DAY_PLANNER_DISCOVERY_MAX_RADIUS_NM = 30;
export const DAY_PLANNER_DISCOVERY_MAX_TILES = 4;
const MAX_DISCOVERED_CANDIDATES = 24;
const MAX_EXCLUSIONS = 40;
export const MAPPED_REFERENCE_LIMITATION =
    'Mapped anchorage references are unverified: permission, activities, shelter, holding, depth and landing access are not established. Check current charts, local restrictions and the place itself.';

export interface MappedDayPlanDiscovery {
    candidates: DayPlanCandidate[];
    excluded: DayPlanResult['excluded'];
    limitations: string[];
    radiusNM: number;
    tileKeys: string[];
    /** Retrieval freshness only; never a date of human verification. */
    freshUntilMs: number;
}

const longitude = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
const validStart = (point: DayPlanRequest['start']) =>
    !!point &&
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 80 &&
    Number.isFinite(point.lon) &&
    Math.abs(point.lon) <= 180;
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** At most four existing one-degree reference cells. Precise yacht coordinates
 * stay in memory; only the public coarse cells reach the reference service. */
export function dayPlannerDiscoveryTiles(
    request: Pick<DayPlanRequest, 'start' | 'speedKts' | 'maxSailingHours' | 'mode'>,
): {
    tiles: ReferenceTile[];
    radiusNM: number;
    truncated: boolean;
} {
    if (
        !validStart(request.start) ||
        !Number.isFinite(request.speedKts) ||
        request.speedKts <= 0 ||
        !Number.isFinite(request.maxSailingHours) ||
        request.maxSailingHours <= 0 ||
        !['return', 'overnight'].includes(request.mode)
    )
        throw new Error('Choose a valid start within 80° latitude and a positive sailing budget.');
    const radiusNM = Math.min(
        DAY_PLANNER_DISCOVERY_MAX_RADIUS_NM,
        (request.speedKts * request.maxSailingHours) / (request.mode === 'return' ? 2 : 1),
    );
    const start = request.start;
    const deltaLat = radiusNM / 60;
    const deltaLon = deltaLat / Math.cos((start.lat * Math.PI) / 180);
    const choices: { tile: ReferenceTile; distance: number; centreDistance: number }[] = [];
    for (
        let south = Math.floor(Math.max(-80, start.lat - deltaLat));
        south <= Math.floor(Math.min(80, start.lat + deltaLat));
        south++
    ) {
        for (let west = Math.floor(start.lon - deltaLon); west <= Math.floor(start.lon + deltaLon); west++) {
            const centre = { lat: south + 0.5, lon: longitude(west + 0.5) };
            const nearest = {
                lat: Math.max(south, Math.min(south + 1, start.lat)),
                lon: longitude(Math.max(west, Math.min(west + 1, start.lon))),
            };
            const distance = dayPlanDistanceNM(start, nearest);
            if (distance > radiusNM + 0.1) continue;
            const [tile] = referenceTiles(
                { west: centre.lon, east: centre.lon, south: centre.lat, north: centre.lat },
                9,
            );
            if (tile) choices.push({ tile, distance, centreDistance: dayPlanDistanceNM(start, centre) });
        }
    }
    choices.sort(
        (a, b) =>
            a.distance - b.distance || a.centreDistance - b.centreDistance || a.tile.key.localeCompare(b.tile.key),
    );
    return {
        tiles: choices.slice(0, DAY_PLANNER_DISCOVERY_MAX_TILES).map(({ tile }) => tile),
        radiusNM,
        truncated: choices.length > DAY_PLANNER_DISCOVERY_MAX_TILES,
    };
}

function restriction(point: CruisingPoint): boolean {
    // Unknown permission stays unknown; explicit restrictions never become
    // suggested anchorages. Free-text is conservative, not a permission parser.
    return (
        !!point.restrictionNotes?.length ||
        /(?:^|[;,])\s*(?:no|private|restricted|military|customers|permit|permission|destination)\s*(?:$|[;,])/i.test(
            point.access,
        ) ||
        /\b(?:private|restricted|military|no\s+access|(?:permit|permission)\s+required)\b/i.test(point.access) ||
        /\b(?:no[ -]?anchor(?:ing|age)?|(?:do\s+not|must\s+not|not\s+permitted\s+to|not\s+allowed\s+to)\s+anchor|anchor(?:ing|age)?\s+(?:is\s+)?(?:not\s+(?:allowed|permitted)|prohibited|forbidden|banned)|private|no\s+access|restricted|exclusion\s+zone|closed)\b/i.test(
            point.notes,
        )
    );
}

function pointInTile(point: CruisingPoint, tile: ReferenceTile): boolean {
    const lon = point.lon === 180 && tile.west === -180 ? -180 : point.lon;
    return lon >= tile.west && lon <= tile.east && point.lat >= tile.south && point.lat <= tile.north;
}

function destinationTimeZone(point: CruisingPoint): string {
    const zone = resolveTimeZone(point.lat, point.lon);
    if (!isDayPlanTimeZone(zone)) throw new Error('A mapped stop’s local time zone could not be established.');
    return zone;
}

export async function discoverMappedDayPlanCandidates(
    request: DayPlanRequest,
    options: { signal: AbortSignal; timeZone: string; now?: () => number },
): Promise<MappedDayPlanDiscovery> {
    options.signal.throwIfAborted();
    if (offline())
        throw new Error(
            'Worldwide mapped-stop discovery needs fresh online references. No offline suggestions were made.',
        );
    try {
        new Intl.DateTimeFormat('en', { timeZone: options.timeZone }).format(0);
    } catch {
        throw new Error('The departure time zone could not be established.');
    }
    const clock = options.now ?? Date.now;
    const { tiles, radiusNM, truncated } = dayPlannerDiscoveryTiles(request);
    if (!tiles.length) throw new Error('No bounded reference area is available for this departure.');
    const results = await Promise.all(
        tiles.map(async (tile) => ({
            tile,
            result: await loadReferenceTile(tile, options.signal, { requireRestrictionMetadata: true }),
        })),
    );
    options.signal.throwIfAborted();
    if (offline() || results.some(({ result }) => result.stale !== false))
        throw new Error('Mapped-stop references are stale or offline. No fresh suggestions are available.');
    const now = clock();
    if (!Number.isFinite(now)) throw new Error('Reference freshness could not be established.');
    const byId = new Map<string, CruisingPoint>();
    const conflicts = new Set<string>();
    const excluded: DayPlanResult['excluded'] = [];
    const exclude = (point: CruisingPoint, reason: string) => {
        if (excluded.length < MAX_EXCLUSIONS) excluded.push({ name: point.name || 'Mapped anchorage', reason });
    };
    for (const { tile, result } of results) {
        for (const point of result.points) {
            if (!validCachedReference(point) || !Array.isArray(point.restrictionNotes)) continue;
            const retrievedAt = Date.parse(point.retrievedAt);
            if (retrievedAt > now || now - retrievedAt >= DAY_PLANNER_REFERENCE_MAX_AGE_MS) {
                exclude(point, 'The mapped reference is not fresh enough for a new suggestion.');
                continue;
            }
            const id = /^osm-node([1-9]\d*)$/.exec(point.id)?.[1];
            if (
                !id ||
                !Number.isSafeInteger(Number(id)) ||
                point.approximate ||
                point.kind !== 'anchorage' ||
                point.sourceUrl !== `https://www.openstreetmap.org/node/${id}` ||
                !pointInTile(point, tile) ||
                Math.abs(point.lat) > 80 ||
                dayPlanDistanceNM(request.start, point) > radiusNM
            )
                continue;
            if (restriction(point)) {
                conflicts.add(point.id);
                exclude(point, 'The mapped reference reports restricted access or anchoring.');
                continue;
            }
            const previous = byId.get(point.id);
            if (
                previous &&
                (previous.lat !== point.lat || previous.lon !== point.lon || previous.name !== point.name)
            ) {
                conflicts.add(point.id);
                exclude(point, 'Conflicting mapped reference positions or identities.');
                continue;
            }
            byId.set(point.id, point);
        }
    }
    const points = [...byId.values()]
        .filter((point) => !conflicts.has(point.id))
        .sort(
            (a, b) =>
                dayPlanDistanceNM(request.start, a) - dayPlanDistanceNM(request.start, b) || a.id.localeCompare(b.id),
        )
        .slice(0, MAX_DISCOVERED_CANDIDATES);
    const candidates: DayPlanCandidate[] = points.map((point) => ({
        destination: {
            id: point.id,
            name: point.name,
            lat: point.lat,
            lon: point.lon,
            activities: ['explore'],
            summary: 'A mapped anchorage reference to investigate, not a verified stop or activity.',
            catalogueQuality: 'mapped-reference',
            retrievedAt: point.retrievedAt,
            timeZone: destinationTimeZone(point),
            sourceUrl: point.sourceUrl,
            openMapUrl: point.sourceUrl,
            sourceLabel: 'OpenStreetMap contributors · mapped anchorage',
            accessNotes: [MAPPED_REFERENCE_LIMITATION, `Mapped access: ${point.access}`],
            uncertaintyNotes: [
                'The exact mapped node is not a verified approach or anchor-drop position.',
                ...(point.notes ? [`Mapped note (not verified): ${point.notes}`] : []),
            ],
            anchorageId: point.id,
            anchorageName: point.name,
            referencePosition: 'existing-anchorage',
        },
        // Do not turn an unverified map point or a colour into shelter,
        // holding, depth, permission or a mooring-capacity assertion.
        place: { id: point.id, lat: point.lat, lon: point.lon, kind: 'anchorage', source: 'OpenStreetMap' },
    }));
    return {
        candidates,
        excluded,
        radiusNM,
        tileKeys: tiles.map((tile) => tile.key),
        freshUntilMs: Math.min(
            ...points.map((point) => Date.parse(point.retrievedAt) + DAY_PLANNER_REFERENCE_MAX_AGE_MS),
            now + DAY_PLANNER_REFERENCE_MAX_AGE_MS,
        ),
        limitations: [
            MAPPED_REFERENCE_LIMITATION,
            `Discovery covers at most ${tiles.length} coarse one-degree map cells within a ${radiusNM.toFixed(1)} NM straight-line search radius; it is not a complete list of stops.`,
            ...(truncated
                ? ['The sailing area exceeds the four-cell discovery budget; only the nearest cells were searched.']
                : []),
            'Only exact mapped anchorage nodes are considered. Mooring availability and approximate way/relation centres are excluded. Only the Explore activity is supported by this map reference.',
        ],
    };
}
