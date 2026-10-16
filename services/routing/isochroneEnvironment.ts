import type { CurrentField, ExclusionField, WaveField } from '../isochrone/types';
import { haversineNm, initialBearing } from '../isochrone/geodesy';
import { withDeadline } from '../../utils/deadline';
import type { CurrentVector } from '../OceanCurrentService';
import type { WaveFieldData } from '../weather/waveField';
import type { ActiveCyclone } from '../weather/CycloneTrackingService';
import type { CurrentComponents, CurrentModel, CurrentSeries } from '../weather/currentSeries';

type Point = { lat: number; lon: number };
/** Structured-clone inputs for the Worker; missing values stay missing, with no resampling. */
export interface IsochroneEnvironmentSnapshot {
    departureMs: number;
    currentVectors: CurrentVector[] | null;
    currentSeries?: CurrentSeries;
    currentComponents?: CurrentComponents;
    waves: WaveFieldData | null;
    cyclones: ActiveCyclone[] | null;
}
export interface IsochroneEnvironment {
    departureMs: number;
    currentField: CurrentField | null;
    waveField: WaveField | null;
    exclusionField: ExclusionField | null;
    notes: string[];
    snapshot: IsochroneEnvironmentSnapshot;
}

/** One bounded load for every engine consumer; absent fields stay unknown. */
export async function loadIsochroneEnvironment(opts: {
    origin: Point;
    destination: Point;
    departureTime: string;
    speedKts: number;
    currentNrtEnabled?: boolean;
    satelliteMode?: boolean;
    currentModel?: CurrentModel;
    includeModelTide?: boolean;
}): Promise<IsochroneEnvironment> {
    const { origin, destination } = opts;
    const departureMs = Date.parse(opts.departureTime);
    const empty = {
        departureMs,
        currentField: null,
        waveField: null,
        exclusionField: null,
        snapshot: { departureMs, currentVectors: null, waves: null, cyclones: null },
    };
    if (opts.satelliteMode)
        return {
            ...empty,
            notes: [
                'Satellite Mode: ocean-current, wave and cyclone routing fields were not downloaded. Check saved forecasts and official warnings.',
            ],
        };
    if (!Number.isFinite(departureMs))
        return { ...empty, notes: ['Routing environment unavailable: departure time is invalid.'] };
    const crossesDateLine = Math.abs(origin.lon - destination.lon) > 180;
    const bbox = {
        north: Math.min(90, Math.max(origin.lat, destination.lat) + 1),
        south: Math.max(-90, Math.min(origin.lat, destination.lat) - 1),
        east: Math.min(180, Math.max(origin.lon, destination.lon) + 1),
        west: Math.max(-180, Math.min(origin.lon, destination.lon) - 1),
    };
    const [current, waves, cyclone] = await Promise.allSettled([
        withDeadline(
            (async (): Promise<{
                field: CurrentField | null;
                vectors: CurrentVector[] | null;
                series?: CurrentSeries;
                components?: CurrentComponents;
            } | null> => {
                const [
                    { loadRegionalCurrentSeries, currentBoundsForPassage },
                    { createCurrentFieldFromSeries, createCurrentFieldFromVectors },
                ] = await Promise.all([
                    import('../weather/api/currentRegionalLoader'),
                    import('../weather/CurrentFieldAdapter'),
                ]);
                const bounds = currentBoundsForPassage(origin, destination);
                const components: CurrentComponents = opts.includeModelTide ? 'ocean+tide' : 'ocean';
                const hours = Math.min(
                    120,
                    Math.max(
                        1,
                        Math.ceil(
                            haversineNm(origin.lat, origin.lon, destination.lat, destination.lon) /
                                Math.max(1, opts.speedKts) +
                                12,
                        ),
                    ),
                );
                const series =
                    bounds &&
                    (await loadRegionalCurrentSeries({
                        bounds,
                        startMs: departureMs,
                        endMs: departureMs + hours * 3_600_000,
                        model: opts.currentModel,
                        components,
                    }));
                if (series)
                    return {
                        field: createCurrentFieldFromSeries(series, departureMs, components),
                        vectors: null,
                        series,
                        components,
                    };
                // An explicitly requested second model/tide never becomes a different snapshot silently.
                if (crossesDateLine || opts.currentModel === 'RTOFS' || opts.includeModelTide) return null;
                const [{ OceanCurrentService }] = await Promise.all([import('../OceanCurrentService')]);
                const briefing = await OceanCurrentService.fetchCurrents(
                    bbox,
                    initialBearing(origin.lat, origin.lon, destination.lat, destination.lon),
                    haversineNm(origin.lat, origin.lon, destination.lat, destination.lon),
                    opts.speedKts,
                    opts.currentNrtEnabled === true,
                );
                return briefing.availability === 'available'
                    ? { field: createCurrentFieldFromVectors(briefing.vectors), vectors: briefing.vectors }
                    : null;
            })(),
            20_000,
            'routing ocean currents',
        ),
        withDeadline(
            (async () => {
                if (crossesDateLine) return null;
                const [{ fetchWaveField }, { createWaveFieldFromSamples }] = await Promise.all([
                    import('../weather/waveField'),
                    import('../weather/WaveFieldAdapter'),
                ]);
                const data = await fetchWaveField(bbox, opts.departureTime);
                return { field: createWaveFieldFromSamples(data, departureMs), data };
            })(),
            20_000,
            'routing waves',
        ),
        withDeadline(
            (async () => {
                const [{ fetchActiveCyclones }, { buildCycloneExclusionFromCyclones }] = await Promise.all([
                    import('../weather/CycloneTrackingService'),
                    import('../cycloneAvoidance'),
                ]);
                const cyclones = await fetchActiveCyclones();
                return {
                    field: buildCycloneExclusionFromCyclones(
                        cyclones,
                        opts.departureTime,
                        crossesDateLine ? undefined : bbox,
                    ),
                    cyclones,
                };
            })(),
            20_000,
            'routing cyclone exclusions',
        ),
    ]);
    const currentField = current.status === 'fulfilled' ? (current.value?.field ?? null) : null;
    const waveField = waves.status === 'fulfilled' ? (waves.value?.field ?? null) : null;
    const exclusionField = cyclone.status === 'fulfilled' ? (cyclone.value?.field ?? null) : null;
    return {
        departureMs,
        currentField,
        waveField,
        exclusionField,
        snapshot: {
            departureMs,
            currentVectors: current.status === 'fulfilled' ? (current.value?.vectors ?? null) : null,
            ...(current.status === 'fulfilled' && current.value?.series
                ? { currentSeries: current.value.series, currentComponents: current.value.components }
                : {}),
            waves: waves.status === 'fulfilled' ? (waves.value?.data ?? null) : null,
            cyclones: cyclone.status === 'fulfilled' ? (cyclone.value?.cyclones ?? null) : null,
        },
        notes: [
            current.status === 'fulfilled' && current.value?.series
                ? current.value.components === 'ocean+tide'
                    ? `${current.value.series.model} ocean plus model tide within verified cells/times; narrow passages and bars are unresolved.`
                    : `${current.value.series.model} time-varying ocean currents within verified cells/times; tidal streams are not included.`
                : currentField
                  ? 'Ocean currents use one surface-current snapshot; tidal streams are not included.'
                  : 'Ocean-current data unavailable; route estimates use speed through water.',
            waveField
                ? 'Wave effects use available forecast cells; sheltered or out-of-range cells remain unknown.'
                : 'Wave data unavailable; sea-state effects are not included.',
            exclusionField
                ? 'Cyclone exclusions use available forecast tracks; check official warnings before departure.'
                : 'No cyclone exclusion field available; check official cyclone warnings.',
        ],
    };
}

/** Reuse the same snapshot for later route legs without resetting its clock. */
export function isochroneEnvironmentAt(environment: IsochroneEnvironment, departureTime: string): IsochroneEnvironment {
    const departureMs = Date.parse(departureTime);
    if (!Number.isFinite(departureMs))
        return {
            ...environment,
            currentField: null,
            waveField: null,
            exclusionField: null,
            notes: [...environment.notes, 'Routing environment unavailable: later-leg departure time is invalid.'],
        };
    const offset = (departureMs - environment.departureMs) / 3_600_000;
    return {
        ...environment,
        departureMs,
        snapshot: { ...environment.snapshot, departureMs },
        currentField: environment.currentField && {
            getCurrent: (lat, lon, hours) => environment.currentField!.getCurrent(lat, lon, hours + offset),
        },
        waveField: environment.waveField && {
            sampleHours: environment.waveField.sampleHours?.map((hour) => hour - offset),
            getWave: (lat, lon, hours) => environment.waveField!.getWave(lat, lon, hours + offset),
        },
        exclusionField: environment.exclusionField && {
            isExcluded: (lat, lon, hours) => environment.exclusionField!.isExcluded(lat, lon, hours + offset),
        },
    };
}
