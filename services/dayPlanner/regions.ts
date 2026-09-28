import { resolveTimeZone } from '../../utils/timezone';
import { WHITSUNDAYS_DAY_DESTINATIONS, type DayPlannerDestination } from './destinations';

export interface DayPlannerRegion {
    id: string;
    name: string;
    timeZone: string;
    /** Inclusive bounds. west > east denotes an antimeridian-crossing area. */
    bounds: { west: number; south: number; east: number; north: number };
    /** A public catalogue query, never the user's exact vessel position. */
    reference: { center: { lat: number; lon: number }; radiusNM: number; dataset: 'qld' };
    destinations: readonly DayPlannerDestination[];
    sourceAttributions: readonly string[];
}

export interface DayPlannerArea {
    id: string;
    name: string;
    timeZone: string;
    coverage: 'reviewed' | 'mapped-reference';
    region?: DayPlannerRegion;
}

export const WHITSUNDAYS_DAY_PLANNER_REGION: DayPlannerRegion = {
    id: 'whitsundays',
    name: 'Whitsundays',
    timeZone: 'Australia/Brisbane',
    bounds: { west: 148.4, south: -21, east: 149.5, north: -19.5 },
    reference: { center: { lat: -20.2, lon: 148.95 }, radiusNM: 35, dataset: 'qld' },
    destinations: WHITSUNDAYS_DAY_DESTINATIONS,
    sourceAttributions: ['Queensland Parks', 'OpenStreetMap contributors (ODbL)', 'GBRMPA (CC BY)'],
};

/** Reviewed coverage only. Worldwide mapped references are not reviewed packs. */
export const DAY_PLANNER_REGIONS: readonly DayPlannerRegion[] = [WHITSUNDAYS_DAY_PLANNER_REGION];

type Point = { lat: number; lon: number };
const finiteBetween = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value: unknown, maximum = 4096): value is string =>
    typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= maximum;
const stableId = (value: unknown): value is string => text(value, 160) && /^[a-z0-9][a-z0-9-]*$/.test(value);
const pointValid = (point: Point) =>
    !!point && finiteBetween(point.lat, -90, 90) && finiteBetween(point.lon, -180, 180);
const localDateValid = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const milliseconds = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value;
};
const timeZoneValid = (value: unknown): value is string => {
    if (!text(value, 120) || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
        return true;
    } catch {
        return false;
    }
};
const sourceUrlValid = (value: unknown) => {
    if (!text(value, 2048)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch {
        return false;
    }
};
const noteListValid = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every((note) => text(note));

function contains(region: DayPlannerRegion, point: Point): boolean {
    const { west, east, south, north } = region.bounds;
    const longitudeInside = (lon: number) => (west <= east ? lon >= west && lon <= east : lon >= west || lon <= east);
    return (
        point.lat >= south &&
        point.lat <= north &&
        (longitudeInside(point.lon) || (Math.abs(point.lon) === 180 && longitudeInside(-point.lon)))
    );
}

function distanceNM(from: Point, to: Point): number {
    const radians = Math.PI / 180;
    const deltaLat = (to.lat - from.lat) * radians;
    const deltaLon = (to.lon - from.lon) * radians;
    const a =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(deltaLon / 2) ** 2;
    return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Validate static catalogue metadata, not chart clearance or source accuracy.
 * Exact ID/name/coordinate agreement with a loaded dataset remains mandatory
 * in the runtime adapter; this registry cannot authorize an approach position. */
export function validateDayPlannerRegions(regions: readonly DayPlannerRegion[]): void {
    if (!Array.isArray(regions as unknown)) throw new Error('The reviewed day-planner registry is unavailable.');
    const regionIds = new Set<string>();
    const destinationIds = new Set<string>();
    const anchorageIds = new Set<string>();
    for (const region of regions) {
        const bounds = region?.bounds;
        const reference = region?.reference;
        if (
            !region ||
            !stableId(region.id) ||
            regionIds.has(region.id) ||
            !text(region.name, 160) ||
            !timeZoneValid(region.timeZone) ||
            !bounds ||
            !finiteBetween(bounds.west, -180, 180) ||
            !finiteBetween(bounds.east, -180, 180) ||
            bounds.west === bounds.east ||
            (bounds.west === 180 && bounds.east === -180) ||
            !finiteBetween(bounds.south, -90, 90) ||
            !finiteBetween(bounds.north, -90, 90) ||
            bounds.south >= bounds.north ||
            !reference ||
            reference.dataset !== 'qld' ||
            !pointValid(reference.center) ||
            !finiteBetween(reference.radiusNM, 0.1, 100) ||
            !contains(region, reference.center) ||
            !noteListValid(region.sourceAttributions) ||
            !Array.isArray(region.destinations as unknown) ||
            !region.destinations.length
        )
            throw new Error('Reviewed day-planner region metadata is invalid.');
        regionIds.add(region.id);
        for (const destination of region.destinations) {
            if (
                !destination ||
                !stableId(destination.id) ||
                destinationIds.has(destination.id) ||
                !text(destination.name, 200) ||
                !pointValid(destination) ||
                !contains(region, destination) ||
                distanceNM(reference.center, destination) > reference.radiusNM ||
                destination.catalogueQuality !== 'reviewed' ||
                !localDateValid(destination.verifiedAt) ||
                (destination.timeZone !== undefined && !timeZoneValid(destination.timeZone)) ||
                !text(destination.summary) ||
                !sourceUrlValid(destination.sourceUrl) ||
                !text(destination.sourceLabel, 500) ||
                !text(destination.anchorageId, 200) ||
                anchorageIds.has(destination.anchorageId) ||
                !text(destination.anchorageName, 200) ||
                destination.referencePosition !== 'existing-anchorage' ||
                !noteListValid(destination.accessNotes) ||
                !noteListValid(destination.uncertaintyNotes) ||
                !Array.isArray(destination.activities) ||
                !destination.activities.length ||
                new Set(destination.activities).size !== destination.activities.length ||
                !destination.activities.every((activity) =>
                    ['snorkel', 'beach', 'walk', 'lunch', 'quiet', 'explore'].includes(activity),
                ) ||
                (destination.openMapUrl !== undefined && !sourceUrlValid(destination.openMapUrl)) ||
                (destination.supportingSources !== undefined &&
                    (!Array.isArray(destination.supportingSources) ||
                        !destination.supportingSources.every(
                            (source) => source && sourceUrlValid(source.url) && text(source.label, 500),
                        ))) ||
                (destination.knownClosures !== undefined &&
                    (!Array.isArray(destination.knownClosures) ||
                        !destination.knownClosures.every(
                            (closure) =>
                                closure &&
                                localDateValid(closure.fromDate) &&
                                localDateValid(closure.throughDate) &&
                                closure.fromDate <= closure.throughDate &&
                                text(closure.reason) &&
                                sourceUrlValid(closure.sourceUrl),
                        )))
            )
                throw new Error(`Reviewed destination metadata is invalid in ${region.name}.`);
            destinationIds.add(destination.id);
            anchorageIds.add(destination.anchorageId);
        }
    }
}

/** No nearest-region guess. Boundary overlap is ambiguous and fails closed. */
export function findDayPlannerRegion(point: Point, regions = DAY_PLANNER_REGIONS): DayPlannerRegion | undefined {
    if (!pointValid(point)) throw new Error('Choose a valid departure position.');
    validateDayPlannerRegions(regions);
    const matches = regions.filter((region) => contains(region, point));
    if (matches.length > 1) throw new Error('Reviewed day-planner regions overlap at this position.');
    return matches[0];
}

export function coveredRegionNames(regions = DAY_PLANNER_REGIONS): string[] {
    validateDayPlannerRegions(regions);
    return regions.map((region) => region.name);
}

/** Synchronous display context only; no promise of mapped candidates or routes. */
export function resolvePlanningArea(point: Point, regions = DAY_PLANNER_REGIONS): DayPlannerArea {
    const region = findDayPlannerRegion(point, regions);
    if (region) return { id: region.id, name: region.name, timeZone: region.timeZone, coverage: 'reviewed', region };
    const timeZone = resolveTimeZone(point.lat, point.lon);
    if (!timeZoneValid(timeZone)) throw new Error('The departure timezone could not be resolved.');
    return { id: 'mapped-reference', name: 'Nearby mapped anchorages', timeZone, coverage: 'mapped-reference' };
}
