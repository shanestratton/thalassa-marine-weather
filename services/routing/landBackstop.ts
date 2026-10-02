/**
 * Land backstop — caller-side sanity sweep over an inshore route polyline.
 *
 * WHY (field bug, 2026-06-12, Newport → Mooloolaba): the inshore engine's
 * grid default is PERMISSIVE — space with no chart features at all is
 * UNKNOWN_OPEN, freely navigable. Inside a well-charted harbour that is
 * the right call; across a chart-coverage gap it means islands literally
 * do not exist (reproduced: a 32.7 NM dead-straight route over Bribie
 * Island with zero caution flags when the corridor's cells are missing).
 * The coverage gate only checks the route ENDPOINTS, so a mid-corridor
 * hole sails straight through.
 *
 * This backstop corroborates the FINAL polyline against NOAA ETOPO global
 * relief (nominal 1 arc-minute / ~1.8 km grid, cached app-side): sampled
 * points whose ETOPO value reads at/above sea level, in runs long enough to not be a
 * coastal-pixel kiss, mean the route crosses land → the caller rejects
 * the inshore result and falls back to the offshore pipeline.
 *
 * Deliberately conservative the other way too: ETOPO is too coarse to
 * veto legitimate dredged channels (they read as WATER below datum, not
 * land), and a single land-flagged request point is ignored — only a
 * run of ≥ MIN_RUN_SAMPLES rejects. Request points are ~400 m apart but
 * are not independent grid cells; this remains a coarse veto, never a
 * fine-resolution clearance. Bribie is
 * 8 km wide; no real channel transit trips this.
 *
 * Structural fix (corridor coverage gate + UNCHARTED ≠ OPEN in the
 * engine) is Lane B work — see ROUTING_COLLAB.md reply 16. This backstop
 * stays afterwards as defence in depth.
 *
 * WHERE THE CHARTS SAY WATER (field bug, 2026-10-02, Coral Sea Marina →
 * Daydream Island): ETOPO's ~1.8 km pixels read the marina, its dredged
 * channel and the deep water off a headland as land — 5 + 9 samples on a
 * route the 1:12,000 and 1:90,000 cells chart as 1.8–30 m water — and every
 * Whitsundays route from a marina was refused. ETOPO is there for chart
 * GAPS, so an ETOPO land sample now counts only where the installed charts
 * do not vouch for water (`chartWater`, the route's own layers:
 * safetyAudit.backstopChartWaterProbe): no S-57 depth band at a scale finer
 * than ETOPO's pixel (usage band 3+) that never dries there under the
 * decision-1 finest-band rule, and none of the route's own OSM water.
 * Overview cells never vouch — they generalise small islands away. A chart
 * gap still rejects (Bribie), and so does land the charts show too.
 *
 * A LONE SAMPLE CAN BE AN ISLAND (review fix-up, 2026-10-02): with the
 * charts vouching either side, a ≤1 km island charted at 1:90,000 was one
 * land sample between two vouched ones — a "run" of 1, passed (Daydream
 * Island itself, east–west). Away from the route's ends (more than
 * LONE_SAMPLE_END_CLEARANCE_M along it — nearer, it is a pin's own land,
 * decision 7), one ETOPO land sample counts on its own where a detailed chart
 * shows land or drying ground there too, or where the charts vouch for water
 * on both sides but say nothing at it (a hole in detailed coverage — the
 * island whose land paint did not merge). Navigable OSM water the charts do
 * not vouch for is neutral: it never counts, and a short stretch of it
 * (MAX_OSM_WATER_BRIDGE_SAMPLES) does not break a run, so a pond cannot split
 * an island in two (chartWaterEvidence 'osm-water').
 */

import {
    GebcoDepthService,
    ROUTE_RELIEF_ATTEMPT_MS,
    ROUTE_RELIEF_RETRY_DELAYS_MS,
    type DepthResult,
    type ReliefFailure,
} from '../GebcoDepthService';
import type { ChartWaterProbe, ChartWaterVerdict } from '../engine/chartWaterEvidence';
import { createLogger } from '../../utils/createLogger';
import { withTimeout } from '../../utils/deadline';

const log = createLogger('landBackstop');

/**
 * Hard cap on how long a SUCCESSFUL inshore route may wait on this
 * backstop before it renders. A timeout is an explicit unavailable verdict:
 * callers must not present the route as verified safe.
 *
 * WHY NOT 10 s (2026-10-02, Shane's phone online, an 18.3 NM Whitsundays
 * route): the check asked the edge for its ~85 samples point by point, which
 * the edge answers ten at a time from NOAA ERDDAP — 86 points measured 12.98 s
 * at the edge that day — so every route over ~9 NM timed out, and the timeout
 * was worded "offline". It now asks for the route's box in one grid request
 * (GebcoDepthService.queryRouteRelief: 1.13 s upstream), each attempt bounded
 * by ROUTE_RELIEF_ATTEMPT_MS with one retry; this cap only backs that up.
 */
export const BACKSTOP_DEADLINE_MS =
    ROUTE_RELIEF_ATTEMPT_MS * (ROUTE_RELIEF_RETRY_DELAYS_MS.length + 1) +
    ROUTE_RELIEF_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) +
    2_000;

export type LonLat = [number, number];

/** ETOPO elevation at/above sea level counts as land-ish. */
export const LAND_DEPTH_THRESHOLD_M = 0;
/** Consecutive land-reading request points required to call it a crossing. */
export const MIN_RUN_SAMPLES = 2;
/** Along-route sampling interval. */
export const SAMPLE_STEP_M = 400;
/**
 * A lone ETOPO land sample counts on its own only this far along the route
 * from BOTH of its ends (review fix-up, 2026-10-02): nearer, it is a pin's own
 * land or drying bank (owner decision 7), which the route already says.
 */
export const LONE_SAMPLE_END_CLEARANCE_M = 500;
/**
 * At most this many consecutive OSM-water samples the charts do not vouch for
 * are passed over between two land samples, joining them into one run (~800 m:
 * a pond on an island, review fix-up 2026-10-02). A longer stretch is real
 * navigable water on the way — a river or a canal estate — and breaks the run,
 * so two stray samples kilometres apart up an OSM-only river never join.
 */
export const MAX_OSM_WATER_BRIDGE_SAMPLES = 2;
/** Hard cap on samples per validation (legacy gebco-depth endpoint batch limit). */
export const MAX_SAMPLES = 180;

/**
 * What the installed charts said where ETOPO read land: 'land' (a detailed
 * chart shows land or drying ground there too), 'uncharted' (no chart finer
 * than ETOPO's pixel covers it — a chart gap) or 'unchecked' (the caller
 * gave no chart evidence).
 */
export type LandRunCharts = 'land' | 'uncharted' | 'unchecked';

export interface LandRun {
    /** Index of the first sample in the run. */
    startIdx: number;
    samples: number;
    /** Representative coordinate (first sample of the run). */
    lat: number;
    lon: number;
    /** The run's middle sample — where the refusal says it is. */
    midLat?: number;
    midLon?: number;
    /** What the charts say along the run (findLandRuns leaves it unset). */
    charts?: LandRunCharts;
    /** An 'uncharted' run where a small-scale (overview or general) chart
     *  paints land too — the words must not imply water there. */
    smallScaleLand?: boolean;
}

/**
 * Pure: find runs of consecutive land-reading samples. NOAA ETOPO uses
 * negative elevation below sea level and positive elevation on land.
 * Null depths break runs — unknown is not evidence of land. ETOPO alone:
 * what the charts say is judged afterwards (countedLandRuns).
 */
export function findLandRuns(depths: DepthResult[], thresholdM = LAND_DEPTH_THRESHOLD_M): LandRun[] {
    const runs: LandRun[] = [];
    let start = -1;
    for (let i = 0; i <= depths.length; i++) {
        const depth = i < depths.length ? depths[i].depth_m : null;
        const isLand = depth !== null && Number.isFinite(depth) && depth >= thresholdM;
        if (isLand && start === -1) start = i;
        if (!isLand && start !== -1) {
            const mid = depths[start + Math.floor((i - start) / 2)];
            runs.push({
                startIdx: start,
                samples: i - start,
                lat: depths[start].lat,
                lon: depths[start].lon,
                midLat: mid.lat,
                midLon: mid.lon,
            });
            start = -1;
        }
    }
    return runs;
}

/** Great-circle metres between two [lon, lat] points. */
function dist(a: LonLat, b: LonLat): number {
    const R = 6371000;
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/** Pure: sample a polyline every ~stepM, capped at maxSamples (incl. ends). */
export function samplePolyline(polyline: LonLat[], stepM = SAMPLE_STEP_M, maxSamples = MAX_SAMPLES): LonLat[] {
    if (polyline.length < 2) return [...polyline];
    let total = 0;
    for (let i = 0; i < polyline.length - 1; i++) total += dist(polyline[i], polyline[i + 1]);
    const step = Math.max(stepM, total / Math.max(1, maxSamples - 1));

    const out: LonLat[] = [polyline[0]];
    let carried = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const segLen = dist(a, b);
        if (segLen === 0) continue;
        let along = step - carried;
        while (along < segLen) {
            const t = along / segLen;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            along += step;
        }
        carried = (carried + segLen) % step;
    }
    out.push(polyline[polyline.length - 1]);
    return out;
}

export interface LandBackstopResult {
    /** Whether the no-land/crosses-land verdict is complete enough to trust. */
    status: 'verified' | 'unavailable';
    crossesLand: boolean;
    runs: LandRun[];
    /** Samples with a finite NOAA ETOPO value. */
    samplesChecked: number;
    /** Samples requested along the final route geometry. */
    samplesRequested: number;
    /** ETOPO land samples a chart finer than ETOPO vouches is water — not
     *  counted, and they break a run like water. */
    vouchedLandSamples?: number;
    /** ETOPO land samples only the route's own navigable OSM water covers —
     *  neutral: neither counted nor breaking a run. */
    osmWaterSamples?: number;
    /** ETOPO land runs (≥ MIN_RUN_SAMPLES) made only of vouched or OSM-water
     *  samples — ignored. */
    ignoredRuns?: number;
    /** Why the check could not finish (status 'unavailable'): what actually
     *  happened, for the words (landBackstopWords.backstopUnavailableWords). */
    unavailable?: ReliefFailure;
    /**
     * What the charts said at every sample (samplePolyline of this polyline),
     * when the caller gave chart evidence: a later retry of the check needs
     * only these, not the engine's layers (Auto's Retry, 2026-10-02). Plain
     * words — it is cloned and kept with the proposal in memory.
     */
    chartVerdicts?: BackstopChartVerdict[];
}

/** What the charts said at one sample: a probe's verdict, or 'unchecked'
 *  where the probe threw (it vouches nothing there — fail closed). */
export type BackstopChartVerdict = ChartWaterVerdict | 'unchecked';

export interface LandBackstopOptions {
    /**
     * What the installed charts say at a point — the route's own layers
     * (InshoreRouteResult.chartWater, built by the engine wrapper from the
     * cells and OSM water it routed on). Absent: nothing vouches, every ETOPO
     * land sample counts (the backstop as it was).
     */
    chartWater?: ChartWaterProbe;
    /**
     * The charts' verdict at every sample, from an earlier run of this check
     * on the SAME polyline (LandBackstopResult.chartVerdicts) — for a retry
     * that has no engine layers. Used only when it has one verdict per sample;
     * otherwise nothing vouches (fail closed). `chartWater` wins when both are
     * given.
     */
    chartVerdicts?: readonly BackstopChartVerdict[];
}

type SampleCharts = ChartWaterVerdict | 'unchecked' | null;

const unvouched = (c: SampleCharts): boolean => c !== null && c !== 'water' && c !== 'osm-water';
const uncharted = (c: SampleCharts): boolean => c === 'uncharted' || c === 'uncharted-land';

/**
 * Pure: the land runs that count, from ETOPO (`depths`) and what the charts
 * said at each ETOPO land sample (`charts`, null where ETOPO reads water or
 * nothing). A sample counts where ETOPO reads land and the charts do not
 * vouch for water; a vouched sample breaks a run like water; an 'osm-water'
 * sample is passed over (neither counts nor breaks) — up to
 * MAX_OSM_WATER_BRIDGE_SAMPLES in a row, beyond which it breaks the run. A run counts from
 * MIN_RUN_SAMPLES samples — or from one, more than LONE_SAMPLE_END_CLEARANCE_M
 * along the route from both ends, where the charts show land there, or vouch
 * for water on both sides and say nothing at it.
 */
function countedLandRuns(depths: DepthResult[], charts: readonly SampleCharts[], samples: LonLat[]): LandRun[] {
    const along: number[] = [0];
    for (let i = 1; i < samples.length; i++) along.push(along[i - 1] + dist(samples[i - 1], samples[i]));
    const total = along[along.length - 1] ?? 0;
    const clearOfEnds = (i: number): boolean =>
        along[i] > LONE_SAMPLE_END_CLEARANCE_M && total - along[i] > LONE_SAMPLE_END_CLEARANCE_M;
    /** The nearest sample on one side past any (bridgeable) OSM water is
     *  chart-vouched. */
    const vouchedBeside = (i: number, step: 1 | -1): boolean => {
        let j = i + step;
        for (let k = 0; k < MAX_OSM_WATER_BRIDGE_SAMPLES && charts[j] === 'osm-water'; k++) j += step;
        return j >= 0 && j < charts.length && charts[j] === 'water';
    };
    const groups: number[][] = [];
    let current: number[] = [];
    let osmStretch = 0;
    const flush = (): void => {
        if (current.length > 0) groups.push(current);
        current = [];
    };
    charts.forEach((c, i) => {
        if (c === 'osm-water') {
            // Neutral — neither counts nor breaks — over a short stretch only.
            if (++osmStretch > MAX_OSM_WATER_BRIDGE_SAMPLES) flush();
            return;
        }
        osmStretch = 0;
        if (unvouched(c)) current.push(i);
        else flush();
    });
    flush();
    const runs: LandRun[] = [];
    for (const group of groups) {
        const lone = group.length === 1 ? group[0] : -1;
        const counts =
            group.length >= MIN_RUN_SAMPLES ||
            (lone >= 0 &&
                clearOfEnds(lone) &&
                (charts[lone] === 'land' ||
                    (uncharted(charts[lone]) && vouchedBeside(lone, -1) && vouchedBeside(lone, 1))));
        if (!counts) continue;
        const said = group.map((i) => charts[i]);
        const first = depths[group[0]];
        const mid = depths[group[Math.floor(group.length / 2)]];
        const verdict: LandRunCharts = said.includes('land')
            ? 'land'
            : said.some(uncharted)
              ? 'uncharted'
              : 'unchecked';
        runs.push({
            startIdx: group[0],
            samples: group.length,
            lat: first.lat,
            lon: first.lon,
            midLat: mid.lat,
            midLon: mid.lon,
            charts: verdict,
            ...(verdict === 'uncharted' && said.includes('uncharted-land') ? { smallScaleLand: true } : {}),
        });
    }
    return runs;
}

/**
 * Corroborate an inshore route polyline against coarse NOAA ETOPO. Data unavailability
 * is explicit and fail-closed: a caller may draw a route as verified only
 * when status='verified' and crossesLand=false. A confirmed land run is a
 * verified rejection even if another sample was unavailable. An ETOPO land
 * sample counts only where `opts.chartWater` does not vouch for water
 * (countedLandRuns says when one alone is a crossing); a probe that throws
 * vouches nothing there (fail closed).
 */
export async function inshoreRouteCrossesLand(
    polyline: LonLat[],
    opts: LandBackstopOptions = {},
): Promise<LandBackstopResult> {
    const samples = samplePolyline(polyline);
    // What the charts say at every sample, asked once, up front — so the
    // result can carry it for a retry (Auto's Retry, 2026-10-02). A probe
    // that throws vouches nothing there (fail closed).
    let probeFailed = false;
    const chartVerdicts: BackstopChartVerdict[] | undefined = opts.chartWater
        ? samples.map(([lon, lat]) => {
              try {
                  return opts.chartWater!(lon, lat);
              } catch (e) {
                  if (!probeFailed) log.warn('[landBackstop] chart evidence failed — it vouches nothing there:', e);
                  probeFailed = true;
                  return 'unchecked';
              }
          })
        : opts.chartVerdicts?.length === samples.length
          ? [...opts.chartVerdicts]
          : undefined;
    const carried = chartVerdicts ? { chartVerdicts } : {};
    const unavailable = (samplesChecked = 0, why?: ReliefFailure | null): LandBackstopResult => ({
        status: 'unavailable',
        crossesLand: false,
        runs: [],
        samplesChecked,
        samplesRequested: samples.length,
        ...(why ? { unavailable: why } : {}),
        ...carried,
    });

    if (samples.length < 2) return unavailable();

    try {
        const relief = await withTimeout(
            GebcoDepthService.queryRouteRelief(samples.map(([lon, lat]) => ({ lat, lon }))),
            null,
            BACKSTOP_DEADLINE_MS,
        );
        const depths = relief?.depths ?? null;
        if (!relief || !depths || depths.length !== samples.length) {
            log.warn('[landBackstop] ETOPO response missing or misaligned — route remains unverified');
            return unavailable(0, relief ? relief.failure : { kind: 'timeout', waitedMs: BACKSTOP_DEADLINE_MS });
        }

        const samplesChecked = depths.filter((sample) => Number.isFinite(sample.depth_m)).length;
        // What the charts say where ETOPO reads land.
        const charts: SampleCharts[] = depths.map((sample, i) => {
            const depth = sample.depth_m;
            if (depth === null || !Number.isFinite(depth) || depth < LAND_DEPTH_THRESHOLD_M) return null;
            return chartVerdicts?.[i] ?? 'unchecked';
        });
        const vouchedLandSamples = charts.filter((c) => c === 'water').length;
        const osmWaterSamples = charts.filter((c) => c === 'osm-water').length;
        // ETOPO's own runs made only of vouched (or OSM-water) samples:
        // ignored, said.
        const ignoredRuns = findLandRuns(depths).filter(
            (r) =>
                r.samples >= MIN_RUN_SAMPLES &&
                charts.slice(r.startIdx, r.startIdx + r.samples).every((c) => c === 'water' || c === 'osm-water'),
        ).length;
        if (vouchedLandSamples + osmWaterSamples > 0)
            log.warn(
                `[landBackstop] ignored ${vouchedLandSamples} ETOPO land sample(s) (${ignoredRuns} whole run(s)) ` +
                    'where the installed charts finer than ETOPO show water' +
                    (osmWaterSamples > 0
                        ? `; passed over ${osmWaterSamples} only the route's own OSM water covers (neither counted nor breaking a run)`
                        : ''),
            );
        const runs = countedLandRuns(depths, charts, samples);
        const vouched = { vouchedLandSamples, osmWaterSamples, ignoredRuns };
        if (runs.length > 0) {
            log.warn(
                `[landBackstop] inshore route crosses land: ${runs.length} run(s), first at ` +
                    `${runs[0].lat.toFixed(4)},${runs[0].lon.toFixed(4)} (${runs[0].samples} samples, charts: ${runs[0].charts}) — rejecting`,
            );
            return {
                status: 'verified',
                crossesLand: true,
                runs,
                samplesChecked,
                samplesRequested: samples.length,
                ...vouched,
                ...carried,
            };
        }

        if (samplesChecked !== samples.length) {
            log.warn(
                `[landBackstop] ETOPO unavailable for ${samples.length - samplesChecked}/${samples.length} sample(s) — ` +
                    'route remains unverified',
            );
            return {
                ...unavailable(
                    samplesChecked,
                    relief.failure ?? {
                        kind: 'partial',
                        missing: samples.length - samplesChecked,
                        total: samples.length,
                    },
                ),
                ...vouched,
            };
        }

        return {
            status: 'verified',
            crossesLand: false,
            runs: [],
            samplesChecked,
            samplesRequested: samples.length,
            ...vouched,
            ...carried,
        };
    } catch (e) {
        log.warn('[landBackstop] ETOPO unavailable — route remains unverified:', e);
        return unavailable();
    }
}
