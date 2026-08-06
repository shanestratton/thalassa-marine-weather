/**
 * Fail-fast resource boundary shared by the Pi ENC HTTP routes and routing
 * engine. The inshore router builds several arrays proportional to its grid,
 * so request validation must happen before chart reads and before any grid
 * allocation.
 */

export const DEFAULT_ROUTE_RESOLUTION_M = 50;
export const MIN_ROUTE_RESOLUTION_M = 10;
export const MAX_ROUTE_RESOLUTION_M = 1_000;
export const MAX_ROUTE_SAFETY_M = 20;
export const MAX_ROUTE_OBSTRUCTION_BUFFER_M = 2_000;
export const MAX_ROUTE_MIN_COMPONENT_CELLS = 100_000;
export const MAX_ROUTE_AXIS_SPAN_DEG = 5;
export const MAX_ROUTE_GRID_CELLS = 2_000_000;
export const MAX_ROUTE_CELL_IDS = 128;
export const MAX_PREPPED_LAYERS = 32;
export const MAX_PREPPED_FEATURES = 100_000;
export const MAX_PREPPED_COORDINATE_POSITIONS = 2_000_000;
const MAX_COORDINATE_NESTING = 16;

const M_PER_DEG_LAT = 111_320;
const CELL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RouteBoundaryCode =
    | 'invalid-route-request'
    | 'route-span-too-large'
    | 'route-grid-too-large'
    | 'route-cell-selection-too-large'
    | 'route-data-too-large';

export interface RouteBoundaryIssue {
    status: 400 | 413;
    code: RouteBoundaryCode;
    error: string;
}

interface RouteValues {
    fromLat: number;
    fromLon: number;
    toLat: number;
    toLon: number;
    draftM: number;
    resolutionM?: number;
    safetyM?: number;
    obstructionBufferM?: number;
    minComponentCells?: number;
}

interface RouteBoundaryOptions {
    validateCellIds?: boolean;
    validatePreparedLayers?: boolean;
}

export interface RouteGridDimensions {
    width: number;
    height: number;
    cells: number;
    dLon: number;
    dLat: number;
}

type GridBudgetResult = { ok: true; dimensions: RouteGridDimensions } | { ok: false; issue: RouteBoundaryIssue };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(status: 400 | 413, code: RouteBoundaryCode, error: string): RouteBoundaryIssue {
    return { status, code, error };
}

function requiredFiniteNumber(body: Record<string, unknown>, field: keyof RouteValues): RouteBoundaryIssue | null {
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return issue(400, 'invalid-route-request', `${field} must be a finite number`);
    }
    return null;
}

function optionalNumberInRange(
    body: Record<string, unknown>,
    field: 'resolutionM' | 'safetyM' | 'obstructionBufferM',
    minimum: number,
    maximum: number,
): RouteBoundaryIssue | null {
    const value = body[field];
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        return issue(
            400,
            'invalid-route-request',
            `${field} must be a finite number between ${minimum} and ${maximum}`,
        );
    }
    return null;
}

/** The exact padded envelope used by the inshore engine. */
export function routeGridEnvelope(
    route: Pick<RouteValues, 'fromLat' | 'fromLon' | 'toLat' | 'toLon'>,
): [number, number, number, number] {
    const minLat = Math.min(route.fromLat, route.toLat);
    const maxLat = Math.max(route.fromLat, route.toLat);
    const minLon = Math.min(route.fromLon, route.toLon);
    const maxLon = Math.max(route.fromLon, route.toLon);
    const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);
    const padding = Math.max(maxSpan * 0.5, 0.08);
    return [minLon - padding, minLat - padding, maxLon + padding, maxLat + padding];
}

/** Calculate dimensions without allocating the routing grid. */
export function inspectRouteGridBudget(
    bbox: readonly [number, number, number, number],
    resolutionM: number,
): GridBudgetResult {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const midLat = (minLat + maxLat) / 2;
    const metersPerDegreeLon = Math.abs(M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));
    const dLon = resolutionM / metersPerDegreeLon;
    const dLat = resolutionM / M_PER_DEG_LAT;
    const rawWidth = Math.ceil((maxLon - minLon) / dLon);
    const rawHeight = Math.ceil((maxLat - minLat) / dLat);

    if (
        !Number.isFinite(dLon) ||
        !Number.isFinite(dLat) ||
        dLon <= 0 ||
        dLat <= 0 ||
        !Number.isSafeInteger(rawWidth) ||
        !Number.isSafeInteger(rawHeight) ||
        rawWidth < 0 ||
        rawHeight < 0
    ) {
        return {
            ok: false,
            issue: issue(413, 'route-grid-too-large', 'Route grid dimensions are outside the supported range'),
        };
    }

    const width = Math.max(1, rawWidth);
    const height = Math.max(1, rawHeight);
    if (width > MAX_ROUTE_GRID_CELLS || height > Math.floor(MAX_ROUTE_GRID_CELLS / width)) {
        return {
            ok: false,
            issue: issue(
                413,
                'route-grid-too-large',
                `Route grid exceeds the ${MAX_ROUTE_GRID_CELLS.toLocaleString('en-US')}-cell Pi limit`,
            ),
        };
    }

    return { ok: true, dimensions: { width, height, cells: width * height, dLon, dLat } };
}

function inspectCellIds(value: unknown): RouteBoundaryIssue | null {
    if (value === undefined) return null;
    if (!Array.isArray(value)) {
        return issue(400, 'invalid-route-request', 'cellIds must be an array of chart cell identifiers');
    }
    if (value.length > MAX_ROUTE_CELL_IDS) {
        return issue(
            413,
            'route-cell-selection-too-large',
            `cellIds exceeds the ${MAX_ROUTE_CELL_IDS}-cell route limit`,
        );
    }
    if (value.some((cellId) => typeof cellId !== 'string' || !CELL_ID_RE.test(cellId))) {
        return issue(400, 'invalid-route-request', 'cellIds contains an invalid chart cell identifier');
    }
    if (new Set(value).size !== value.length) {
        return issue(400, 'invalid-route-request', 'cellIds must not contain duplicates');
    }
    return null;
}

type CoordinateCountResult = { ok: true; count: number } | { ok: false; issue: RouteBoundaryIssue };

/** Count coordinate positions with depth-bounded iteration rather than recursion. */
function countCoordinatePositions(value: unknown, maximum: number): CoordinateCountResult {
    if (!Array.isArray(value)) {
        return { ok: false, issue: issue(400, 'invalid-route-request', 'GeoJSON coordinates must be arrays') };
    }

    let count = 0;
    const stack: Array<{ coordinates: unknown[]; index: number }> = [{ coordinates: value, index: 0 }];
    while (stack.length > 0) {
        if (stack.length > MAX_COORDINATE_NESTING) {
            return {
                ok: false,
                issue: issue(413, 'route-data-too-large', 'Prepared route geometry is nested too deeply'),
            };
        }
        const frame = stack[stack.length - 1];
        const coordinates = frame.coordinates;
        if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
            if (!Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
                return {
                    ok: false,
                    issue: issue(
                        400,
                        'invalid-route-request',
                        'Prepared route geometry contains a non-finite coordinate',
                    ),
                };
            }
            count++;
            if (count > maximum) {
                return {
                    ok: false,
                    issue: issue(
                        413,
                        'route-data-too-large',
                        `Prepared route exceeds the ${MAX_PREPPED_COORDINATE_POSITIONS.toLocaleString('en-US')}-position limit`,
                    ),
                };
            }
            stack.pop();
            continue;
        }
        if (frame.index >= coordinates.length) {
            stack.pop();
            continue;
        }
        const child = coordinates[frame.index++];
        if (!Array.isArray(child)) {
            return {
                ok: false,
                issue: issue(400, 'invalid-route-request', 'Prepared route geometry contains malformed coordinates'),
            };
        }
        stack.push({ coordinates: child, index: 0 });
    }
    return { ok: true, count };
}

/** Include coordinates nested below valid GeoJSON GeometryCollections. */
function countGeometryPositions(value: unknown, maximum: number): CoordinateCountResult {
    if (!isRecord(value)) {
        return { ok: false, issue: issue(400, 'invalid-route-request', 'Prepared route contains malformed geometry') };
    }

    let count = 0;
    const stack: Array<{ geometry: Record<string, unknown>; depth: number }> = [{ geometry: value, depth: 1 }];
    while (stack.length > 0) {
        const { geometry, depth } = stack.pop()!;
        if (typeof geometry.type !== 'string') {
            return {
                ok: false,
                issue: issue(400, 'invalid-route-request', 'Prepared route contains malformed geometry'),
            };
        }

        if (Object.prototype.hasOwnProperty.call(geometry, 'coordinates')) {
            const counted = countCoordinatePositions(geometry.coordinates, maximum - count);
            if (!counted.ok) return counted;
            count += counted.count;
        }
        if (Object.prototype.hasOwnProperty.call(geometry, 'geometries')) {
            if (!Array.isArray(geometry.geometries)) {
                return {
                    ok: false,
                    issue: issue(400, 'invalid-route-request', 'Prepared route contains malformed geometries'),
                };
            }
            if (depth >= MAX_COORDINATE_NESTING && geometry.geometries.length > 0) {
                return {
                    ok: false,
                    issue: issue(413, 'route-data-too-large', 'Prepared route geometry is nested too deeply'),
                };
            }
            for (const child of geometry.geometries) {
                if (!isRecord(child)) {
                    return {
                        ok: false,
                        issue: issue(400, 'invalid-route-request', 'Prepared route contains malformed geometry'),
                    };
                }
                stack.push({ geometry: child, depth: depth + 1 });
            }
        }
    }
    return { ok: true, count };
}

function inspectPreparedLayers(value: unknown): RouteBoundaryIssue | null {
    if (!isRecord(value)) return issue(400, 'invalid-route-request', 'layers must be an object');
    const layerEntries = Object.entries(value);
    if (layerEntries.length > MAX_PREPPED_LAYERS) {
        return issue(413, 'route-data-too-large', `Prepared route exceeds the ${MAX_PREPPED_LAYERS}-layer limit`);
    }

    let featureCount = 0;
    let coordinateCount = 0;
    for (const [, collection] of layerEntries) {
        if (collection === undefined) continue;
        if (!isRecord(collection) || !Array.isArray(collection.features)) {
            return issue(400, 'invalid-route-request', 'Every prepared route layer must contain a features array');
        }
        featureCount += collection.features.length;
        if (featureCount > MAX_PREPPED_FEATURES) {
            return issue(
                413,
                'route-data-too-large',
                `Prepared route exceeds the ${MAX_PREPPED_FEATURES.toLocaleString('en-US')}-feature limit`,
            );
        }
        for (const feature of collection.features) {
            if (!isRecord(feature)) {
                return issue(400, 'invalid-route-request', 'Prepared route contains a malformed feature');
            }
            const geometry = feature.geometry;
            if (geometry == null) continue;
            const counted = countGeometryPositions(geometry, MAX_PREPPED_COORDINATE_POSITIONS - coordinateCount);
            if (!counted.ok) return counted.issue;
            coordinateCount += counted.count;
            if (coordinateCount > MAX_PREPPED_COORDINATE_POSITIONS) {
                return issue(
                    413,
                    'route-data-too-large',
                    `Prepared route exceeds the ${MAX_PREPPED_COORDINATE_POSITIONS.toLocaleString('en-US')}-position limit`,
                );
            }
        }
    }
    return null;
}

/**
 * Validate the complete HTTP or engine routing question. A returned issue is a
 * stable response payload; null means the request is within every Pi budget.
 */
export function validateInshoreRouteBoundary(
    value: unknown,
    options: RouteBoundaryOptions = {},
): RouteBoundaryIssue | null {
    if (!isRecord(value)) return issue(400, 'invalid-route-request', 'Route body must be an object');

    for (const field of ['fromLat', 'fromLon', 'toLat', 'toLon', 'draftM'] as const) {
        const invalid = requiredFiniteNumber(value, field);
        if (invalid) return invalid;
    }

    const route = value as unknown as RouteValues;
    if (Math.abs(route.fromLat) > 90 || Math.abs(route.toLat) > 90) {
        return issue(400, 'invalid-route-request', 'Latitude is outside the WGS84 range');
    }
    if (Math.abs(route.fromLon) > 180 || Math.abs(route.toLon) > 180) {
        return issue(400, 'invalid-route-request', 'Longitude is outside the WGS84 range');
    }
    if (route.draftM < 0 || route.draftM > 30) {
        return issue(400, 'invalid-route-request', 'draftM must be between 0 and 30 metres');
    }

    const optionalChecks = [
        optionalNumberInRange(value, 'resolutionM', MIN_ROUTE_RESOLUTION_M, MAX_ROUTE_RESOLUTION_M),
        optionalNumberInRange(value, 'safetyM', 0, MAX_ROUTE_SAFETY_M),
        optionalNumberInRange(value, 'obstructionBufferM', 0, MAX_ROUTE_OBSTRUCTION_BUFFER_M),
    ];
    const invalidOptional = optionalChecks.find((candidate) => candidate !== null);
    if (invalidOptional) return invalidOptional;
    if (
        route.minComponentCells !== undefined &&
        (typeof route.minComponentCells !== 'number' ||
            !Number.isSafeInteger(route.minComponentCells) ||
            route.minComponentCells < 1 ||
            route.minComponentCells > MAX_ROUTE_MIN_COMPONENT_CELLS)
    ) {
        return issue(
            400,
            'invalid-route-request',
            `minComponentCells must be an integer between 1 and ${MAX_ROUTE_MIN_COMPONENT_CELLS}`,
        );
    }

    const axisSpan = Math.max(Math.abs(route.toLat - route.fromLat), Math.abs(route.toLon - route.fromLon));
    if (axisSpan > MAX_ROUTE_AXIS_SPAN_DEG) {
        return issue(
            413,
            'route-span-too-large',
            `Route span exceeds the ${MAX_ROUTE_AXIS_SPAN_DEG}-degree inshore limit`,
        );
    }

    const grid = inspectRouteGridBudget(routeGridEnvelope(route), route.resolutionM ?? DEFAULT_ROUTE_RESOLUTION_M);
    if (!grid.ok) return grid.issue;

    if (options.validateCellIds) {
        const invalidCellIds = inspectCellIds(value.cellIds);
        if (invalidCellIds) return invalidCellIds;
    }
    if (options.validatePreparedLayers) {
        const invalidLayers = inspectPreparedLayers(value.layers);
        if (invalidLayers) return invalidLayers;
    }
    return null;
}
