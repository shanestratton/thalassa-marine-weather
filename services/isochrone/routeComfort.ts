import type { IsochroneNode } from './types';
import type { WaveField, ExclusionField } from './types';
import { haversineNm, initialBearing, projectPosition } from './geodesy';
import type { VesselProfile } from '../../types';
import { seaComfort, type ComfortWord } from '../../utils/seaComfort';
import { routeSampleFractions } from './routeSampling';
const WORDS: ComfortWord[] = ['Comfortable', 'Lively', 'Uncomfortable', 'Hard going'];
export interface RouteComfortSummary {
    maxWaveM: number | null;
    maxWaveAt: { lat: number; lon: number } | null;
    knownHours: number;
    unknownHours: number;
    coverage: 'complete' | 'partial' | 'unavailable';
    level: number | null;
    word: ComfortWord | null;
    genericBoat: boolean;
    relaxedFromM?: number;
    usedLimitM?: number;
}
/** Preserve the least complete coverage and strongest disclosure across a stitched route. */
export function combineRouteComfort(
    parts: readonly (RouteComfortSummary | undefined)[],
): RouteComfortSummary | undefined {
    if (parts.some((part) => !part) || !parts.length) return undefined;
    const summaries = parts as RouteComfortSummary[];
    const highest = summaries.reduce((a, b) => ((b.maxWaveM ?? -1) > (a.maxWaveM ?? -1) ? b : a));
    const worst = summaries.reduce((a, b) => ((b.level ?? -1) > (a.level ?? -1) ? b : a));
    const knownHours = summaries.reduce((sum, part) => sum + part.knownHours, 0);
    const unknownHours = summaries.reduce((sum, part) => sum + part.unknownHours, 0);
    const relaxed = summaries.filter((part) => part.relaxedFromM !== undefined);
    return {
        ...highest,
        knownHours,
        unknownHours,
        coverage:
            knownHours === 0
                ? 'unavailable'
                : summaries.every((part) => part.coverage === 'complete')
                  ? 'complete'
                  : 'partial',
        level: worst.level,
        word: worst.word,
        genericBoat: summaries.some((part) => part.genericBoat),
        ...(relaxed.length
            ? {
                  relaxedFromM: Math.min(...relaxed.map((part) => part.relaxedFromM!)),
                  usedLimitM: Math.max(...relaxed.map((part) => part.usedLimitM!)),
              }
            : {}),
    };
}
/** The same uncalibrated 130-04 model. No invented wind-sea/swell partition. */
export function routeComfortForNodes(
    route: readonly IsochroneNode[],
    vessel?: Pick<VesselProfile, 'length' | 'type'> | null,
): RouteComfortSummary {
    let maxWaveM: number | null = null,
        maxWaveAt: RouteComfortSummary['maxWaveAt'] = null;
    let knownHours = 0,
        unknownHours = 0,
        level: number | null = null,
        genericBoat = !vessel || vessel.type === 'observer' || !(vessel.length > 0);
    for (let i = 1; i < route.length; i++) {
        const n = route[i],
            hours = n.timeHours - route[i - 1].timeHours;
        if (!(hours > 0) || !Number.isFinite(hours)) continue;
        if (n.waveHeightM == null || !Number.isFinite(n.waveHeightM) || n.waveHeightM < 0) {
            unknownHours += hours;
            continue;
        }
        knownHours += hours;
        if (maxWaveM === null || n.waveHeightM > maxWaveM) {
            maxWaveM = n.waveHeightM;
            maxWaveAt = { lat: route[i - 1].lat, lon: route[i - 1].lon };
        }
        const comfort = seaComfort(
            {
                total: { hM: n.waveHeightM, periodS: n.wavePeriodS ?? null, fromDeg: n.waveFromDeg ?? null },
                windSea: null,
                swell: null,
            },
            vessel,
        );
        if (comfort?.word) {
            level = Math.max(level ?? 0, WORDS.indexOf(comfort.word));
            genericBoat = comfort.generic;
        }
    }
    return {
        maxWaveM,
        maxWaveAt,
        knownHours,
        unknownHours,
        coverage: knownHours === 0 ? 'unavailable' : unknownHours > 0 ? 'partial' : 'complete',
        level,
        word: level === null ? null : WORDS[level],
        genericBoat,
    };
}

export function routeComfortLines(comfort?: RouteComfortSummary | null): string[] {
    if (!comfort) return [];
    const at = comfort.maxWaveAt;
    const place = at
        ? ` near ${Math.abs(at.lat).toFixed(3)}° ${at.lat < 0 ? 'S' : 'N'}, ${Math.abs(at.lon).toFixed(3)}° ${at.lon < 0 ? 'W' : 'E'}`
        : '';
    const lines = [
        comfort.coverage === 'unavailable'
            ? 'Wave coverage unavailable; the route has no proven wave-limit clearance.'
            : `Wave coverage ${comfort.coverage}; known maximum ${comfort.maxWaveM!.toFixed(1)} m${place}${comfort.unknownHours > 0 ? `; ${comfort.unknownHours.toFixed(1)} h unchecked` : ''}.`,
    ];
    if (comfort.relaxedFromM !== undefined)
        lines.push(
            `Relaxed wave limit: needs ${comfort.maxWaveM?.toFixed(1) ?? 'unknown'} m seas${place}; your limit is ${comfort.relaxedFromM.toFixed(1)} m.`,
        );
    if (comfort.word)
        lines.push(
            `Beta comfort ${comfort.level}/3: ${comfort.word}${comfort.genericBoat ? ' for a generic 38 ft boat' : ''}. Total waves only; wind-sea and cross-sea effects are unknown. This is not a safety rating.`,
        );
    return lines;
}

/** Recheck the actual smoothed line: an endpoint-only test can shortcut a storm or a high-sea cell. */
export function inspectRouteEnvironment(
    route: readonly IsochroneNode[],
    waves: WaveField | null | undefined,
    exclusions: ExclusionField | null | undefined,
    maxWaveM: number | undefined,
    vessel?: Pick<VesselProfile, 'length' | 'type'>,
): { comfort: RouteComfortSummary; rejected: boolean } {
    const samples: IsochroneNode[] = route.length ? [{ ...route[0] }] : [];
    let rejected = route.length < 2,
        count = 0,
        endpointMissing = false;
    let peak: { heightM: number; lat: number; lon: number } | null = null;
    const check = (point: { lat: number; lon: number }, time: number, boundary: boolean) => {
        if (![point.lat, point.lon, time].every(Number.isFinite) || Math.abs(point.lat) > 90) {
            rejected = true;
            return null;
        }
        const value = waves?.getWave(point.lat, point.lon, time);
        const wave = value && Number.isFinite(value.heightM) && value.heightM >= 0 ? value : null;
        if (wave && (!peak || wave.heightM > peak.heightM)) peak = { heightM: wave.heightM, ...point };
        if (boundary && !wave) endpointMissing = true;
        if (
            (wave && maxWaveM !== undefined && wave.heightM > maxWaveM) ||
            exclusions?.isExcluded(point.lat, point.lon, time)
        )
            rejected = true;
        return wave;
    };
    // The origin is a real displayed endpoint and must never be skipped.
    if (route.length) check(route[0], route[0].timeHours, true);
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1],
            b = route[i];
        const distance = haversineNm(a.lat, a.lon, b.lat, b.lon);
        const hours = b.timeHours - a.timeHours;
        const fractions = routeSampleFractions(a.timeHours, b.timeHours, distance, waves?.sampleHours, 2049 - count);
        if (!fractions) {
            rejected = true;
            break;
        }
        const bearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        for (let j = 1; j < fractions.length; j++) {
            const fraction = (fractions[j - 1] + fractions[j]) / 2;
            const point = projectPosition(a.lat, a.lon, bearing, distance * fraction);
            const wave = check(point, a.timeHours + hours * fraction, false);
            samples.push({
                ...b,
                ...point,
                timeHours: a.timeHours + hours * fractions[j],
                waveHeightM: wave?.heightM ?? null,
                wavePeriodS: wave?.periodS ?? null,
                waveFromDeg: wave?.directionFromDeg ?? null,
            });
            const right = fractions[j];
            const endpoint = right === 1 ? b : projectPosition(a.lat, a.lon, bearing, distance * right);
            check(endpoint, a.timeHours + hours * right, true);
            count++;
        }
    }
    const comfort = routeComfortForNodes(samples, vessel);
    const highest = peak as { heightM: number; lat: number; lon: number } | null;
    if (highest) {
        comfort.maxWaveM = highest.heightM;
        comfort.maxWaveAt = { lat: highest.lat, lon: highest.lon };
    }
    if (endpointMissing && comfort.coverage === 'complete') comfort.coverage = 'partial';
    return { comfort, rejected };
}
