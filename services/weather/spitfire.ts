/**
 * SPITFIRE — the consensus member from Shane's weather server.
 *
 * Not a forecast model and not something you can ask a grid for: it is a
 * WEIGHTED BLEND of five models, whose weights are re-scored daily against
 * the beacons, computed by `ops/bin/wx-forecast` on the wx box and published
 * as a finished JSON artifact. Named for Spitfire Channel off Scarborough,
 * beside the tide gauge that anchors the whole system.
 *
 * Two consequences shape this module:
 *
 *  1. It exists only at the handful of locations the server computes, so it
 *     can never be a peer of ICON/ECMWF in the picker — those answer at any
 *     lat/lon, this answers at a fixed list. Availability is therefore a
 *     function of WHERE THE BOAT IS, and callers must check first.
 *  2. The artifact is on PUBLIC object storage, so unlike the tailnet wx
 *     server it needs no Tailscale and works on the deployed HTTPS build.
 *
 * It also publishes something no single model has: the min/max envelope
 * across members (the band), plus live per-member weights and MAE.
 */
import { CapacitorHttp } from '@capacitor/core';

import type { MarineWeatherReport } from '../../types';
import { degreesToCardinal } from '../../utils/format';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('spitfire');

const ARTIFACT_URL = 'https://pcisdplnodrphauixcau.supabase.co/storage/v1/object/public/weather/status/forecast.json';

/**
 * Locations the server computes SPITFIRE for. A slug earns its place here by
 * having MEASURED skill at that site — never by being somewhere we happen to
 * publish a blend. Offering it at Corfu would mean dressing a Newport-tuned
 * average up as a Mediterranean forecast.
 *
 * newport    — the original site. Weights scored against four in-bay beacon
 *              anemometers. Honest caveat: as of 2026-07-22 this rests on ~106
 *              samples over 40 h in two wind-direction sectors, the bias
 *              correction is still WITHHELD for being below its guards, and the
 *              blend does not yet beat its best single member. It is the site
 *              with the least evidence, not the most.
 *
 * townsville — added 2026-07-22, and on far stronger ground: 17,099 paired
 *              hours over 810 days, effective N 396 after autocorrelation, wind
 *              sampled OVER WATER at Cleveland Bay rather than at the town, and
 *              per-site multiplicative corrections plus inverse-variance weights
 *              both fitted on the earlier half and validated on the later. The
 *              blend beats every individual member there at every lead time.
 *
 * Both are checked against the artifact at fetch time, so a slug listed here
 * without a published consensus degrades to null rather than throwing.
 */
export const SPITFIRE_LOCATIONS: { slug: string; name: string; lat: number; lon: number }[] = [
    { slug: 'newport', name: 'Newport QLD', lat: -27.2, lon: 153.1 },
    // The TOWN coordinate, matching the artifact's `townsville` entry. The
    // server samples that location's WIND 14 km offshore at Cleveland Bay, but
    // the slug and its coordinates stay the town's — a marine sample must never
    // be relabelled as somewhere it was not taken.
    { slug: 'townsville', name: 'Townsville QLD', lat: -19.26, lon: 146.82 },
];

/** How close the boat must be for the blend to describe its weather. The
 *  artifact's own grid cell is 0.25° (~25 km), so beyond this the consensus
 *  is not talking about where you are. */
const AVAILABILITY_RADIUS_KM = 25;

export interface SpitfireBand {
    /** Central (weighted) value. */
    value: number | null;
    /** Envelope across members — the disagreement, which is the information. */
    min: number | null;
    max: number | null;
}

export interface SpitfireCurrent {
    temperature_2m: number | null;
    wind_speed_10m: number | null;
    wind_gusts_10m: number | null;
    wind_direction_10m: number | null;
    pressure_msl: number | null;
    relative_humidity_2m: number | null;
    cloud_cover: number | null;
    precipitation: number | null;
    feels_like: number | null;
    dew_point: number | null;
    wind_speed_10m_min: number | null;
    wind_speed_10m_max: number | null;
}

export interface SpitfireConsensus {
    label: string;
    cadence: string;
    current: SpitfireCurrent;
    hourly: Record<string, (number | null)[] | string[]>;
    daily: Record<string, (number | null)[] | string[]>;
    weights: Record<string, number>;
    weights_status: string;
    weights_scope: string;
    mae_kt: Record<string, number>;
    member_labels: Record<string, string>;
}

export interface SpitfireLocation {
    slug: string;
    name: string;
    lat: number;
    lon: number;
    tz: string;
    consensus: SpitfireConsensus;
    generatedAt: string;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const R = 6371;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLon = ((bLon - aLon) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * The SPITFIRE location covering these coordinates, or null if the boat is
 * outside every one. Exported for tests and for the picker's gating.
 */
export function spitfireLocationFor(lat: number | null, lon: number | null): (typeof SPITFIRE_LOCATIONS)[0] | null {
    if (lat == null || lon == null) return null;
    for (const loc of SPITFIRE_LOCATIONS) {
        if (haversineKm(lat, lon, loc.lat, loc.lon) <= AVAILABILITY_RADIUS_KM) return loc;
    }
    return null;
}

/** Cheap synchronous check for UI gating — no network. */
export function isSpitfireAvailableAt(lat: number | null, lon: number | null): boolean {
    return spitfireLocationFor(lat, lon) !== null;
}

// ── Artifact fetch (memoised; the server regenerates ~30-minutely) ──
const MEMO_TTL_MS = 10 * 60 * 1000;
let memo: { at: number; data: unknown } | null = null;
let inflight: Promise<unknown> | null = null;

async function fetchArtifact(): Promise<unknown> {
    if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.data;
    if (inflight) return inflight;

    inflight = (async () => {
        const res = await CapacitorHttp.get({ url: ARTIFACT_URL, connectTimeout: 10_000, readTimeout: 10_000 });
        if (!res || res.status !== 200 || !res.data) throw new Error(`SPITFIRE HTTP ${res?.status ?? 'no response'}`);
        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        memo = { at: Date.now(), data };
        return data;
    })().finally(() => {
        inflight = null;
    });
    return inflight;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fetch SPITFIRE for these coordinates, or null when it isn't published for
 * anywhere near them (or the artifact is unreachable). Never throws.
 */
export async function fetchSpitfire(lat: number | null, lon: number | null): Promise<SpitfireLocation | null> {
    const loc = spitfireLocationFor(lat, lon);
    if (!loc) return null;

    try {
        const doc = (await fetchArtifact()) as Record<string, unknown>;
        const locations = doc?.locations as Record<string, Record<string, unknown>> | undefined;
        const entry = locations?.[loc.slug];
        const consensus = (entry?.models as Record<string, unknown> | undefined)?.consensus as
            | SpitfireConsensus
            | undefined;
        if (!consensus?.current) {
            log.warn(`SPITFIRE artifact has no consensus for ${loc.slug}`);
            return null;
        }
        return {
            slug: loc.slug,
            name: (entry?.name as string) || loc.name,
            lat: numOrNull(entry?.lat) ?? loc.lat,
            lon: numOrNull(entry?.lon) ?? loc.lon,
            tz: (entry?.tz as string) || 'UTC',
            consensus,
            generatedAt: (doc?.generated_at as string) || new Date().toISOString(),
        };
    } catch (e) {
        log.warn('SPITFIRE fetch failed:', (e as Error)?.message || e);
        return null;
    }
}

/** The wind band for the current hour — the headline reason to show it. */
export function currentWindBand(s: SpitfireLocation): SpitfireBand {
    const c = s.consensus.current;
    return {
        value: numOrNull(c.wind_speed_10m),
        min: numOrNull(c.wind_speed_10m_min),
        max: numOrNull(c.wind_speed_10m_max),
    };
}

/**
 * Overlay SPITFIRE's atmospheric values onto an already-built report.
 *
 * Deliberately an overlay rather than a from-scratch report: the consensus
 * artifact publishes atmospherics only, so building a report from it alone
 * would throw away tides, waves, sun times and conditions that the normal
 * pipeline has already assembled. This keeps that scaffolding and replaces
 * the numbers SPITFIRE actually speaks for.
 *
 * Wind is published in KNOTS (verified by reproducing the weighted blend
 * from its own members and weights, 2026-07-21), which is what the app uses
 * internally — no conversion. Mutates and returns `report`.
 */
export function applySpitfireToReport(report: MarineWeatherReport, s: SpitfireLocation): MarineWeatherReport {
    const c = s.consensus.current;

    const current = { ...report.current };
    if (numOrNull(c.wind_speed_10m) !== null) current.windSpeed = c.wind_speed_10m;
    // Gusts survive the blend even though AIFS and JMA lack them — the wx box
    // averages only the members that publish a gust field.
    if (numOrNull(c.wind_gusts_10m) !== null) current.windGust = c.wind_gusts_10m;
    if (numOrNull(c.wind_direction_10m) !== null) {
        current.windDegree = c.wind_direction_10m as number;
        current.windDirection = degreesToCardinal(c.wind_direction_10m as number);
    }
    if (numOrNull(c.temperature_2m) !== null) current.airTemperature = c.temperature_2m;
    if (numOrNull(c.pressure_msl) !== null) current.pressure = c.pressure_msl;
    if (numOrNull(c.relative_humidity_2m) !== null) current.humidity = c.relative_humidity_2m;
    if (numOrNull(c.cloud_cover) !== null) current.cloudCover = c.cloud_cover;
    if (numOrNull(c.precipitation) !== null) current.precipitation = c.precipitation;
    if (numOrNull(c.feels_like) !== null) current.feelsLike = c.feels_like;
    if (numOrNull(c.dew_point) !== null) current.dewPoint = c.dew_point;
    // The band — what no single model can tell you.
    current.windSpeedMin = numOrNull(c.wind_speed_10m_min);
    current.windSpeedMax = numOrNull(c.wind_speed_10m_max);
    report.current = current;

    // Hourly overlay, matched on epoch hour. The artifact publishes zone-less
    // local times alongside its own `tz`; parsing them relies on the device
    // sharing that zone, which holds for a boat sitting where it's looking —
    // the same assumption the rest of this pipeline already makes.
    const h = s.consensus.hourly as Record<string, (number | null)[] | string[]>;
    const times = (h?.time as string[]) || [];
    if (times.length && report.hourly?.length) {
        const key = (t: string) => Math.floor(new Date(t).getTime() / 3600000);
        const idx = new Map<number, number>();
        times.forEach((t, i) => idx.set(key(t), i));
        const at = (field: string, i: number): number | null => numOrNull((h[field] as (number | null)[])?.[i]);

        report.hourly = report.hourly.map((hr) => {
            const i = idx.get(key(hr.time));
            if (i === undefined) return hr;
            const ws = at('wind_speed_10m', i);
            const wg = at('wind_gusts_10m', i);
            const wd = at('wind_direction_10m', i);
            const tp = at('temperature_2m', i);
            const pr = at('pressure_msl', i);
            return {
                ...hr,
                windSpeed: ws ?? hr.windSpeed,
                windGust: wg ?? hr.windGust,
                windDegree: wd ?? hr.windDegree,
                windDirection: wd !== null ? degreesToCardinal(wd) : hr.windDirection,
                temperature: tp ?? hr.temperature,
                pressure: pr ?? hr.pressure,
                windSpeedMin: at('wind_speed_10m_min', i),
                windSpeedMax: at('wind_speed_10m_max', i),
            };
        });
    }

    report.spitfire = {
        label: s.consensus.label,
        cadence: s.consensus.cadence,
        weights: s.consensus.weights,
        maeKt: s.consensus.mae_kt,
        memberLabels: s.consensus.member_labels,
        weightsStatus: s.consensus.weights_status,
        weightsScope: s.consensus.weights_scope,
        locationName: s.name,
        generatedAt: s.generatedAt,
    };

    return report;
}

/** Members ranked by measured skill (lower MAE = better), for the sheet. */
export function rankedMembers(s: SpitfireLocation): { id: string; label: string; weight: number; maeKt: number }[] {
    const { weights = {}, mae_kt = {}, member_labels = {} } = s.consensus;
    return Object.keys(weights)
        .map((id) => ({
            id,
            label: member_labels[id] || id,
            weight: weights[id],
            maeKt: mae_kt[id],
        }))
        .sort((a, b) => (a.maeKt ?? Infinity) - (b.maeKt ?? Infinity));
}
