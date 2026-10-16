import { computeOffshoreKernel } from '../isochrone/offshoreKernel';
import { runComfortAttempts } from '../isochrone/comfortKernel';
import { buildCycloneExclusionFromCyclones } from '../isochrone/cycloneField';
import { haversineNm, initialBearing, projectPosition } from '../isochrone/geodesy';
import { createWindFieldFromGrid } from '../weather/WindFieldAdapter';
import { createCurrentFieldFromVectors } from '../weather/CurrentFieldAdapter';
import { createWaveFieldFromSamples } from '../weather/WaveFieldAdapter';
import { continuousEastForLongitudeRange, continuousLongitudeInGrid } from '../weather/windLongitude';
import { prepareOffshoreJob, type OffshoreJob, type OffshoreCandidate } from './offshoreProtocol';
import type { OffshoreProgress } from '../isochrone/offshoreKernel';
import type { IsochroneResult } from '../isochrone/types';
import { routeSampleFractions } from '../isochrone/routeSampling';

/** Align departure with forecast reference time; never extend the last forecast frame. */
export function offshoreWindFields(job: OffshoreJob) {
    const grid = job.wind;
    const wind = createWindFieldFromGrid(grid);
    const gust =
        grid.gust &&
        createWindFieldFromGrid({ ...grid, u: grid.gust, v: grid.gust.map((frame) => new Float32Array(frame.length)) });
    const offset = (Date.parse(job.departureTime) - Date.parse(grid.refTime!)) / 3_600_000;
    const first = grid.stepHours?.[0] ?? 0,
        last = grid.stepHours?.at(-1) ?? grid.totalHours - 1;
    const at = (field: typeof wind, lat: number, lon: number, hours: number) => {
        const t = hours + offset;
        const x = continuousLongitudeInGrid(lon, grid.west, grid.east);
        if (
            !Number.isFinite(t) ||
            t < first ||
            t > last ||
            !Number.isFinite(lat) ||
            lat < grid.south ||
            lat > grid.north ||
            !Number.isFinite(x) ||
            x < grid.west ||
            x > continuousEastForLongitudeRange(grid.west, grid.east)
        )
            return null;
        const value = field.getWind(lat, lon, t);
        return value && Number.isFinite(value.speed) && value.speed >= 0 && Number.isFinite(value.direction)
            ? value
            : null;
    };
    return {
        wind: { getWind: (lat: number, lon: number, hours: number) => at(wind, lat, lon, hours) },
        gust: gust ? { getWind: (lat: number, lon: number, hours: number) => at(gust, lat, lon, hours) } : null,
    };
}

/** Runs solely in an isolated Worker. There is no HTTP depth fallback and no ENC input. */
export async function runOffshoreJob(
    input: OffshoreJob,
    progress?: (value: OffshoreProgress) => void,
): Promise<OffshoreCandidate | null> {
    const job = prepareOffshoreJob(input);
    const current = () => Date.now() < job.deadlineMs;
    if (!current()) return null;
    const { wind } = offshoreWindFields(job);
    const currentField = createCurrentFieldFromVectors(job.environment.currentVectors ?? []);
    const waves = createWaveFieldFromSamples(job.environment.waves, Date.parse(job.departureTime));
    const exclusions =
        job.environment.cyclones && buildCycloneExclusionFromCyclones(job.environment.cyclones, job.departureTime);
    const result = await runComfortAttempts(
        (...args) => computeOffshoreKernel(...args, { progress }),
        job.origin,
        job.destination,
        job.departureTime,
        job.polar,
        wind,
        { ...job.config, shouldContinue: current },
        job.bathymetry,
        currentField,
        exclusions,
        waves,
    );
    if (!result || !current()) return null;
    return summarizeOffshoreResult(job, result, current);
}

/** Recheck the exact final geometry and its clock after main-thread chart validation too. */
export function summarizeOffshoreResult(
    job: OffshoreJob,
    result: IsochroneResult,
    current: () => boolean = () => true,
): OffshoreCandidate | null {
    if (result.route.length < 2) return null;
    const { wind, gust } = offshoreWindFields(job);
    const clockOffset = (Date.parse(job.departureTime) - Date.parse(job.wind.refTime!)) / 3_600_000;
    const forecastHours = (job.wind.stepHours ?? Array.from({ length: job.wind.totalHours }, (_, i) => i)).map(
        (hour) => hour - clockOffset,
    );
    let maxWindKts = 0,
        maxGustKts = 0,
        gustKnown = !!gust;
    // Check the displayed smoothed line against its own forecast clock. Missing wind cannot count as a model result.
    let sampled = 0;
    for (let i = 0; i < result.route.length; i++) {
        const a = result.route[Math.max(0, i - 1)],
            b = result.route[i];
        const distance = haversineNm(a.lat, a.lon, b.lat, b.lon);
        const fractions = routeSampleFractions(a.timeHours, b.timeHours, distance, forecastHours, 20_000 - sampled);
        if (!fractions) return null;
        const bearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        for (const fraction of fractions) {
            if (++sampled > 20_000 || !current()) return null;
            const point =
                fraction === 0 ? a : fraction === 1 ? b : projectPosition(a.lat, a.lon, bearing, distance * fraction);
            const hours = a.timeHours + (b.timeHours - a.timeHours) * fraction;
            const value = wind.getWind(point.lat, point.lon, hours);
            if (!value) return null;
            maxWindKts = Math.max(maxWindKts, value.speed);
            const g = gust?.getWind(point.lat, point.lon, hours);
            if (!g) gustKnown = false;
            else maxGustKts = Math.max(maxGustKts, g.speed);
        }
    }
    const stats = result.sailingStats;
    const caps = job.config.comfortParams;
    if (
        (caps?.maxWindKts !== undefined && maxWindKts > caps.maxWindKts) ||
        (caps?.maxGustKts !== undefined && (!gustKnown || maxGustKts > caps.maxGustKts))
    )
        return null;
    return {
        verification: 'unverified-public-data',
        // Comparison needs the selected path and its raw metrics, not every search wavefront.
        result: { ...result, isochrones: [] },
        maxWindKts,
        maxGustKts: gustKnown ? maxGustKts : null,
        upwindPercent:
            stats && stats.totalHours > 0 && stats.unknownHours === 0
                ? (stats.beatingHours / stats.totalHours) * 100
                : null,
    };
}
