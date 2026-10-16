import type { VesselProfile } from '../../types';
import type { IsochroneConfig } from '../isochrone/types';
import { vesselCruisingSpeedKts, vesselDraftIsAssumed } from '../units';
import { vesselMaxWaveHeightMetres } from '../units';
import type { ComfortParams } from '../../types/settings';
import type { RoutingPolarSettings } from '../routingPolar';

export const INSHORE_HOP_NM = 15;

export function routingComfortConfig(
    vessel: Partial<VesselProfile> | null | undefined,
    user?: ComfortParams,
): Pick<IsochroneConfig, 'comfortParams' | 'waveLimitCeilingM' | 'comfortVessel'> {
    const cap = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    const tightest = (a: number | undefined, b: number | undefined) =>
        a === undefined ? b : b === undefined ? a : Math.min(a, b);
    const vesselWave = cap(vesselMaxWaveHeightMetres(vessel));
    const comfortParams = {
        maxWindKts: tightest(cap(vessel?.maxWindSpeed), cap(user?.maxWindKts)),
        maxWaveM: tightest(vesselWave, cap(user?.maxWaveM)),
        maxGustKts: cap(user?.maxGustKts),
        preferredAngles: user?.preferredAngles,
    };
    return {
        comfortParams,
        waveLimitCeilingM: vesselWave,
        comfortVessel:
            vessel?.type && Number.isFinite(vessel.length) && vessel.length! > 0
                ? { type: vessel.type, length: vessel.length! }
                : undefined,
    };
}

/** Caller policy only. The engine defaults and worldwide benchmark remain unchanged. */
export function vesselIsochroneConfig(
    vessel: Partial<VesselProfile> | null | undefined,
    distanceNm: number,
): Pick<IsochroneConfig, 'minWindSpeed' | 'motoringSpeed' | 'timeStepHours' | 'powerVessel'> {
    const minimum = vessel?.minWindSpeed;
    const motor = vessel?.motoringSpeed;
    return {
        ...(vessel?.type === 'power' ? { powerVessel: true } : {}),
        minWindSpeed:
            typeof minimum === 'number' && Number.isFinite(minimum) && minimum >= 0 && minimum <= 30 ? minimum : 4,
        motoringSpeed:
            typeof motor === 'number' && Number.isFinite(motor) && motor > 0 && motor <= 60
                ? motor
                : vesselCruisingSpeedKts(vessel, 6),
        // Finer coastal steps, bounded to the existing six-hour ocean step.
        // These are resolution choices, not a calibrated ETA improvement claim.
        timeStepHours: distanceNm < 50 ? 0.5 : distanceNm < 150 ? 1 : distanceNm < 400 ? 3 : 6,
    };
}

/** A precompute may never bypass the skipper's current departure or limits. */
export function isochroneRoutingContext(
    departureTime: string,
    settings: Omit<RoutingPolarSettings, 'vessel'> & {
        vessel?: Partial<VesselProfile> | null;
        comfortParams?: ComfortParams;
        currentNrtEnabled?: boolean;
        satelliteMode?: boolean;
    },
): string {
    const vessel = settings.vessel;
    return JSON.stringify([
        departureTime,
        vessel?.draft,
        vessel?.length,
        vessel?.hullType,
        vessel?.type,
        vessel?.cruisingSpeed,
        vessel?.minWindSpeed,
        vessel?.motoringSpeed,
        vessel?.maxWindSpeed,
        vessel?.maxWaveHeight,
        vesselDraftIsAssumed(vessel),
        // Key the derived policy too: new hull/performance inputs cannot silently reuse an old ceiling.
        routingComfortConfig(vessel, settings.comfortParams),
        vesselIsochroneConfig(vessel, Infinity),
        settings.comfortParams ?? null,
        settings.polarData ?? null,
        settings.polarSource ?? 'factory',
        settings.polarSource_type ?? 'manual',
        settings.polarBoatModel ?? '',
        settings.smartPolarsEnabled === true,
        settings.routingPolarScale ?? 1,
        settings.currentNrtEnabled === true,
        settings.satelliteMode === true,
    ]);
}
