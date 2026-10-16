/** Public forecasts and public GEBCO relief only. No chart-cell or licensing fields cross this boundary. */
import type { PolarData } from '../../types';
import type { IsochroneConfig, IsochroneResult } from '../isochrone/types';
import type { BathymetryGrid } from '../isochrone/publicBathymetry';
import type { WindGrid } from '../weather/windGridEncoding';
import type { IsochroneEnvironmentSnapshot } from './isochroneEnvironment';

export interface OffshoreJob {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    departureTime: string;
    polar: PolarData;
    wind: WindGrid;
    bathymetry: BathymetryGrid;
    environment: IsochroneEnvironmentSnapshot;
    config: Omit<Partial<IsochroneConfig>, 'shouldContinue'>;
    deadlineMs: number;
}
export interface OffshoreCandidate {
    verification: 'unverified-public-data';
    result: IsochroneResult;
    maxWindKts: number;
    maxGustKts: number | null;
    upwindPercent: number | null;
}

const finite = (n: number) => Number.isFinite(n);
const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(`Offshore inputs: ${message}`);
};
const position = (p: { lat: number; lon: number }) => {
    assert(finite(p.lat) && Math.abs(p.lat) <= 90 && finite(p.lon) && Math.abs(p.lon) <= 180, 'invalid position');
    return { lat: p.lat, lon: p.lon };
};
const axis = (a: number[], max: number) => {
    assert(a.length > 0 && a.length <= max && a.every((v, i) => finite(v) && (!i || v > a[i - 1])), 'invalid axis');
    return [...a];
};

/** Construct a whitelist DTO before posting. Typed arrays are cloned by Worker, never transferred out of the cache. */
export function prepareOffshoreJob(input: OffshoreJob): OffshoreJob {
    const { wind: w, bathymetry: b, environment: e, config: c, polar: p } = input;
    assert(finite(Date.parse(input.departureTime)) && finite(input.deadlineMs), 'invalid clock');
    const angles = axis(p.angles, 200),
        windSpeeds = axis(p.windSpeeds, 100);
    assert(
        p.matrix.length === angles.length &&
            p.matrix.every(
                (row) => row.length === windSpeeds.length && row.every((v) => finite(v) && v >= 0 && v <= 100),
            ),
        'invalid polar',
    );
    assert(
        Number.isInteger(w.width) &&
            Number.isInteger(w.height) &&
            w.width >= 2 &&
            w.height >= 2 &&
            w.width * w.height <= 100_000,
        'wind dimensions',
    );
    assert(
        Number.isInteger(w.totalHours) &&
            w.totalHours > 0 &&
            w.totalHours <= 800 &&
            finite(Date.parse(w.refTime ?? '')),
        'wind reference time',
    );
    const cells = w.width * w.height;
    for (const frames of [w.u, w.v, w.speed, ...(w.gust ? [w.gust] : [])])
        assert(
            frames.length === w.totalHours &&
                frames.every((frame) => frame instanceof Float32Array && frame.length === cells),
            'wind frame size',
        );
    assert(cells * w.totalHours * (w.gust ? 4 : 3) * 4 <= 64 * 1024 * 1024, 'wind memory limit');
    assert(
        Number.isInteger(b.rows) &&
            Number.isInteger(b.cols) &&
            b.rows >= 2 &&
            b.cols >= 2 &&
            b.rows * b.cols <= 4_000_000 &&
            b.data instanceof Float32Array &&
            b.data.length === b.rows * b.cols,
        'relief dimensions',
    );
    assert(
        [b.south, b.north, b.west, b.east, b.latStep, b.lonStep].every(finite) &&
            b.north > b.south &&
            b.east > b.west &&
            b.latStep > 0 &&
            b.lonStep > 0,
        'relief bounds',
    );
    const lats = axis(w.lats, 100_000),
        lons = axis(w.lons, 100_000);
    assert(
        lats.length === w.height &&
            lons.length === w.width &&
            [w.north, w.south, w.east, w.west].every(finite) &&
            w.north > w.south &&
            w.east !== w.west,
        'wind bounds',
    );
    const stepHours = w.stepHours ? axis(w.stepHours, 800) : undefined;
    assert(!stepHours || stepHours.length === w.totalHours, 'forecast step axis');
    assert(finite(e.departureMs), 'environment clock');
    assert(!e.currentVectors || e.currentVectors.length <= 200_000, 'current memory limit');
    assert(
        !e.waves ||
            (e.waves.samples.length <= 10_000 &&
                e.waves.totalHours > 0 &&
                e.waves.totalHours <= 800 &&
                e.waves.samples.length * e.waves.totalHours <= 2_000_000),
        'wave memory limit',
    );
    assert(!e.cyclones || e.cyclones.length <= 200, 'cyclone memory limit');
    for (const vector of e.currentVectors ?? []) {
        position(vector);
        assert([vector.u, vector.v, vector.speedKts, vector.directionDeg].every(finite), 'invalid current vector');
    }
    if (e.waves) {
        assert(finite(Date.parse(e.waves.referenceTimeIso)), 'wave reference time');
        for (const sample of e.waves.samples) {
            position(sample);
            assert(
                [sample.heightM, sample.directionFromDeg, sample.periodS].every(
                    (values) => values.length === e.waves!.totalHours && values.every((v) => typeof v === 'number'),
                ),
                'wave frame size',
            );
        }
    }
    // Reject functions/unknown configuration by reconstructing only supported scalar fields.
    const config: OffshoreJob['config'] = {};
    for (const key of [
        'timeStepHours',
        'maxHours',
        'bearingCount',
        'minBearingDeg',
        'maxBearingDeg',
        'vesselDraft',
        'minWindSpeed',
        'motoringSpeed',
        'waveLimitCeilingM',
    ] as const)
        if (c[key] !== undefined) {
            assert(finite(c[key]!), `invalid ${key}`);
            config[key] = c[key];
        }
    assert(
        (config.timeStepHours ?? 6) > 0 &&
            (config.bearingCount ?? 36) > 0 &&
            (config.bearingCount ?? 36) <= 720 &&
            (config.motoringSpeed ?? 5) > 0,
        'invalid expansion limits',
    );
    if (c.minDepthM !== undefined) {
        assert(c.minDepthM === null || finite(c.minDepthM), 'depth threshold');
        config.minDepthM = c.minDepthM;
    }
    if (c.powerVessel !== undefined) config.powerVessel = c.powerVessel === true;
    config.useDepthPenalty = c.useDepthPenalty !== false;
    if (c.comfortVessel) {
        assert(
            ['sail', 'power', 'observer'].includes(c.comfortVessel.type) &&
                finite(c.comfortVessel.length) &&
                c.comfortVessel.length >= 0,
            'invalid comfort vessel',
        );
        config.comfortVessel = { type: c.comfortVessel.type, length: c.comfortVessel.length };
    }
    if (c.comfortParams) {
        const { maxWindKts, maxWaveM, maxGustKts, preferredAngles } = c.comfortParams;
        assert(
            [maxWindKts, maxWaveM, maxGustKts].every((v) => v === undefined || (finite(v) && v > 0)),
            'comfort thresholds',
        );
        config.comfortParams = {
            maxWindKts,
            maxWaveM,
            maxGustKts,
            preferredAngles: preferredAngles?.filter((a) =>
                ['beating', 'close_reach', 'beam_reach', 'broad_reach', 'running'].includes(a),
            ),
        };
    }
    return {
        origin: position(input.origin),
        destination: position(input.destination),
        departureTime: input.departureTime,
        polar: { angles, windSpeeds, matrix: p.matrix.map((row) => [...row]) },
        wind: {
            u: w.u,
            v: w.v,
            speed: w.speed,
            ...(w.gust ? { gust: w.gust } : {}),
            width: w.width,
            height: w.height,
            lats,
            lons,
            north: w.north,
            south: w.south,
            west: w.west,
            east: w.east,
            totalHours: w.totalHours,
            refTime: w.refTime,
            ...(stepHours ? { stepHours } : {}),
        },
        bathymetry: {
            south: b.south,
            north: b.north,
            west: b.west,
            east: b.east,
            latStep: b.latStep,
            lonStep: b.lonStep,
            rows: b.rows,
            cols: b.cols,
            data: b.data,
        },
        environment: {
            departureMs: e.departureMs,
            currentVectors:
                e.currentVectors?.map(({ lat, lon, u, v, speedKts, directionDeg }) => ({
                    lat,
                    lon,
                    u,
                    v,
                    speedKts,
                    directionDeg,
                })) ?? null,
            waves: e.waves
                ? {
                      referenceTimeIso: e.waves.referenceTimeIso,
                      totalHours: e.waves.totalHours,
                      samples: e.waves.samples.map(({ lat, lon, heightM, directionFromDeg, periodS }) => ({
                          lat,
                          lon,
                          heightM: [...heightM],
                          directionFromDeg: [...directionFromDeg],
                          periodS: [...periodS],
                      })),
                  }
                : null,
            cyclones:
                e.cyclones?.map(
                    ({
                        sid,
                        name,
                        basin,
                        category,
                        categoryLabel,
                        currentPosition,
                        track,
                        forecastTrack,
                        maxWindKts,
                        minPressureMb,
                        nature,
                    }) => {
                        const point = ({ lat, lon, time, windKts, pressureMb }: typeof currentPosition) => {
                            position({ lat, lon });
                            assert(
                                typeof time === 'string' &&
                                    finite(Date.parse(time)) &&
                                    (windKts === null || finite(windKts)) &&
                                    (pressureMb === null || finite(pressureMb)),
                                'invalid cyclone position',
                            );
                            return { lat, lon, time, windKts, pressureMb };
                        };
                        assert(
                            [sid, name, basin, categoryLabel, nature].every(
                                (value) => typeof value === 'string' && value.length <= 200,
                            ) &&
                                finite(maxWindKts) &&
                                finite(category) &&
                                (minPressureMb === null || finite(minPressureMb)),
                            'invalid cyclone',
                        );
                        assert(track.length <= 1000 && forecastTrack.length <= 1000, 'cyclone track memory limit');
                        return {
                            sid,
                            name,
                            basin,
                            category,
                            categoryLabel,
                            currentPosition: point(currentPosition),
                            track: track.map(point),
                            forecastTrack: forecastTrack.map(point),
                            maxWindKts,
                            minPressureMb,
                            nature,
                        };
                    },
                ) ?? null,
        },
        config,
        deadlineMs: input.deadlineMs,
    };
}
