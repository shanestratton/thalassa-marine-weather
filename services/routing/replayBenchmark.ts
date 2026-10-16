/** Offline replay contract. Inputs and raw positions stay outside the checkout.
 * This measures the unchanged router; it never tunes it to a particular boat. */
import type { PolarData } from '../../types';
import type { WindField } from '../isochrone/types';
import { haversineNm, initialBearing, R_NM, toRad } from '../isochrone/geodesy';

export interface ReplayPoint {
    lat: number;
    lon: number;
    at: string;
    mode?: 'sail' | 'motor' | 'unknown';
}
export interface ReplayWeather {
    source: 'wx-archive' | 'historical-forecast' | 'synthetic';
    model: string;
    issuedAt: string;
    artifactSha256: string;
    /** Forecast-valid times, never the date an archive was downloaded. */
    frames: { at: string; cells: { lat: number; lon: number; speedKn: number | null; fromDeg: number | null }[] }[];
    maxCellDistanceNm: number;
    maxFrameGapHours: number;
}
export interface ReplayLeg {
    track: ReplayPoint[];
    weather: ReplayWeather;
    polars: { kind: 'generic' | 'database-scaled' | 'chosen'; label: string; data: PolarData }[];
}
export interface ReplayPrediction {
    route: { lat: number; lon: number }[];
    durationHours: number;
    motorHours: number | null;
}
export type ReplayExecutor = (input: {
    origin: ReplayPoint;
    destination: ReplayPoint;
    departure: string;
    polar: PolarData;
    wind: WindField;
}) => Promise<ReplayPrediction | null>;
const stamp = (v: string) => Date.parse(v);
const coordinate = (p: { lat: number; lon: number }) =>
    Number.isFinite(p.lat) && Math.abs(p.lat) <= 85 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;
const positive = (v: number) => Number.isFinite(v) && v > 0;

export function validateReplayLeg(leg: ReplayLeg): void {
    if (
        !leg ||
        !Array.isArray(leg.track) ||
        leg.track.length < 2 ||
        leg.track.length > 20000 ||
        !leg.track.every(
            (p, i) => coordinate(p) && Number.isFinite(stamp(p.at)) && (!i || stamp(p.at) > stamp(leg.track[i - 1].at)),
        )
    )
        throw new Error('Replay needs an ordered timestamped track of 2–20000 valid positions.');
    const weather = leg.weather;
    if (
        !weather ||
        !['wx-archive', 'historical-forecast', 'synthetic'].includes(weather.source) ||
        !/^[0-9a-f]{64}$/.test(weather.artifactSha256) ||
        !weather.model ||
        !Number.isFinite(stamp(weather.issuedAt)) ||
        stamp(weather.issuedAt) > stamp(leg.track[0].at) ||
        !positive(weather.maxCellDistanceNm) ||
        weather.maxCellDistanceNm > 120 ||
        !positive(weather.maxFrameGapHours) ||
        weather.maxFrameGapHours > 12 ||
        !Array.isArray(weather.frames) ||
        weather.frames.length < 2 ||
        weather.frames.length > 400
    )
        throw new Error('Replay needs a documented forecast issued by departure, with bounded coverage.');
    let cells = 0;
    for (const [i, frame] of weather.frames.entries()) {
        if (
            !Number.isFinite(stamp(frame.at)) ||
            (i > 0 && stamp(frame.at) <= stamp(weather.frames[i - 1].at)) ||
            !Array.isArray(frame.cells) ||
            !frame.cells.length ||
            frame.cells.some(
                (c) =>
                    !coordinate(c) ||
                    (c.speedKn !== null && (!Number.isFinite(c.speedKn) || c.speedKn < 0 || c.speedKn > 250)) ||
                    (c.fromDeg !== null && (!Number.isFinite(c.fromDeg) || c.fromDeg < 0 || c.fromDeg >= 360)),
            )
        )
            throw new Error('Invalid or unordered forecast frame.');
        cells += frame.cells.length;
    }
    if (cells > 500000) throw new Error('Replay forecast exceeds the bounded cell budget.');
    if (
        !Array.isArray(leg.polars) ||
        leg.polars.length !== 3 ||
        new Set(leg.polars.map((p) => p.kind)).size !== 3 ||
        !['generic', 'database-scaled', 'chosen'].every((k) => leg.polars.some((p) => p.kind === k))
    )
        throw new Error('Supply generic, database-scaled and chosen polar snapshots separately.');
    for (const { data: p } of leg.polars) {
        if (
            !p ||
            p.angles.length < 2 ||
            p.windSpeeds.length < 2 ||
            p.angles.length > 30 ||
            p.windSpeeds.length > 30 ||
            p.matrix.length !== p.angles.length ||
            !p.angles.every((v, i) => Number.isFinite(v) && v >= 0 && v <= 180 && (!i || v > p.angles[i - 1])) ||
            !p.windSpeeds.every(
                (v, i) => Number.isFinite(v) && v >= 0 && v <= 150 && (!i || v > p.windSpeeds[i - 1]),
            ) ||
            !p.matrix.every(
                (row) =>
                    row.length === p.windSpeeds.length && row.every((v) => Number.isFinite(v) && v >= 0 && v <= 80),
            )
        )
            throw new Error('Invalid polar snapshot.');
    }
}

/** Nearest in-domain cell + linear vector/time interpolation. Missing is unknown. */
export function replayWindField(weather: ReplayWeather, departure: string): WindField & { missingQueries(): number } {
    let missing = 0;
    const frames = weather.frames.map((f) => ({ ...f, ms: stamp(f.at) }));
    const start = stamp(departure);
    const sample = (frame: ReplayWeather['frames'][number], lat: number, lon: number) => {
        let nearest: (typeof frame.cells)[number] | null = null;
        let distance = weather.maxCellDistanceNm;
        for (const cell of frame.cells) {
            const d = haversineNm(lat, lon, cell.lat, cell.lon);
            if (d <= distance) {
                nearest = cell;
                distance = d;
            }
        }
        // Do not skip a missing nearest cell to borrow distant valid weather.
        if (nearest?.speedKn == null || nearest.fromDeg == null) return null;
        return {
            u: -nearest.speedKn * Math.sin(toRad(nearest.fromDeg)),
            v: -nearest.speedKn * Math.cos(toRad(nearest.fromDeg)),
        };
    };
    return {
        missingQueries: () => missing,
        getWind(lat, lon, hours) {
            const at = start + hours * 3600000;
            const after = frames.findIndex((f) => f.ms >= at);
            if (after < 0 || at < frames[0].ms || !Number.isFinite(at)) {
                missing++;
                return null;
            }
            const b = frames[after],
                a = frames[b.ms === at ? after : Math.max(0, after - 1)];
            if (b.ms - a.ms > weather.maxFrameGapHours * 3600000) {
                missing++;
                return null;
            }
            const av = sample(a, lat, lon),
                bv = sample(b, lat, lon);
            if (!av || !bv) {
                missing++;
                return null;
            }
            const f = a.ms === b.ms ? 0 : (at - a.ms) / (b.ms - a.ms);
            const u = av.u + (bv.u - av.u) * f,
                v = av.v + (bv.v - av.v) * f;
            return { speed: Math.hypot(u, v), direction: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
        },
    };
}

/** Great-circle point-to-segment distance, including antimeridian segments. */
export function distanceToReplayLine(
    point: { lat: number; lon: number },
    line: { lat: number; lon: number }[],
): number {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1],
            b = line[i];
        const length = haversineNm(a.lat, a.lon, b.lat, b.lon);
        const delta = haversineNm(a.lat, a.lon, point.lat, point.lon) / R_NM;
        const angle = toRad(
            initialBearing(a.lat, a.lon, point.lat, point.lon) - initialBearing(a.lat, a.lon, b.lat, b.lon),
        );
        const along = Math.atan2(Math.sin(delta) * Math.cos(angle), Math.cos(delta)) * R_NM;
        const distance =
            length > 1e-8 && along >= 0 && along <= length
                ? Math.abs(Math.asin(Math.max(-1, Math.min(1, Math.sin(delta) * Math.sin(angle))))) * R_NM
                : Math.min(
                      haversineNm(point.lat, point.lon, a.lat, a.lon),
                      haversineNm(point.lat, point.lon, b.lat, b.lon),
                  );
        best = Math.min(best, distance);
    }
    return best;
}

export async function replayLeg(leg: ReplayLeg, execute: ReplayExecutor) {
    validateReplayLeg(leg);
    const origin = leg.track[0],
        destination = leg.track[leg.track.length - 1];
    const actualHours = (stamp(destination.at) - stamp(origin.at)) / 3600000;
    let actualMotorHours = 0,
        unknownPropulsionHours = 0;
    for (let i = 1; i < leg.track.length; i++) {
        const duration = (stamp(leg.track[i].at) - stamp(leg.track[i - 1].at)) / 3600000;
        if (leg.track[i - 1].mode === 'motor') actualMotorHours += duration;
        else if (leg.track[i - 1].mode !== 'sail') unknownPropulsionHours += duration;
    }
    const variants = [];
    for (const polar of leg.polars) {
        const wind = replayWindField(leg.weather, origin.at);
        const prediction = await execute({ origin, destination, departure: origin.at, polar: polar.data, wind });
        const valid =
            prediction &&
            positive(prediction.durationHours) &&
            prediction.route.length >= 2 &&
            prediction.route.every(coordinate) &&
            (prediction.motorHours === null ||
                (Number.isFinite(prediction.motorHours) &&
                    prediction.motorHours >= 0 &&
                    prediction.motorHours <= prediction.durationHours));
        if (!valid || wind.missingQueries()) {
            variants.push({
                kind: polar.kind,
                label: polar.label,
                status: wind.missingQueries() ? 'incomplete-forecast' : 'no-valid-route',
                missingQueries: wind.missingQueries(),
                metrics: null,
            });
            continue;
        }
        const distances = [
            ...leg.track.map((p) => distanceToReplayLine(p, prediction.route)),
            ...prediction.route.map((p) => distanceToReplayLine(p, leg.track)),
        ];
        variants.push({
            kind: polar.kind,
            label: polar.label,
            status: 'measured',
            missingQueries: 0,
            metrics: {
                predictedHours: prediction.durationHours,
                etaErrorHours: prediction.durationHours - actualHours,
                meanTrackDivergenceNm: distances.reduce((a, b) => a + b, 0) / distances.length,
                maxTrackDivergenceNm: Math.max(...distances),
                predictedMotorHours: prediction.motorHours,
                motorErrorHours:
                    unknownPropulsionHours === 0 && prediction.motorHours !== null
                        ? prediction.motorHours - actualMotorHours
                        : null,
            },
        });
    }
    // No raw coordinates, IDs, timestamps or personal log notes in the report.
    return {
        schema: 1,
        source: leg.weather.source,
        model: leg.weather.model,
        artifactSha256: leg.weather.artifactSha256,
        synthetic: leg.weather.source === 'synthetic',
        actualHours,
        actualMotorHours: unknownPropulsionHours === 0 ? actualMotorHours : null,
        unknownPropulsionHours,
        variants,
    };
}
