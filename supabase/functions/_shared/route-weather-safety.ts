import { lerpDegrees } from './ww3.ts';

export const MAX_ROUTE_REQUEST_BYTES = 256 * 1024;
export const MAX_CENTERLINE_POINTS = 200;
export const MAX_ROUTE_DISTANCE_NM = 2_000;
export const MAX_CORRIDOR_WIDTH_NM = 120;
export const MAX_LATERAL_STEPS = 4;
export const MAX_ROUTE_MESH_NODES = 1_800;
export const MAX_ROUTE_MESH_ROW_SPACING_NM = 20;
export const MAX_WEATHER_SAMPLE_POINTS = 200;
export const MAX_ROUTE_FORECAST_HOURS = 120;
export const MAX_DEPARTURE_LEAD_HOURS = 120;
export const MAX_DEPARTURE_PAST_HOURS = 1;

const EARTH_RADIUS_NM = 3440.065;
const DEG_TO_RAD = Math.PI / 180;

export interface ValidatedCenterlineWaypoint {
    lat: number;
    lon: number;
    depth_m?: number;
    name?: string;
}

export interface ValidatedPolarData {
    windSpeeds: number[];
    angles: number[];
    matrix: number[][];
}

export interface ValidatedVesselParams {
    type: 'sail' | 'power';
    cruising_speed_kts: number;
    max_wind_kts: number;
    max_wave_m: number;
    draft_m: number;
    polar_data?: ValidatedPolarData | null;
}

export interface ValidatedWeatherRouteRequest {
    centerline: ValidatedCenterlineWaypoint[];
    departure_time: string;
    vessel: ValidatedVesselParams;
    corridor_width_nm?: number;
    lateral_steps?: number;
}

export interface WeatherKitHour {
    forecastStart: string;
    windSpeed?: number;
    windGust?: number;
    windDirection?: number;
}

export interface AlignedWindSample {
    windSpeed: number;
    windGust: number;
    windDir: number;
}

export class RouteWeatherSafetyError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(message: string, status = 400, code = 'invalid_route_weather_request') {
        super(message);
        this.name = 'RouteWeatherSafetyError';
        this.status = status;
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new RouteWeatherSafetyError(`${label} must be a finite number between ${min} and ${max}`);
    }
    return value;
}

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rowsRequiredAtSpacing(centerline: ValidatedCenterlineWaypoint[], spacingNM: number): number {
    let rows = 1;
    for (let index = 1; index < centerline.length; index++) {
        const previous = centerline[index - 1];
        const current = centerline[index];
        rows += Math.max(1, Math.ceil(haversineNM(previous.lat, previous.lon, current.lat, current.lon) / spacingNM));
    }
    return rows;
}

/**
 * Add forecast-evaluation rows along sparse centerline legs while retaining
 * every supplied waypoint. The spacing expands only when necessary to keep
 * the resulting corridor mesh inside its hard node budget.
 */
export function densifyCenterlineForMesh(
    centerline: ValidatedCenterlineWaypoint[],
    maxRows: number,
    targetSpacingNM = 10,
): ValidatedCenterlineWaypoint[] {
    if (
        centerline.length < 2 ||
        !Number.isInteger(maxRows) ||
        maxRows < centerline.length ||
        !Number.isFinite(targetSpacingNM) ||
        targetSpacingNM <= 0
    ) {
        throw new RouteWeatherSafetyError('Centerline cannot be densified within the safe mesh limit', 413);
    }

    let spacingNM = targetSpacingNM;
    if (rowsRequiredAtSpacing(centerline, spacingNM) > maxRows) {
        let lower = spacingNM;
        let upper = MAX_ROUTE_DISTANCE_NM;
        for (let iteration = 0; iteration < 48; iteration++) {
            const candidate = (lower + upper) / 2;
            if (rowsRequiredAtSpacing(centerline, candidate) > maxRows) {
                lower = candidate;
            } else {
                upper = candidate;
            }
        }
        spacingNM = upper;
    }
    if (spacingNM > MAX_ROUTE_MESH_ROW_SPACING_NM) {
        throw new RouteWeatherSafetyError(
            `Route cannot keep forecast rows within ${MAX_ROUTE_MESH_ROW_SPACING_NM} NM under the safe mesh limit`,
            413,
            'route_mesh_too_sparse',
        );
    }

    const dense: ValidatedCenterlineWaypoint[] = [{ ...centerline[0] }];
    for (let index = 1; index < centerline.length; index++) {
        const previous = centerline[index - 1];
        const current = centerline[index];
        const segmentDistance = haversineNM(previous.lat, previous.lon, current.lat, current.lon);
        const steps = Math.max(1, Math.ceil(segmentDistance / spacingNM));
        for (let step = 1; step < steps; step++) {
            const fraction = step / steps;
            const interpolatedDepth =
                previous.depth_m === undefined || current.depth_m === undefined
                    ? undefined
                    : previous.depth_m + (current.depth_m - previous.depth_m) * fraction;
            dense.push({
                lat: previous.lat + (current.lat - previous.lat) * fraction,
                lon: previous.lon + (current.lon - previous.lon) * fraction,
                ...(interpolatedDepth === undefined ? {} : { depth_m: interpolatedDepth }),
            });
        }
        dense.push({ ...current });
    }

    if (dense.length > maxRows) {
        throw new RouteWeatherSafetyError('Densified centerline exceeds the safe mesh limit', 413);
    }
    return dense;
}

function validatePolarData(value: unknown): ValidatedPolarData | null {
    if (value === undefined || value === null) return null;
    if (
        !isRecord(value) ||
        !Array.isArray(value.windSpeeds) ||
        !Array.isArray(value.angles) ||
        !Array.isArray(value.matrix)
    ) {
        throw new RouteWeatherSafetyError('vessel.polar_data must contain windSpeeds, angles, and matrix arrays');
    }
    if (
        value.windSpeeds.length < 2 ||
        value.windSpeeds.length > 30 ||
        value.angles.length < 2 ||
        value.angles.length > 30 ||
        value.windSpeeds.length * value.angles.length > 900
    ) {
        throw new RouteWeatherSafetyError('vessel.polar_data dimensions are outside safe limits');
    }

    const windSpeeds = value.windSpeeds.map((speed, index) =>
        numberInRange(speed, 0.1, 150, `vessel.polar_data.windSpeeds[${index}]`),
    );
    const angles = value.angles.map((angle, index) =>
        numberInRange(angle, 0, 180, `vessel.polar_data.angles[${index}]`),
    );
    for (let index = 1; index < windSpeeds.length; index++) {
        if (windSpeeds[index] <= windSpeeds[index - 1]) {
            throw new RouteWeatherSafetyError('vessel.polar_data.windSpeeds must be strictly increasing');
        }
    }
    for (let index = 1; index < angles.length; index++) {
        if (angles[index] <= angles[index - 1]) {
            throw new RouteWeatherSafetyError('vessel.polar_data.angles must be strictly increasing');
        }
    }

    if (value.matrix.length !== angles.length) {
        throw new RouteWeatherSafetyError('vessel.polar_data.matrix row count must match angles');
    }
    const matrix = value.matrix.map((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== windSpeeds.length) {
            throw new RouteWeatherSafetyError(`vessel.polar_data.matrix[${rowIndex}] has the wrong column count`);
        }
        return row.map((speed, columnIndex) =>
            numberInRange(speed, 0, 80, `vessel.polar_data.matrix[${rowIndex}][${columnIndex}]`),
        );
    });
    return { windSpeeds, angles, matrix };
}

export function validateWeatherRouteRequest(value: unknown, nowMs: number = Date.now()): ValidatedWeatherRouteRequest {
    if (!isRecord(value)) {
        throw new RouteWeatherSafetyError('Request body must be a JSON object');
    }
    if (!Array.isArray(value.centerline) || value.centerline.length < 2) {
        throw new RouteWeatherSafetyError('centerline must contain at least 2 waypoints');
    }
    if (value.centerline.length > MAX_CENTERLINE_POINTS) {
        throw new RouteWeatherSafetyError(`centerline may contain at most ${MAX_CENTERLINE_POINTS} waypoints`, 413);
    }

    const centerline = value.centerline.map((waypoint, index): ValidatedCenterlineWaypoint => {
        if (!isRecord(waypoint)) {
            throw new RouteWeatherSafetyError(`centerline[${index}] must be an object`);
        }
        const lat = numberInRange(waypoint.lat, -85, 85, `centerline[${index}].lat`);
        const lon = numberInRange(waypoint.lon, -180, 180, `centerline[${index}].lon`);
        const depth =
            waypoint.depth_m === undefined
                ? undefined
                : numberInRange(waypoint.depth_m, -12_000, 9_000, `centerline[${index}].depth_m`);
        const name =
            waypoint.name === undefined
                ? undefined
                : typeof waypoint.name === 'string' && waypoint.name.length <= 120
                  ? waypoint.name
                  : (() => {
                        throw new RouteWeatherSafetyError(`centerline[${index}].name must be at most 120 characters`);
                    })();
        return {
            lat,
            lon,
            ...(depth === undefined ? {} : { depth_m: depth }),
            ...(name === undefined ? {} : { name }),
        };
    });

    let routeDistanceNM = 0;
    for (let index = 1; index < centerline.length; index++) {
        const previous = centerline[index - 1];
        const current = centerline[index];
        if (Math.abs(current.lon - previous.lon) > 180) {
            throw new RouteWeatherSafetyError(
                'Routes crossing the antimeridian are not supported by this land-mask pipeline',
                422,
                'antimeridian_route_unsupported',
            );
        }
        const segmentDistance = haversineNM(previous.lat, previous.lon, current.lat, current.lon);
        if (segmentDistance < 0.001) {
            throw new RouteWeatherSafetyError(`centerline[${index}] duplicates the previous waypoint`);
        }
        routeDistanceNM += segmentDistance;
    }
    if (!Number.isFinite(routeDistanceNM) || routeDistanceNM > MAX_ROUTE_DISTANCE_NM) {
        throw new RouteWeatherSafetyError(
            `centerline distance exceeds the ${MAX_ROUTE_DISTANCE_NM} NM processing limit`,
            413,
        );
    }

    if (typeof value.departure_time !== 'string' || value.departure_time.length > 64) {
        throw new RouteWeatherSafetyError('departure_time must be an ISO 8601 timestamp with a timezone');
    }
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value.departure_time)) {
        throw new RouteWeatherSafetyError('departure_time must include a timezone');
    }
    const departureMs = Date.parse(value.departure_time);
    if (!Number.isFinite(departureMs)) {
        throw new RouteWeatherSafetyError('departure_time is not a valid ISO 8601 timestamp');
    }
    const leadHours = (departureMs - nowMs) / (60 * 60 * 1000);
    if (leadHours < -MAX_DEPARTURE_PAST_HOURS || leadHours > MAX_DEPARTURE_LEAD_HOURS) {
        throw new RouteWeatherSafetyError(
            `departure_time must be between ${MAX_DEPARTURE_PAST_HOURS} hour in the past and ${MAX_DEPARTURE_LEAD_HOURS} hours ahead`,
            422,
            'departure_outside_forecast_window',
        );
    }

    if (!isRecord(value.vessel)) {
        throw new RouteWeatherSafetyError('vessel is required');
    }
    if (value.vessel.type !== 'sail' && value.vessel.type !== 'power') {
        throw new RouteWeatherSafetyError('vessel.type must be sail or power');
    }
    const vessel: ValidatedVesselParams = {
        type: value.vessel.type,
        cruising_speed_kts: numberInRange(value.vessel.cruising_speed_kts, 0.5, 80, 'vessel.cruising_speed_kts'),
        max_wind_kts: numberInRange(value.vessel.max_wind_kts, 1, 150, 'vessel.max_wind_kts'),
        max_wave_m: numberInRange(value.vessel.max_wave_m, 0.1, 30, 'vessel.max_wave_m'),
        // Older callers did not send draft. A conservative 2.5 m default
        // preserves compatibility without silently dropping depth gating.
        draft_m:
            value.vessel.draft_m === undefined ? 2.5 : numberInRange(value.vessel.draft_m, 0.1, 30, 'vessel.draft_m'),
        polar_data: validatePolarData(value.vessel.polar_data),
    };

    const corridorWidth =
        value.corridor_width_nm === undefined
            ? undefined
            : numberInRange(value.corridor_width_nm, 1, MAX_CORRIDOR_WIDTH_NM, 'corridor_width_nm');
    let lateralSteps: number | undefined;
    if (value.lateral_steps !== undefined) {
        lateralSteps = numberInRange(value.lateral_steps, 1, MAX_LATERAL_STEPS, 'lateral_steps');
        if (!Number.isInteger(lateralSteps)) {
            throw new RouteWeatherSafetyError('lateral_steps must be an integer');
        }
    }
    const effectiveSteps = lateralSteps ?? 2;
    if (centerline.length * (2 * effectiveSteps + 1) > MAX_ROUTE_MESH_NODES) {
        throw new RouteWeatherSafetyError(`Request would exceed the ${MAX_ROUTE_MESH_NODES}-node mesh limit`, 413);
    }

    return {
        centerline,
        departure_time: new Date(departureMs).toISOString(),
        vessel,
        ...(corridorWidth === undefined ? {} : { corridor_width_nm: corridorWidth }),
        ...(lateralSteps === undefined ? {} : { lateral_steps: lateralSteps }),
    };
}

interface ParsedWindHour {
    timeMs: number;
    speedKmh: number;
    gustKmh: number;
    direction: number;
}

function parseWindHours(hours: unknown): ParsedWindHour[] {
    if (!Array.isArray(hours) || hours.length < 2 || hours.length > 400) {
        throw new RouteWeatherSafetyError(
            'WeatherKit returned an invalid hourly forecast',
            503,
            'wind_forecast_unavailable',
        );
    }
    const upstreamNumber = (value: unknown, min: number, max: number, label: string): number => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
            throw new RouteWeatherSafetyError(`${label} is missing or invalid`, 503, 'wind_forecast_unavailable');
        }
        return value;
    };
    const parsed = hours.map((hour, index): ParsedWindHour => {
        if (!isRecord(hour) || typeof hour.forecastStart !== 'string') {
            throw new RouteWeatherSafetyError(
                `WeatherKit hour ${index} is missing forecastStart`,
                503,
                'wind_forecast_unavailable',
            );
        }
        const timeMs = Date.parse(hour.forecastStart);
        if (!Number.isFinite(timeMs)) {
            throw new RouteWeatherSafetyError(
                `WeatherKit hour ${index} has an invalid forecastStart`,
                503,
                'wind_forecast_unavailable',
            );
        }
        const speedKmh = upstreamNumber(hour.windSpeed, 0, 400, `WeatherKit hour ${index}.windSpeed`);
        const gustKmh = upstreamNumber(hour.windGust, 0, 500, `WeatherKit hour ${index}.windGust`);
        if (gustKmh + 0.01 < speedKmh) {
            throw new RouteWeatherSafetyError(
                `WeatherKit hour ${index}.windGust is below sustained wind`,
                503,
                'wind_forecast_unavailable',
            );
        }
        const direction = upstreamNumber(hour.windDirection, 0, 360, `WeatherKit hour ${index}.windDirection`);
        return { timeMs, speedKmh, gustKmh, direction: direction % 360 };
    });
    parsed.sort((a, b) => a.timeMs - b.timeMs);
    for (let index = 1; index < parsed.length; index++) {
        const gapHours = (parsed[index].timeMs - parsed[index - 1].timeMs) / (60 * 60 * 1000);
        if (gapHours <= 0 || gapHours > 2.01) {
            throw new RouteWeatherSafetyError(
                'WeatherKit hourly forecast contains a duplicate or unsafe time gap',
                503,
                'wind_forecast_unavailable',
            );
        }
    }
    return parsed;
}

function interpolateWindAt(hours: ParsedWindHour[], targetMs: number): AlignedWindSample | null {
    for (let index = 0; index < hours.length; index++) {
        const current = hours[index];
        if (Math.abs(current.timeMs - targetMs) <= 1000) {
            return {
                windSpeed: current.speedKmh / 1.852,
                windGust: current.gustKmh / 1.852,
                windDir: current.direction,
            };
        }
        if (current.timeMs > targetMs && index > 0) {
            const previous = hours[index - 1];
            const fraction = (targetMs - previous.timeMs) / (current.timeMs - previous.timeMs);
            if (fraction < 0 || fraction > 1) return null;
            return {
                windSpeed: (previous.speedKmh + (current.speedKmh - previous.speedKmh) * fraction) / 1.852,
                windGust: (previous.gustKmh + (current.gustKmh - previous.gustKmh) * fraction) / 1.852,
                windDir: lerpDegrees(previous.direction, current.direction, fraction),
            };
        }
    }
    return null;
}

/**
 * Resample WeatherKit's absolute forecastStart timestamps onto exact integer
 * hours from the requested departure. No first/last-sample extension is
 * permitted; every requested instant must be bracketed by real forecast data.
 */
export function alignWeatherKitHours(hours: unknown, departureMs: number, horizonHours: number): AlignedWindSample[] {
    if (
        !Number.isFinite(departureMs) ||
        !Number.isInteger(horizonHours) ||
        horizonHours < 1 ||
        horizonHours > MAX_ROUTE_FORECAST_HOURS
    ) {
        throw new RouteWeatherSafetyError('Requested wind forecast horizon is invalid');
    }
    const parsed = parseWindHours(hours);
    const aligned: AlignedWindSample[] = [];
    for (let offset = 0; offset <= horizonHours; offset++) {
        const sample = interpolateWindAt(parsed, departureMs + offset * 60 * 60 * 1000);
        if (!sample) {
            throw new RouteWeatherSafetyError(
                'WeatherKit does not cover the requested departure and route horizon',
                503,
                'wind_forecast_unavailable',
            );
        }
        aligned.push(sample);
    }
    return aligned;
}
