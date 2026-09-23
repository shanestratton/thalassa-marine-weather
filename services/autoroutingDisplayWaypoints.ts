/**
 * A sparse index into a trial proposal, NOT a replacement route geometry.
 * The complete provider path must still be drawn, checked, saved and exported.
 */
export interface TrialDisplayWaypoint {
    coordinates: [number, number];
    /** Original vertex index; fractional for a marker inside an original leg. */
    pathIndex: number;
    /** Metres travelled along the complete original path, never a shortcut. */
    distanceM: number;
    kind: 'departure' | 'destination' | 'turn' | 'spacing' | 'handover';
}

type Coordinate = readonly [number, number];
type Vector = [number, number, number];
type MercatorPoint = { x: number; y: number; scale: number };

const EARTH_RADIUS_M = 6_371_000;
const SPACING_M = 50 * 1852;
const CORNER_TOLERANCE_M = 5;
const MAX_POINTS = 10_000;
const MAX_SIMPLIFICATION_CHECKS = 250_000;
const ANGULAR_EPSILON = 1e-12;
const DISTANCE_EPSILON_M = 1e-6;

const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector, b: Vector): Vector => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vector) => Math.hypot(...a);
const angle = (a: Vector, b: Vector) => Math.atan2(norm(cross(a, b)), dot(a, b));
const unit = (a: Vector): Vector => {
    const length = norm(a);
    return [a[0] / length, a[1] / length, a[2] / length];
};

function vector([lon, lat]: Coordinate): Vector {
    const latitude = (lat * Math.PI) / 180;
    const longitude = (lon * Math.PI) / 180;
    return [Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude)];
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const mercatorY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude / 2));
function longitudeChange(start: number, end: number): number {
    const change = end - start;
    return change > 180 ? change - 360 : change < -180 ? change + 360 : change;
}

/** Physical distance along the original straight-on-Mercator map segment. */
function segmentDistance(start: Coordinate, end: Coordinate, arc: number): number {
    // Mercator has no pole. These exceptional segments retain their spherical
    // interpretation rather than manufacturing non-finite map coordinates.
    if (Math.abs(start[1]) === 90 || Math.abs(end[1]) === 90) return arc * EARTH_RADIUS_M;
    const lat1 = radians(start[1]);
    const lat2 = radians(end[1]);
    const dLat = lat2 - lat1;
    const dPsi = mercatorY(lat2) - mercatorY(lat1);
    const q = Math.abs(dPsi) > ANGULAR_EPSILON ? dLat / dPsi : Math.cos(lat1);
    return Math.hypot(dLat, q * radians(longitudeChange(start[0], end[0]))) * EARTH_RADIUS_M;
}

/** Unwrap each longitude along the original path, not across the date line. */
function mercatorPoints(coordinates: readonly Coordinate[]): Array<MercatorPoint | null> {
    let longitude = coordinates[0][0];
    return coordinates.map(([lon, lat], i) => {
        if (i > 0) {
            let change = lon - coordinates[i - 1][0];
            if (change > 180) change -= 360;
            if (change < -180) change += 360;
            longitude += change;
        }
        if (Math.abs(lat) === 90) return null;
        const latitude = (lat * Math.PI) / 180;
        return {
            x: (longitude * Math.PI * EARTH_RADIUS_M) / 180,
            y: Math.log(Math.tan(Math.PI / 4 + latitude / 2)) * EARTH_RADIUS_M,
            scale: Math.cos(latitude),
        };
    });
}

function distanceToRhumb(point: MercatorPoint | null, start: MercatorPoint | null, end: MercatorPoint | null): number {
    if (!point || !start || !end) return Infinity;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const squareLength = dx * dx + dy * dy;
    const fraction = squareLength
        ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squareLength))
        : 0;
    // The largest scale is deliberately conservative; do not understate an
    // off-course corner simply because another point lies at high latitude.
    return (
        Math.hypot(point.x - start.x - fraction * dx, point.y - start.y - fraction * dy) *
        Math.max(point.scale, start.scale, end.scale)
    );
}

/** Distance to the finite minor great-circle arc, including its endpoints. */
function distanceToArc(point: Vector, start: Vector, end: Vector): number {
    const arc = angle(start, end);
    if (arc < ANGULAR_EPSILON) return angle(point, start) * EARTH_RADIUS_M;
    // No unique great circle between antipodes: retain a subdivision instead.
    if (Math.PI - arc < ANGULAR_EPSILON) return Infinity;
    const normal = unit(cross(start, end));
    const offPlane = dot(point, normal);
    const projected: Vector = [
        point[0] - offPlane * normal[0],
        point[1] - offPlane * normal[1],
        point[2] - offPlane * normal[2],
    ];
    if (norm(projected) > ANGULAR_EPSILON) {
        const foot = unit(projected);
        const along = Math.atan2(dot(cross(start, foot), normal), dot(start, foot));
        if (along >= 0 && along <= arc) {
            return Math.asin(Math.min(1, Math.abs(offPlane))) * EARTH_RADIUS_M;
        }
    }
    return Math.min(angle(point, start), angle(point, end)) * EARTH_RADIUS_M;
}

function interpolateArc(start: Vector, end: Vector, fraction: number): [number, number] {
    const arc = angle(start, end);
    const denominator = Math.sin(arc);
    const a = Math.sin((1 - fraction) * arc) / denominator;
    const b = Math.sin(fraction * arc) / denominator;
    const point = unit([a * start[0] + b * end[0], a * start[1] + b * end[1], a * start[2] + b * end[2]]);
    return [
        (Math.atan2(point[1], point[0]) * 180) / Math.PI,
        (Math.atan2(point[2], Math.hypot(point[0], point[1])) * 180) / Math.PI,
    ];
}

function interpolate(start: Coordinate, end: Coordinate, fraction: number): [number, number] {
    if (Math.abs(start[1]) === 90 || Math.abs(end[1]) === 90)
        return interpolateArc(vector(start), vector(end), fraction);
    const latitude = start[1] + (end[1] - start[1]) * fraction;
    const dPsi = mercatorY(radians(end[1])) - mercatorY(radians(start[1]));
    const projectedFraction =
        Math.abs(dPsi) > ANGULAR_EPSILON
            ? (mercatorY(radians(latitude)) - mercatorY(radians(start[1]))) / dPsi
            : fraction;
    const longitude = start[0] + longitudeChange(start[0], end[0]) * projectedFraction;
    return [((longitude + 540) % 360) - 180, latitude];
}

function validCoordinates(coordinates: readonly Coordinate[]): boolean {
    return (
        Array.isArray(coordinates) &&
        coordinates.length >= 2 &&
        coordinates.length <= MAX_POINTS &&
        Array.from(coordinates).every(
            (point) =>
                Array.isArray(point) &&
                point.length === 2 &&
                Number.isFinite(point[0]) &&
                Number.isFinite(point[1]) &&
                Math.abs(point[0]) <= 180 &&
                Math.abs(point[1]) <= 90,
        )
    );
}

/**
 * Keep meaningful corners (5 m great-circle OR rhumb-line deviation), explicit
 * handovers and endpoints. Add 50 NM marks BETWEEN those anchors by original
 * path distance. An empty result means unsupported input, not a usable route.
 */
export function buildTrialDisplayWaypoints(
    coordinates: readonly Coordinate[],
    protectedIndices: readonly number[] = [],
    editedWaypointIndices: readonly number[] = [],
): TrialDisplayWaypoint[] {
    if (
        !validCoordinates(coordinates) ||
        !Array.isArray(protectedIndices) ||
        protectedIndices.length > MAX_POINTS ||
        Array.from(protectedIndices).some(
            (index) => !Number.isInteger(index) || index < 0 || index >= coordinates.length,
        ) ||
        !Array.isArray(editedWaypointIndices) ||
        editedWaypointIndices.length > MAX_POINTS ||
        Array.from(editedWaypointIndices).some(
            (index) => !Number.isInteger(index) || index < 0 || index >= coordinates.length,
        )
    ) {
        return [];
    }

    const vectors = coordinates.map(vector);
    const mercator = mercatorPoints(coordinates);
    const distances = [0];
    for (let i = 1; i < vectors.length; i++) {
        const arc = angle(vectors[i - 1], vectors[i]);
        // A raw antipodal leg cannot be uniquely interpolated or displayed.
        if (Math.PI - arc < ANGULAR_EPSILON) return [];
        distances.push(distances[i - 1] + segmentDistance(coordinates[i - 1], coordinates[i], arc));
    }
    const last = coordinates.length - 1;
    const protectedSet = new Set(protectedIndices);
    // User-moved anchors survive sparse display simplification, but they are
    // ordinary editable pins: never mislabel them as verified canal handovers.
    const retained = new Set([0, last, ...protectedSet, ...editedWaypointIndices]);

    // Finite-arc simplification alone misses collinear backtracking when every
    // vertex is between the endpoints. Keep reversals even if they are <5 m.
    let previousDistinct = 0;
    for (let i = 1; i < last; i++) {
        if (angle(vectors[previousDistinct], vectors[i]) < ANGULAR_EPSILON) continue;
        let next = i + 1;
        while (next <= last && angle(vectors[i], vectors[next]) < ANGULAR_EPSILON) next++;
        if (next <= last) {
            const before = dot(vectors[previousDistinct], vectors[i]);
            const after = dot(vectors[next], vectors[i]);
            const incoming: Vector = [
                before * vectors[i][0] - vectors[previousDistinct][0],
                before * vectors[i][1] - vectors[previousDistinct][1],
                before * vectors[i][2] - vectors[previousDistinct][2],
            ];
            const outgoing: Vector = [
                vectors[next][0] - after * vectors[i][0],
                vectors[next][1] - after * vectors[i][1],
                vectors[next][2] - after * vectors[i][2],
            ];
            if (dot(incoming, outgoing) <= 0) retained.add(i);
        }
        previousDistinct = i;
    }

    const anchors = [...retained].sort((a, b) => a - b);
    const intervals: Array<[number, number]> = anchors.slice(1).map((end, i) => [anchors[i], end]);
    let checks = 0;
    while (intervals.length) {
        const [start, end] = intervals.pop()!;
        if (end - start < 2) continue;
        if (checks + end - start - 1 > MAX_SIMPLIFICATION_CHECKS) {
            // Highly jagged/adversarial input stays detailed rather than
            // consuming unbounded work or silently omitting its corners.
            for (let i = start + 1; i < end; i++) retained.add(i);
            continue;
        }
        checks += end - start - 1;
        let arcDistance = CORNER_TOLERANCE_M;
        let rhumbDistance = CORNER_TOLERANCE_M;
        let arcFurthest = -1;
        let rhumbFurthest = -1;
        for (let i = start + 1; i < end; i++) {
            // A constant compass course at Queensland latitudes is a rhumb
            // line, not a great circle. Either straight-course representation
            // is sufficient for sparse DISPLAY marks; no path is substituted.
            const arcCandidate = distanceToArc(vectors[i], vectors[start], vectors[end]);
            const rhumbCandidate = distanceToRhumb(mercator[i], mercator[start], mercator[end]);
            if (arcCandidate > arcDistance) {
                arcDistance = arcCandidate;
                arcFurthest = i;
            }
            if (rhumbCandidate > rhumbDistance) {
                rhumbDistance = rhumbCandidate;
                rhumbFurthest = i;
            }
        }
        // One model must fit the WHOLE interval, not a different model per
        // vertex (which could otherwise hide the transition between them).
        const furthest = arcDistance <= rhumbDistance ? arcFurthest : rhumbFurthest;
        if (furthest !== -1) {
            retained.add(furthest);
            intervals.push([start, furthest], [furthest, end]);
        }
    }

    const output: TrialDisplayWaypoint[] = [];
    const sorted = [...retained].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
        const index = sorted[i];
        if (i > 0) {
            let segmentEnd = sorted[i - 1] + 1;
            for (
                let distance = distances[sorted[i - 1]] + SPACING_M;
                distance < distances[index] - DISTANCE_EPSILON_M;
                distance += SPACING_M
            ) {
                if (output.length >= MAX_POINTS) return [];
                while (segmentEnd < index && distances[segmentEnd] < distance - DISTANCE_EPSILON_M) segmentEnd++;
                const exact = Math.abs(distances[segmentEnd] - distance) <= DISTANCE_EPSILON_M;
                const fraction = exact
                    ? 1
                    : (distance - distances[segmentEnd - 1]) / (distances[segmentEnd] - distances[segmentEnd - 1]);
                output.push({
                    coordinates: exact
                        ? [...coordinates[segmentEnd]]
                        : interpolate(coordinates[segmentEnd - 1], coordinates[segmentEnd], fraction),
                    pathIndex: exact ? segmentEnd : segmentEnd - 1 + fraction,
                    distanceM: exact ? distances[segmentEnd] : distance,
                    kind: 'spacing',
                });
            }
        }
        if (output.length >= MAX_POINTS) return [];
        output.push({
            coordinates: [...coordinates[index]],
            pathIndex: index,
            distanceM: distances[index],
            kind:
                index === 0
                    ? 'departure'
                    : index === last
                      ? 'destination'
                      : protectedSet.has(index)
                        ? 'handover'
                        : 'turn',
        });
    }
    return output;
}

/**
 * Inspection must remain possible when sparse marking is unsupported. Keep
 * every original vertex in that case and let the UI announce its dense mode.
 * This fallback neither repairs invalid geometry nor implies route clearance.
 */
export function buildTrialWaypointPlan(
    coordinates: readonly Coordinate[],
    protectedIndices: readonly number[] = [],
    editedWaypointIndices: readonly number[] = [],
): { waypoints: TrialDisplayWaypoint[]; sparse: boolean } {
    if (!validCoordinates(coordinates)) return { waypoints: [], sparse: false };
    const sparse = buildTrialDisplayWaypoints(coordinates, protectedIndices, editedWaypointIndices);
    if (sparse.length) return { waypoints: sparse, sparse: true };
    const protectedSet = new Set(Array.isArray(protectedIndices) ? protectedIndices : []);
    let distanceM = 0;
    const waypoints = coordinates.map((coordinatesAtIndex, index): TrialDisplayWaypoint => {
        if (index > 0) {
            const arc = angle(vector(coordinates[index - 1]), vector(coordinatesAtIndex));
            const distance = segmentDistance(coordinates[index - 1], coordinatesAtIndex, arc);
            distanceM += Number.isFinite(distance) ? distance : arc * EARTH_RADIUS_M;
        }
        return {
            coordinates: [...coordinatesAtIndex],
            pathIndex: index,
            distanceM,
            kind:
                index === 0
                    ? 'departure'
                    : index === coordinates.length - 1
                      ? 'destination'
                      : protectedSet.has(index)
                        ? 'handover'
                        : 'turn',
        };
    });
    return { waypoints, sparse: false };
}

/** Zero-based index of the arriving display waypoint; -1 for invalid input. */
export function displayWaypointForPathIndex(waypoints: readonly TrialDisplayWaypoint[], pathIndex: number): number {
    if (!waypoints.length || !Number.isFinite(pathIndex)) return -1;
    let low = 0;
    let high = waypoints.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (waypoints[middle].pathIndex < pathIndex) low = middle + 1;
        else high = middle;
    }
    return low;
}

/**
 * Original zero-based legs touched by the arriving display leg. An interpolated
 * boundary includes its original leg on BOTH sides: no finding may be hidden.
 */
export function displayWaypointLegRange(
    waypoints: readonly TrialDisplayWaypoint[],
    index: number,
): { first: number; last: number } | null {
    if (!Number.isInteger(index) || index <= 0 || index >= waypoints.length) return null;
    const first = Math.floor(waypoints[index - 1].pathIndex);
    const last = Math.ceil(waypoints[index].pathIndex) - 1;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || last < first) return null;
    return { first, last };
}
