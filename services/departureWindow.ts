/** Bounded exploratory weather comparison. Selecting a time reruns the full chart verifier. */
import { vesselDraftMetres } from './units';
import { withTimeout } from '../utils/deadline';
import type { VesselProfile } from '../types';
import type { WindField, CurrentField, ExclusionField, WaveField, IsochroneResult } from './IsochroneRouter';
import { haversineNm } from './isochrone/geodesy';
import { routingComfortConfig, vesselIsochroneConfig } from './routing/isochronePolicy';
import { departureMetrics } from './routing/departureMetrics';
import type { DepartureWeatherField } from './routing/departureWeather';
import {
    departureScore,
    departureScoreTerms,
    type DepartureScoreTerms,
    type ScoredDeparture,
} from './passageDepartureSuggestion';

export interface DepartureScenario {
    departureTime: string;
    arrivalTime: string;
    durationHours: number;
    distanceNM: number;
    maxWindKts: number;
    avgWindKts: number;
    galeHours: number;
    stormHours: number;
    /** Lower is calmer on the same fully covered terms. No safety-clearance claim. */
    score: number;
    verdict: 'go' | 'maybe' | 'avoid' | 'no-go';
    routeFound: boolean;
    maxWaveM?: number | null;
    maxRainMmPerHour?: number | null;
    upwindPct?: number | null;
    avgCurrentKts?: number | null;
    comfortLevel?: number | null;
    windComplete?: boolean;
    coverage?: string[];
    rankedTerms?: string[];
    tideStatus?: 'clear' | 'blocked' | 'unknown' | 'not-gated';
    weatherModel?: string;
    /** Internal score inputs shared with PYD and the passage departure suggestion. */
    comparison?: ScoredDeparture;
}
export interface DepartureWindowOptions {
    /** 3 or 6 hours; default 6. */
    intervalHours?: number;
    windowHours?: number;
    /** At most 24 runs, default 14. */
    maxScenarios?: number;
    /** Whole operation budget, bounded to 180 seconds, default 90 seconds. */
    maxComputeMs?: number;
    shouldContinue?: () => boolean;
    onProgress?: (progress: { completed: number; total: number; scenarios: readonly DepartureScenario[] }) => void;
    weatherField?: DepartureWeatherField | null;
    /** Short hops compare this locked, independently verified inshore line. */
    fixedRoute?: IsochroneResult;
    /** Shared 128 leave-window result for this exact verified route, supplied by its owner. */
    tideForRoute?: (
        result: IsochroneResult,
        departureMs: number,
    ) => Promise<NonNullable<DepartureScenario['tideStatus']>>;
}

function rank(scenarios: DepartureScenario[]): DepartureScenario[] {
    const eligible = scenarios.filter((s) => s.routeFound && s.windComplete && s.verdict !== 'no-go');
    const terms = departureScoreTerms(eligible.flatMap((s) => (s.comparison ? [s.comparison] : [])));
    const named: [keyof DepartureScoreTerms, string][] = [
        ['gusts', 'gusts'],
        ['waves', 'waves'],
        ['rain', 'rain'],
        ['upwind', 'upwind'],
        ['current', 'ocean current'],
        ['comfort', 'beta comfort'],
    ];
    for (const scenario of scenarios) {
        scenario.rankedTerms = ['wind', 'headwind', ...named.filter(([key]) => terms[key]).map(([, name]) => name)];
        scenario.score =
            scenario.routeFound && scenario.windComplete && scenario.verdict !== 'no-go' && scenario.comparison
                ? departureScore(scenario.comparison, terms)
                : Infinity;
    }
    return [...scenarios].sort(
        (a, b) =>
            a.score - b.score || a.durationHours - b.durationHours || a.departureTime.localeCompare(b.departureTime),
    );
}

export async function planDepartureWindow(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    vessel: VesselProfile,
    windField: WindField,
    polar: import('../types').PolarData,
    bathyGrid: import('./BathymetryCache').BathymetryGrid | null,
    currentField: CurrentField | null,
    exclusionField: ExclusionField | null,
    waveField: WaveField | null,
    comfortParams: import('../types/settings').ComfortParams | null | undefined,
    windowStartIso: string,
    options: DepartureWindowOptions = {},
): Promise<DepartureScenario[]> {
    const start = performance.now();
    const budgetMs = Math.max(1, Math.min(180_000, options.maxComputeMs ?? 90_000));
    const intervalHours = options.intervalHours !== undefined && options.intervalHours <= 3 ? 3 : 6;
    const windowHours = Math.max(0, Math.min(168, options.windowHours ?? 168));
    const count = Math.max(0, Math.min(24, options.maxScenarios ?? 14, Math.floor(windowHours / intervalHours) + 1));
    const windowStartMs = Date.parse(windowStartIso);
    const canContinue = () => {
        try {
            return performance.now() - start < budgetMs && (options.shouldContinue?.() ?? true);
        } catch {
            return false;
        }
    };
    if (!Number.isFinite(windowStartMs) || !canContinue()) return [];
    const { computeIsochrones } = await import('./IsochroneRouter');
    const scenarios: DepartureScenario[] = [];
    const vesselConfig = vesselIsochroneConfig(
        vessel,
        haversineNm(origin.lat, origin.lon, destination.lat, destination.lon),
    );
    const comfortConfig = routingComfortConfig(vessel, comfortParams ?? undefined);
    for (let i = 0; i < count && canContinue(); i++) {
        const offset = i * intervalHours,
            depMs = windowStartMs + offset * 3_600_000;
        const depIso = new Date(depMs).toISOString();
        // All supplied fields share windowStartIso. Never reset their forecast clock per scenario.
        const wind: WindField = options.weatherField
            ? {
                  getWind: (lat, lon, hours) => {
                      const w = options.weatherField!.getWeather(lat, lon, depMs + hours * 3_600_000);
                      return w?.windSpeedKts != null && w.windDirection != null
                          ? { speed: w.windSpeedKts, direction: w.windDirection }
                          : null;
                  },
              }
            : { getWind: (lat, lon, hours) => windField.getWind?.(lat, lon, hours + offset) ?? null };
        const currents = currentField && {
            getCurrent: (lat: number, lon: number, hours: number) => currentField.getCurrent(lat, lon, hours + offset),
        };
        const waves = waveField && {
            getWave: (lat: number, lon: number, hours: number) => waveField.getWave(lat, lon, hours + offset),
        };
        const exclusions = exclusionField && {
            isExcluded: (lat: number, lon: number, hours: number) =>
                exclusionField.isExcluded(lat, lon, hours + offset),
        };
        let result: IsochroneResult | null = null;
        try {
            result = options.fixedRoute
                ? {
                      ...options.fixedRoute,
                      arrivalTime: new Date(depMs + options.fixedRoute.totalDurationHours * 3_600_000).toISOString(),
                  }
                : await computeIsochrones(
                      origin,
                      destination,
                      depIso,
                      polar,
                      wind,
                      {
                          ...vesselConfig,
                          ...comfortConfig,
                          vesselDraft: vesselDraftMetres(vessel),
                          minDepthM: null,
                          timeStepHours: Math.max(3, vesselConfig.timeStepHours),
                          bearingCount: 24,
                          shouldContinue: canContinue,
                      },
                      bathyGrid,
                      currents,
                      exclusions,
                      waves,
                  );
        } catch {
            /* One failed scenario does not erase earlier completed comparisons. */
        }
        if (!canContinue()) break;
        const scenario: DepartureScenario = {
            departureTime: depIso,
            arrivalTime: result?.arrivalTime ?? depIso,
            durationHours: result?.totalDurationHours ?? 0,
            distanceNM: result?.totalDistanceNM ?? 0,
            maxWindKts: 0,
            avgWindKts: 0,
            galeHours: 0,
            stormHours: 0,
            routeFound: !!result,
            verdict: 'no-go',
            score: Infinity,
            tideStatus: 'unknown',
        };
        if (result) {
            const metrics = departureMetrics(
                result.route,
                depMs,
                wind,
                currents,
                waves,
                exclusions,
                options.weatherField,
                vessel,
                comfortConfig.comfortParams?.maxWaveM,
            );
            // A caller that explicitly tried and could not load an absolute-clock
            // field must not rank the legacy grid's clamped final hour as a forecast.
            if (options.weatherField === null) metrics.windComplete = false;
            const coverage = [
                !metrics.windComplete && 'wind',
                !metrics.gustComplete && 'gusts',
                !metrics.waveComplete && 'waves',
                !metrics.rainComplete && 'rain',
                !metrics.currentComplete && 'ocean current',
            ].filter((s): s is string => !!s);
            let tideStatus: NonNullable<DepartureScenario['tideStatus']> = 'unknown';
            try {
                if (options.tideForRoute)
                    tideStatus = await withTimeout(options.tideForRoute(result, depMs), 'unknown' as const, 5_000);
            } catch {
                /* A missing tide answer stays unknown. */
            }
            if (!canContinue()) break;
            Object.assign(scenario, {
                ...metrics,
                coverage,
                tideStatus,
                weatherModel: options.weatherField?.model ?? 'Loaded wind forecast',
                verdict:
                    metrics.rejected ||
                    (comfortConfig.comfortParams?.maxWindKts !== undefined &&
                        metrics.maxWindKts > comfortConfig.comfortParams.maxWindKts) ||
                    (comfortConfig.comfortParams?.maxGustKts !== undefined &&
                        metrics.maxGustKts > comfortConfig.comfortParams.maxGustKts) ||
                    tideStatus === 'blocked' ||
                    metrics.stormHours > 0 ||
                    metrics.maxWindKts >= 50
                        ? 'no-go'
                        : metrics.galeHours >= 6 || metrics.maxWindKts >= 40
                          ? 'avoid'
                          : metrics.galeHours > 0 ||
                              metrics.maxWindKts >= 30 ||
                              coverage.length ||
                              tideStatus === 'unknown'
                            ? 'maybe'
                            : 'go',
                comparison: { departureMs: depMs, ...metrics, maxWaveM: metrics.maxWaveM ?? 0 },
            });
        }
        scenarios.push(scenario);
        if (!canContinue()) break;
        try {
            options.onProgress?.({ completed: i + 1, total: count, scenarios: rank(scenarios) });
        } catch {
            /* Caller-owned progress cannot break computation. */
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return rank(scenarios);
}
