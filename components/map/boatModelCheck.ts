/**
 * boatModelCheck — "Her wind vs the models": the boat's own measured true
 * wind, set live against each global model's forecast for the same minutes
 * at her exact position, ranked by the speed gap.
 *
 * Shane 2026-10-07, answering "a simple version - her live wind against each
 * model's forecast for this hour at her position, ranked, with a clear caveat
 * that one reading is a snapshot, not a verdict": "go with your recommendation
 * big Claude".
 *
 * HONESTY, in the order a wrong answer would creep in:
 *   - her wind comes from HER lanes only: the gateway socket or the Pi over the
 *     boat LAN when the store's instruments are hers, else her own cloud row
 *     through the boat chain. Never the store's cloud lane (re-stamped on
 *     receipt, and while crewing it may be another boat's), never the phone's
 *     GPS, never a held fix;
 *   - a wind the Pi could not date is refused, not shown: the store stamps a
 *     remote TWS with the phone's receipt time, so a frozen Signal K value from
 *     an instrument that is off would read live (NmeaStore.getRemoteWindSample).
 *     Nor does it slip in through the gateway lane when a socket replaces that
 *     feed: what the feed left in the store is not the socket's
 *     (NmeaStore.getRemoteFeedEndedAt). A reading timed ahead of this phone's
 *     clock is refused as that, not as undated;
 *   - her direction is trusted only on the gateway lane (true heading plus the
 *     signed TWA, each on its own clock). The LAN TWD is re-stamped, the cloud
 *     TWD is undated and the gateway's TWD may be magnetic, so the Pi lanes are
 *     ranked on speed alone and say so;
 *   - one reading is a snapshot: the margin that ties models is 15 % of her
 *     wind for a snapshot and 10 % for a few minutes' average, never under a
 *     knot, widened by any current under her (her instruments read the wind
 *     over the water, the models over the ground);
 *   - a model with no wind at any one of her sample times is not ranked, and a
 *     model is never extrapolated more than half an hour past its hours;
 *   - the request is the proxy's own vocabulary, pinned by a contract test, and
 *     is never sent while a refusal stands. At most one per 10 NM and hour.
 *
 * Pure everywhere except gatherHerWindInput (reads the store and the chain)
 * and the series cache (one proxy request).
 *
 * BUNDLE: this is a lazy chunk opened from the Wind panel. It imports only
 * modules the app shell already holds. closeInWind, obsBoatInstruments and
 * CloudTelemetryService live in the chart's chunk, and importing any of them
 * made Rollup hoist the chart's whole import list into this chunk and into
 * the panel's preload list (about 4.6 KB). Hence the readout below is kept
 * here, pinned to closeInWind's by a parity test.
 */
import {
    NmeaStore,
    getNmeaFreshness,
    type NmeaStoreState,
    type RemoteVia,
    type TimestampedMetric,
} from '../../services/NmeaStore';
import {
    boatFixNow,
    followedBoatCloudRowNow,
    followedBoatOwnsInstruments,
    getWeatherFollowCrewOwner,
    getWeatherFollowKey,
    getWeatherFollowTarget,
    type WeatherFix,
    type WeatherFollowTarget,
} from '../../services/weatherPosition';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import {
    DIRECTION_JUDGED_FROM_KTS,
    SPREAD_SOME_KTS,
    SPREAD_SPLIT_DEG,
    SPREAD_SPLIT_KTS,
    circularSpreadDeg,
    parseRouteSpread,
    sampleRouteSpread,
    spreadRetryAfterMs,
    type RouteSpread,
} from '../../services/routeForecastSpread';
import { FORECAST_TTL_MS } from '../../services/routeForecastSampler';
import { fetchOpenMeteoPoints, type OpenMeteoParameters } from '../../services/weather/openMeteoProxy';
import { SELECTABLE_MODELS } from '../../services/weather/forecastModels';
import { AVAILABLE_MODELS } from '../../services/weather/MultiModelWeatherService';
import { vesselAirDraftMetres } from '../../services/units';
import { circularMean } from '../../utils/circularStats';
import { degreesToCardinal } from '../../utils/format';
import { convertSpeed } from '../../utils/units';
import { haversineNM } from '../../utils/gpsFollow';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('ModelCheck');

// ── Constants ───────────────────────────────────────────────────

/** The five global models of the Glass picker, in its order. */
export const MODEL_CHECK_MODELS: readonly string[] = SELECTABLE_MODELS.map((m) => m.id);
/** The Pi sends a TWS sample time only for a sample this fresh. */
export const MODEL_CHECK_LAN_MAX_AGE_MS = 20_000;
/** Her readings are kept this long while the card is open. */
export const SESSION_WINDOW_MS = 10 * 60_000;
/** How often the open card re-reads her wind. */
export const RECHECK_MS = 2_000;
/** How often the open card asks for her cloud row (the chain's own throttle). */
export const CLOUD_LOOKUP_MS = 30_000;
/** Under this span, or under SNAPSHOT_MIN_SAMPLES readings, the session is one snapshot. */
export const SNAPSHOT_MIN_SPAN_MS = 60_000;
export const SNAPSHOT_MIN_SAMPLES = 3;
/** The tie margin: never under a knot; 15 % of her wind for a snapshot, 10 % averaged. */
export const TIE_FLOOR_KT = 1;
export const TIE_FRACTION_SNAPSHOT = 0.15;
export const TIE_FRACTION_AVERAGED = 0.1;
/** Current under her worth a note; current counted into the margin at most. */
export const CURRENT_NOTE_KT = 1;
export const CURRENT_CAP_KT = 3;
/** Under this SOG she is at rest: a marina or an anchorage. */
export const AT_REST_SOG_KT = 0.5;
/** A series is reused this far from where it was asked, and for FORECAST_TTL_MS. */
export const SERIES_REUSE_NM = 10;
export const SERIES_CACHE_MAX = 4;
/** The cloud lane's gate: closeInWind's CLOUD_WIND_MAX_AGE_MS, pinned equal by a test. */
export const HER_CLOUD_MAX_AGE_MS = 60_000;
/** The reach of "the nearest hour" (routeForecastSampler's BEYOND_MS): no further. */
const SERIES_EDGE_MS = 30 * 60_000;
/** A log reading under this while she makes over STW_FOULED_SOG_KT is a fouled paddlewheel, not current. */
const STW_FOULED_KT = 0.3;
const STW_FOULED_SOG_KT = 2;

// ── Her wind ────────────────────────────────────────────────────

export type HerLane = 'gateway' | 'lan' | 'cloud';

export interface HerReading {
    kt: number;
    /** The sample time: the gateway aggregate's arrival, the Pi's own TWS time, or the cloud row's. */
    at: number;
    lane: HerLane;
    /** Wind FROM, degrees true; only on the gateway lane (true heading plus the signed TWA). */
    fromDeg: number | null;
    lat: number;
    lon: number;
    sogKts: number | null;
    /** |SOG − STW|: the water moving under her; null when unknown. */
    currentKts: number | null;
}

export type HerRefusal =
    | { kind: 'phone' }
    | { kind: 'apparent-only' }
    | { kind: 'undated' }
    /** Timed more than a second ahead of this phone's clock: one of the two clocks is wrong. */
    | { kind: 'ahead'; aheadMs: number }
    | { kind: 'stale'; ageMs: number }
    | { kind: 'no-reading' }
    | { kind: 'no-position' };

export type HerAssessment = { ok: true; reading: HerReading } | { ok: false; refusal: HerRefusal };

type StoreMetric =
    | 'tws'
    | 'twd'
    | 'aws'
    | 'twaSigned'
    | 'headingTrue'
    | 'sog'
    | 'stw'
    | 'cog'
    | 'latitude'
    | 'longitude';

/** Everything the assessment reads, gathered at one moment. There is no phone in it. */
export interface HerWindInput {
    follow: WeatherFollowTarget;
    /** The skipper's id while following a crewed boat. */
    crewOwnerId: string | null;
    /** getWeatherFollowKey(): a change starts a new session. */
    followKey: string;
    /** The store's instruments are the followed boat's (boatInstrumentsFollowed). */
    owned: boolean;
    store: Pick<NmeaStoreState, StoreMetric> & { connectionStatus: string; remote: { via: RemoteVia } | null };
    remoteWindSample: { kts: number; at: number; via: RemoteVia } | null;
    /**
     * When the remote feed a gateway socket replaced last delivered
     * (NmeaStore.getRemoteFeedEndedAt); 0 when none. A store metric stamped at
     * or before it is that feed's, re-stamped on receipt, not the socket's.
     */
    remoteFeedEndedAt: number;
    /** Her chain's fix with no hold (boatFixNow): bus, Pi or her cloud row. */
    chainFix: { lat: number; lon: number } | null;
    /** Her own cloud row as the boat chain last read it. */
    cloudRow: Pick<WeatherFix, 'lat' | 'lon' | 'twsKts' | 'windSampleAt' | 'sogKts'> | null;
}

/**
 * Whether the store's instruments are hers on the two lanes read from the
 * store here: the gateway socket and the Pi over the boat LAN. The store's
 * cloud lane is never read (its row may be another boat's), so the owner of
 * its row is not asked for: null, which only ever says no to that lane.
 */
function storeLanesAreHers(store: NmeaStoreState): boolean {
    try {
        return followedBoatOwnsInstruments(store, null);
    } catch {
        return false;
    }
}

/** Read the store, the follow target and her chain, asking no one. */
export function gatherHerWindInput(now: number = Date.now()): HerWindInput {
    const target = getWeatherFollowTarget();
    const crewOwnerId = target === 'crew' ? getWeatherFollowCrewOwner() : null;
    const follow: WeatherFollowTarget = target === 'crew' && !crewOwnerId ? 'phone' : target;
    const store = NmeaStore.getState();
    const followKey = getWeatherFollowKey();
    if (follow === 'phone')
        return {
            follow,
            crewOwnerId: null,
            followKey,
            owned: false,
            store,
            remoteWindSample: null,
            remoteFeedEndedAt: 0,
            chainFix: null,
            cloudRow: null,
        };
    const chain = boatFixNow(now, crewOwnerId, { held: false });
    return {
        follow,
        crewOwnerId,
        followKey,
        owned: storeLanesAreHers(store),
        store,
        remoteWindSample: NmeaStore.getRemoteWindSample(),
        remoteFeedEndedAt: NmeaStore.getRemoteFeedEndedAt(),
        chainFix: chain ? { lat: chain.lat, lon: chain.lon } : null,
        cloudRow: followedBoatCloudRowNow(now),
    };
}

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * A store metric with a value, inside the store's own 13 s by its own clock,
 * and stamped after `after` (the gateway lane: after the remote feed it replaced).
 */
function usable(
    metric: TimestampedMetric | undefined,
    now: number,
    after = 0,
): metric is TimestampedMetric & { value: number } {
    return (
        !!metric &&
        isNum(metric.value) &&
        metric.lastUpdated > after &&
        getNmeaFreshness(metric.lastUpdated, now) !== 'dead'
    );
}

const refuse = (refusal: HerRefusal): HerAssessment => ({ ok: false, refusal });

/** A reading from the store (gateway or LAN): her direction, position, SOG and current. */
function storeReading(
    input: HerWindInput,
    lane: 'gateway' | 'lan',
    kt: number,
    at: number,
    now: number,
): HerAssessment {
    if (!isNum(kt) || kt < 0 || kt > 150) return refuse({ kind: 'no-reading' });
    const s = input.store;
    // On the gateway lane, nothing the replaced remote feed left in the store.
    const after = lane === 'gateway' ? input.remoteFeedEndedAt : 0;
    let fromDeg: number | null = null;
    // The gateway's TWD may be magnetic; only the true heading plus the signed TWA, each on its own clock.
    if (lane === 'gateway' && usable(s.headingTrue, now, after) && usable(s.twaSigned, now, after))
        fromDeg = norm360(s.headingTrue.value + s.twaSigned.value);
    const own = resolveOwnshipPosition(
        { latitude: s.latitude, longitude: s.longitude, sog: s.sog, cog: s.cog },
        { lat: NaN, lon: NaN, source: 'none', timestamp: 0 },
        { now },
    );
    const position = own ?? input.chainFix;
    if (!position || !isNum(position.lat) || !isNum(position.lon)) return refuse({ kind: 'no-position' });
    const sog = usable(s.sog, now, after) && s.sog.value >= 0 ? s.sog.value : null;
    const stw = usable(s.stw, now, after) && s.stw.value >= 0 ? s.stw.value : null;
    const fouledLog = stw !== null && sog !== null && stw < STW_FOULED_KT && sog > STW_FOULED_SOG_KT;
    const currentKts = sog !== null && stw !== null && !fouledLog ? Math.abs(sog - stw) : null;
    return {
        ok: true,
        reading: { kt, at, lane, fromDeg, lat: position.lat, lon: position.lon, sogKts: sog, currentKts },
    };
}

/**
 * Her true wind now, or why not. The first lane whose store holds wind
 * decides, even when what it decides is a refusal.
 */
export function assessHerWind(input: HerWindInput, now: number): HerAssessment {
    if (input.follow === 'phone' || (input.follow === 'crew' && !input.crewOwnerId)) return refuse({ kind: 'phone' });
    const s = input.store;

    // 1. The gateway socket: the boat's own bus, dated by the 5 s aggregate's arrival.
    //    The store keeps a replaced remote feed's values for their 13 s, stamped
    //    on receipt and perhaps never dated by the Pi: those are not the socket's.
    if (input.owned && s.connectionStatus === 'connected') {
        const after = input.remoteFeedEndedAt;
        if (usable(s.tws, now, after)) return storeReading(input, 'gateway', s.tws.value, s.tws.lastUpdated, now);
        if (usable(s.aws, now, after)) return refuse({ kind: 'apparent-only' });
        if (s.tws.lastUpdated > after) return refuse({ kind: 'stale', ageMs: Math.max(0, now - s.tws.lastUpdated) });
    }

    // 2. The Pi over the boat LAN: only a TWS the Pi itself dated.
    if (input.owned && s.remote?.via === 'lan') {
        if (usable(s.tws, now)) {
            const sample = input.remoteWindSample;
            if (sample && sample.via === 'lan' && sample.kts === s.tws.value) {
                const age = now - sample.at;
                if (age < -1_000) return refuse({ kind: 'ahead', aheadMs: -age });
                if (age > MODEL_CHECK_LAN_MAX_AGE_MS) return refuse({ kind: 'stale', ageMs: age });
                return storeReading(input, 'lan', sample.kts, sample.at, now);
            }
            return refuse({ kind: 'undated' });
        }
        if (usable(s.aws, now)) return refuse({ kind: 'apparent-only' });
        if (s.tws.lastUpdated > 0) return refuse({ kind: 'stale', ageMs: Math.max(0, now - s.tws.lastUpdated) });
    }

    // 3. Her own cloud row through the boat chain, at the row's own position.
    const row = input.cloudRow;
    if (!row || !isNum(row.twsKts) || row.twsKts < 0 || row.twsKts > 150) return refuse({ kind: 'no-reading' });
    if (!isNum(row.windSampleAt) || row.windSampleAt <= 0) return refuse({ kind: 'undated' });
    const age = now - row.windSampleAt;
    // A sample time from the future cannot be placed against the forecast hours.
    if (age < -1_000) return refuse({ kind: 'ahead', aheadMs: -age });
    if (age > HER_CLOUD_MAX_AGE_MS) return refuse({ kind: 'stale', ageMs: age });
    if (!isNum(row.lat) || !isNum(row.lon)) return refuse({ kind: 'no-position' });
    return {
        ok: true,
        reading: {
            kt: row.twsKts,
            at: row.windSampleAt,
            lane: 'cloud',
            fromDeg: null,
            lat: row.lat,
            lon: row.lon,
            sogKts: isNum(row.sogKts) && row.sogKts >= 0 ? row.sogKts : null,
            currentKts: null,
        },
    };
}

// ── The session ─────────────────────────────────────────────────

export interface HerSession {
    followKey: string | null;
    lane: HerLane | null;
    /** Oldest first, each with a newer sample time than the last. */
    readings: readonly HerReading[];
}

export const EMPTY_SESSION: HerSession = Object.freeze({ followKey: null, lane: null, readings: [] });

/**
 * Add a reading that carries a new sample time. A lane change or a new
 * follow key starts again; anything older than SESSION_WINDOW_MS goes.
 * Returns `prev` itself when nothing changes, so React can bail out.
 */
export function addHerReading(prev: HerSession, reading: HerReading, followKey: string, now: number): HerSession {
    const sameRun = prev.followKey === followKey && prev.lane === reading.lane;
    const kept = sameRun ? prev.readings.filter((r) => r.at >= now - SESSION_WINDOW_MS) : [];
    const newest = kept[kept.length - 1];
    if (newest && reading.at <= newest.at)
        return sameRun && kept.length === prev.readings.length ? prev : { ...prev, readings: kept };
    return { followKey, lane: reading.lane, readings: [...kept, reading] };
}

export interface HerSummary {
    n: number;
    spanMs: number;
    mode: 'snapshot' | 'averaged';
    /** W̄: the arithmetic mean of her speeds. */
    meanKt: number;
    /** Her direction, gateway lane only, when at least half the samples carry one. */
    fromDeg: number | null;
    /** C: the median current under her when at least half the samples carry it, capped. */
    currentKts: number | null;
    lane: HerLane;
    newest: HerReading;
}

export function summarizeHerSession(session: HerSession): HerSummary | null {
    const readings = session.readings;
    const n = readings.length;
    if (n === 0) return null;
    const newest = readings[n - 1];
    const spanMs = newest.at - readings[0].at;
    const mode = n < SNAPSHOT_MIN_SAMPLES || spanMs < SNAPSHOT_MIN_SPAN_MS ? 'snapshot' : 'averaged';
    const meanKt = readings.reduce((sum, r) => sum + r.kt, 0) / n;
    const lane = newest.lane;
    const bearings = readings.flatMap((r) => (r.fromDeg === null ? [] : [r.fromDeg]));
    const fromDeg = lane === 'gateway' && bearings.length >= Math.ceil(n / 2) ? circularMean(bearings) : null;
    const currents = readings
        .flatMap((r) => (r.currentKts === null || !isNum(r.currentKts) ? [] : [r.currentKts]))
        .sort((a, b) => a - b);
    let currentKts: number | null = null;
    if (currents.length > 0 && currents.length * 2 >= n) {
        const mid = currents.length >> 1;
        const median = currents.length % 2 ? currents[mid] : (currents[mid - 1] + currents[mid]) / 2;
        currentKts = Math.min(CURRENT_CAP_KT, median);
    }
    return { n, spanMs, mode, meanKt, fromDeg, currentKts, lane, newest };
}

// ── Ranking ─────────────────────────────────────────────────────

export interface RankedModelRow {
    id: string;
    label: string;
    provider: string;
    /** ranked: a speed at every sample; direction-off: judged and 45° or more off her; no-wind: neither. */
    status: 'ranked' | 'direction-off' | 'no-wind';
    meanKt: number | null;
    fromDeg: number | null;
    /** F̄ − W̄, knots: positive over her wind. */
    gapKt: number | null;
    /** The arc between her direction and the model's, when judged. */
    offDeg: number | null;
    judged: boolean;
    marked: boolean;
}

export type ModelVerdict =
    | { kind: 'closest'; id: string; judged: boolean }
    | { kind: 'too-close'; ids: string[] }
    | { kind: 'none-close' }
    | { kind: 'none-direction' }
    | { kind: 'only'; id: string };

export type ModelRanking =
    | { state: 'no-models' }
    | {
          state: 'ranked';
          rows: RankedModelRow[];
          verdict: ModelVerdict;
          /** M: the gap within which models are too close to call. */
          marginKt: number;
          summary: HerSummary;
          /** Every model with any wind here, in picker order: who the credit names. */
          answered: string[];
      };

const MODEL_INFO = new Map(SELECTABLE_MODELS.map((m) => [m.id as string, m]));
const EPS = 1e-9;

/** Each model at each of her sample times, averaged, then ranked closest first by speed. */
export function rankModelsAtHer(session: HerSession, spread: RouteSpread | null): ModelRanking {
    const summary = summarizeHerSession(session);
    if (!summary || !spread) return { state: 'no-models' };
    const answered = MODEL_CHECK_MODELS.filter((id) => spread.members[id]);
    if (answered.length === 0) return { state: 'no-models' };

    const speeds = new Map<string, number[]>(MODEL_CHECK_MODELS.map((id) => [id, []]));
    const bearings = new Map<string, number[]>(MODEL_CHECK_MODELS.map((id) => [id, []]));
    for (const reading of session.readings) {
        for (const member of sampleRouteSpread(spread, 0, reading.at).members) {
            speeds.get(member.model)?.push(member.twsKts);
            if (member.twdDeg !== null) bearings.get(member.model)?.push(member.twdDeg);
        }
    }

    const W = summary.meanKt;
    const herDir = summary.lane === 'gateway' ? summary.fromDeg : null;
    const rows: RankedModelRow[] = MODEL_CHECK_MODELS.map((id) => {
        const info = MODEL_INFO.get(id);
        const base = { id, label: info?.label ?? id, provider: info?.provider ?? '', marked: false };
        const s = speeds.get(id)!;
        if (s.length !== summary.n)
            return {
                ...base,
                status: 'no-wind',
                meanKt: null,
                fromDeg: null,
                gapKt: null,
                offDeg: null,
                judged: false,
            };
        const meanKt = s.reduce((sum, v) => sum + v, 0) / s.length;
        const fromDeg = circularMean(bearings.get(id)!);
        const judged =
            herDir !== null &&
            fromDeg !== null &&
            W >= DIRECTION_JUDGED_FROM_KTS &&
            meanKt >= DIRECTION_JUDGED_FROM_KTS;
        const offDeg = judged ? circularSpreadDeg([herDir, fromDeg]) : null;
        const off = offDeg !== null && offDeg >= SPREAD_SPLIT_DEG;
        return {
            ...base,
            status: off ? 'direction-off' : 'ranked',
            meanKt,
            fromDeg,
            gapKt: meanKt - W,
            offDeg,
            judged,
        };
    });

    const byGap = (a: RankedModelRow, b: RankedModelRow) => {
        const d = Math.abs(a.gapKt!) - Math.abs(b.gapKt!);
        return Math.abs(d) < EPS ? 0 : d;
    };
    // Array.prototype.sort is stable: ties keep the picker order.
    const E = rows.filter((r) => r.status === 'ranked').sort(byGap);
    const off = rows.filter((r) => r.status === 'direction-off').sort(byGap);
    const none = rows.filter((r) => r.status === 'no-wind');
    // Nobody had wind at every one of her minutes: nothing honest to rank.
    if (E.length + off.length === 0) return { state: 'no-models' };

    const fraction = summary.mode === 'snapshot' ? TIE_FRACTION_SNAPSHOT : TIE_FRACTION_AVERAGED;
    const marginKt = Math.max(TIE_FLOOR_KT, fraction * W) + (summary.currentKts ?? 0);

    let verdict: ModelVerdict;
    // "Only" counts the models with a number at her minutes, not any wind anywhere in
    // the hours: a lone number is not "closest" against rows that say "no wind here".
    if (E.length + off.length === 1) verdict = { kind: 'only', id: (E[0] ?? off[0]).id };
    else if (E.length === 0) verdict = { kind: 'none-direction' };
    else {
        const best = Math.abs(E[0].gapKt!);
        if (best >= SPREAD_SPLIT_KTS - EPS) verdict = { kind: 'none-close' };
        else {
            const group = E.filter((r) => Math.abs(r.gapKt!) <= best + marginKt + EPS);
            for (const r of group) r.marked = true;
            verdict =
                group.length >= 2
                    ? { kind: 'too-close', ids: group.map((r) => r.id) }
                    : { kind: 'closest', id: group[0].id, judged: group[0].judged };
        }
    }
    return { state: 'ranked', rows: [...E, ...off, ...none], verdict, marginKt, summary, answered };
}

// ── The request and the series ──────────────────────────────────

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The one request: both wind variables for the five global models at her
 * point (fetchOpenMeteoPoints adds the coordinates), an hour and five minutes
 * either side of now in UTC days. Every key and value is in the proxy's
 * vocabulary (supabase/functions/proxy-openmeteo), pinned by a contract test:
 * a refused request still spends a quota unit. Two variables for five models
 * is ten pairs; gusts are never added here.
 */
export function buildModelCheckParams(_lat: number, _lon: number, now: number): OpenMeteoParameters {
    return {
        hourly: 'wind_speed_10m,wind_direction_10m',
        models: MODEL_CHECK_MODELS.join(','),
        wind_speed_unit: 'kn',
        timeformat: 'unixtime',
        timezone: 'UTC',
        // Deliberate: the check is against the wind over the WATER at her, so
        // the nearest sea cell. Every other weather call uses the default
        // (land), so near a coast this ECMWF number can differ from the chart
        // chip's by a knot or two.
        cell_selection: 'sea',
        start_date: utcDate(now - 65 * 60_000),
        end_date: utcDate(now + 65 * 60_000),
    };
}

export type ModelSeriesState =
    | { state: 'ready'; spread: RouteSpread }
    | { state: 'loading' }
    | { state: 'offline' }
    | { state: 'failed'; retryInMs: number }
    | { state: 'rate-limited'; retryInMs: number }
    | { state: 'no-models' };

interface SeriesEntry {
    lat: number;
    lon: number;
    spread: RouteSpread | null;
    /** The service answered, and no model had wind here: held like a series. */
    noModels: boolean;
    fetchedAt: number;
    failures: number;
    failedAt: number;
    rateLimited: boolean;
    inflight: Promise<ModelSeriesState> | null;
}
const seriesCache = new Map<string, SeriesEntry>();

const nearHer = (entry: SeriesEntry, lat: number, lon: number): boolean =>
    haversineNM(entry.lat, entry.lon, lat, lon) <= SERIES_REUSE_NM;

/** The forecast hours of a series (every member shares the one reply's axis). */
function seriesAxis(spread: RouteSpread): number[] {
    for (const member of Object.values(spread.members)) {
        const times = member.stations[0]?.timesMs;
        if (times?.length) return times;
    }
    return [];
}

/** Whether the series was asked for within SERIES_REUSE_NM of this position. */
export function seriesNear(spread: RouteSpread, lat: number, lon: number): boolean {
    const station = Object.values(spread.members)[0]?.stations[0];
    return !!station && haversineNM(station.lat, station.lon, lat, lon) <= SERIES_REUSE_NM;
}

/** Whether `atMs` lies within half an hour of the series' hours. */
export function seriesCovers(spread: RouteSpread, atMs: number): boolean {
    const axis = seriesAxis(spread);
    return axis.length > 0 && atMs >= axis[0] - SERIES_EDGE_MS && atMs <= axis[axis.length - 1] + SERIES_EDGE_MS;
}

function reusable(entry: SeriesEntry, lat: number, lon: number, now: number): ModelSeriesState | null {
    if (entry.fetchedAt <= 0 || now - entry.fetchedAt > FORECAST_TTL_MS || !nearHer(entry, lat, lon)) return null;
    if (entry.noModels) return { state: 'no-models' };
    // A series whose last hour no longer reaches now (fetched just before a UTC day turned) is not reused.
    return entry.spread && seriesCovers(entry.spread, now) ? { state: 'ready', spread: entry.spread } : null;
}

/** What the cache can say for her position without a request; null when one is needed. */
export function peekModelsAtHer(lat: number, lon: number, now: number = Date.now()): ModelSeriesState | null {
    const entries = [...seriesCache.values()];
    for (const entry of entries) {
        const hit = reusable(entry, lat, lon, now);
        if (hit) return hit;
    }
    if (entries.some((entry) => entry.inflight && nearHer(entry, lat, lon))) return { state: 'loading' };
    for (const entry of entries) {
        if (entry.failures === 0 || !nearHer(entry, lat, lon)) continue;
        const retryInMs = spreadRetryAfterMs(entry.failures) - (now - entry.failedAt);
        if (retryInMs > 0) return { state: entry.rateLimited ? 'rate-limited' : 'failed', retryInMs };
    }
    return null;
}

function evictSeries(): void {
    for (const [key, entry] of seriesCache) {
        if (seriesCache.size <= SERIES_CACHE_MAX) return;
        if (!entry.inflight) seriesCache.delete(key);
    }
}

/**
 * The five models at her position, asking at most once per 10 NM and hour.
 * Never rejects. Concurrent calls share one request; after a failure the
 * proxy is left alone for spreadRetryAfterMs; offline with nothing held, no
 * request at all.
 */
export async function loadModelsAtHer(lat: number, lon: number, now: number = Date.now()): Promise<ModelSeriesState> {
    const held = peekModelsAtHer(lat, lon, now);
    if (held && held.state !== 'loading') return held;
    const pending = [...seriesCache.values()].find((entry) => entry.inflight && nearHer(entry, lat, lon));
    if (pending?.inflight) return pending.inflight;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { state: 'offline' };

    const params = buildModelCheckParams(lat, lon, now);
    const key = `${Math.round(lat * 10)}:${Math.round(lon * 10)}:${params.start_date}:${params.end_date}`;
    let entry = seriesCache.get(key);
    if (!entry) {
        // A move into the next cell keeps the back-off it was under.
        const failures = Math.max(
            0,
            ...[...seriesCache.values()].filter((e) => nearHer(e, lat, lon)).map((e) => e.failures),
        );
        entry = {
            lat,
            lon,
            spread: null,
            noModels: false,
            fetchedAt: 0,
            failures,
            failedAt: 0,
            rateLimited: false,
            inflight: null,
        };
        seriesCache.set(key, entry);
        evictSeries();
    }
    entry.lat = lat;
    entry.lon = lon;
    const mine = entry;
    const request = (async (): Promise<ModelSeriesState> => {
        try {
            const replies = await fetchOpenMeteoPoints<{ hourly?: Record<string, unknown> }>(
                'forecast',
                [{ lat, lon }],
                params,
            );
            let result: ModelSeriesState;
            try {
                // Suffixed keys only, values counted, never keys: a model that is
                // not there answers 200 with nulls.
                const spread = parseRouteSpread([{ alongNm: 0, lat, lon }], replies, MODEL_CHECK_MODELS, 0, now);
                mine.spread = spread;
                mine.noModels = false;
                result = { state: 'ready', spread };
                if (spread.missing.length > 0) log.warn(`model check: no wind from ${spread.missing.join(', ')}`);
            } catch {
                mine.spread = null;
                mine.noModels = true;
                result = { state: 'no-models' };
                log.warn('model check: no model has wind at her position');
            }
            mine.fetchedAt = now;
            mine.failures = 0;
            mine.failedAt = 0;
            mine.rateLimited = false;
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            mine.failures += 1;
            mine.failedAt = now;
            mine.rateLimited = message.includes('(429)');
            log.warn(`model check failed: ${message}`);
            return {
                state: mine.rateLimited ? 'rate-limited' : 'failed',
                retryInMs: spreadRetryAfterMs(mine.failures),
            };
        } finally {
            mine.inflight = null;
        }
    })();
    mine.inflight = request;
    return request;
}

/** Test seam. */
export function __clearModelCheckCacheForTests(): void {
    seriesCache.clear();
}

// ── The words ───────────────────────────────────────────────────

/** The app's speed units as the chart's readout labels them (closeInWind, pinned by a parity test). */
const SPEED_LABEL: Record<string, string> = { kts: 'kt', mph: 'mph', kmh: 'km/h', mps: 'm/s' };
const CALM_KT = 1;

/** Her wind in her speed unit with the 16-point compass point it blows from, or Calm under a knot: closeInWind's readout. */
export function formatHerWind(wind: { kt: number; fromDeg: number | null }, speedUnit: string | undefined): string {
    if (!Number.isFinite(wind.kt) || wind.kt < CALM_KT) return 'Calm';
    // An unknown unit reads in knots: convertSpeed's default, and the knot's label.
    const unit = speedUnit && SPEED_LABEL[speedUnit] ? speedUnit : '';
    const converted = convertSpeed(wind.kt, unit) ?? wind.kt;
    const value = unit === 'mps' && converted < 10 ? converted.toFixed(1) : String(Math.round(converted));
    const point = wind.fromDeg === null ? '' : ` ${degreesToCardinal(norm360(wind.fromDeg))}`;
    const label = SPEED_LABEL[unit] ?? SPEED_LABEL.kts;
    return `${value} ${label}${point}`;
}

/** "{v} over" / "{v} under" / "same", in her speed unit; the long form for screen readers. */
export function formatWindGap(gapKt: number, speedUnit: string | undefined): { short: string; long: string } {
    const unit = speedUnit && SPEED_LABEL[speedUnit] ? speedUnit : '';
    const label = SPEED_LABEL[unit] ?? SPEED_LABEL.kts;
    const converted = convertSpeed(Math.abs(gapKt), unit) ?? Math.abs(gapKt);
    const tenths = unit === 'mps' && converted < 10;
    const shown = tenths ? Math.round(converted * 10) / 10 : Math.round(converted);
    if (shown === 0) return { short: 'same', long: 'the same as her wind' };
    const value = tenths ? shown.toFixed(1) : String(shown);
    const side = gapKt > 0 ? 'over' : 'under';
    return { short: `${value} ${side}`, long: `${value} ${label} ${side} her wind` };
}

/**
 * The CC-BY-4.0 credit for the models with any wind here: who answered, in
 * picker order, each provider once; null when nobody did. Not
 * MODEL_ATTRIBUTION_LINE, which names providers that supplied nothing here.
 */
export function creditLine(answered: readonly string[]): string | null {
    const providers = [
        ...new Set(SELECTABLE_MODELS.filter((m) => answered.includes(m.id)).map((m) => m.provider.trim())),
    ].filter(Boolean);
    return providers.length ? `Forecast data: ${providers.join(', ')} (CC-BY-4.0) via Open-Meteo` : null;
}

/** ⓘ: how the check works, in five plain paragraphs, the direction threshold in her speed unit. */
export function modelCheckDetails(speedUnit?: string): string[] {
    const from = formatHerWind({ kt: DIRECTION_JUDGED_FROM_KTS, fromDeg: null }, speedUnit);
    return [
        "Her true wind is read while this is open and set against each model's forecast for the same minutes, where she is.",
        'Models give wind 10 m above the sea, averaged over a grid square. Her anemometer is one spot, up her mast.',
        'Her instruments measure wind over the water; the models, over the ground. Tide and current shift it.',
        "Each model's latest run is used, so a newer run has an edge. A few minutes in one place says little about tomorrow.",
        `Only the five global models are checked. Direction is compared from ${from}, and only on a direct instrument link.`,
    ];
}
export const MODEL_CHECK_DETAILS: readonly string[] = modelCheckDetails();

const ONE_READING = 'One reading is a snapshot, not a verdict.';
const LANE_SOURCE: Record<HerLane, string> = {
    gateway: 'Boat instruments',
    lan: 'Boat instruments via the Pi',
    cloud: 'Her Pi, online',
};

function ageText(ms: number): string {
    const seconds = Math.max(0, ms) / 1000;
    return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

function refusalLines(refusal: HerRefusal): { line1: string; line2: string } {
    switch (refusal.kind) {
        case 'phone':
            return {
                line1: 'Current Location is following this phone, not a boat.',
                line2: 'Set it to your boat to compare her wind with the models.',
            };
        case 'no-reading':
            return {
                line1: 'No wind reading from her right now, so there is nothing to compare.',
                line2: 'Aboard, her Pi or wind gateway has to reach this phone. Ashore, her Pi has to be online.',
            };
        case 'stale':
            return {
                line1: `Her last wind reading is ${ageText(refusal.ageMs)} old.`,
                line2: 'Nothing is ranked until a fresh one comes in.',
            };
        case 'undated':
            return {
                line1: 'Her Pi sent a wind reading with no time on it.',
                line2: 'It may be an old value from instruments that are off, so nothing is ranked.',
            };
        case 'ahead':
            return {
                line1: `Her wind reading is stamped ${ageText(refusal.aheadMs)} ahead of this phone's clock.`,
                line2: 'One of the two clocks is wrong, so nothing is ranked.',
            };
        case 'apparent-only':
            return {
                line1: 'She is sending apparent wind only.',
                line2: 'The models forecast true wind, so nothing is ranked.',
            };
        case 'no-position':
            return {
                line1: 'We have her wind but not her position.',
                line2: "The models can't be looked up without it.",
            };
    }
}

const minutesText = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

function seriesLines(series: ModelSeriesState | null): { line1: string; line2: string | null } | null {
    if (!series || series.state === 'loading') return { line1: 'Getting the models at her position…', line2: null };
    switch (series.state) {
        case 'offline':
            return { line1: "This phone is offline, so the models can't be looked up.", line2: null };
        case 'failed':
            return {
                line1: "Couldn't reach the forecast service.",
                line2: `Trying again in ${minutesText(series.retryInMs)} min.`,
            };
        case 'rate-limited':
            return {
                line1: 'Forecast requests are paused for now.',
                line2: `Too many from this connection. Trying again in ${minutesText(series.retryInMs)} min.`,
            };
        case 'no-models':
            return { line1: 'No model has wind for her position this hour.', line2: null };
        case 'ready':
            return null;
    }
}

const listNames = (names: string[]): string =>
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function verdictText(verdict: ModelVerdict): string {
    const label = (id: string) => MODEL_INFO.get(id)?.label ?? id;
    switch (verdict.kind) {
        case 'closest':
            return `${verdict.judged ? 'Closest right now' : 'Closest on speed'}: ${label(verdict.id)}`;
        case 'too-close':
            return `Too close to call: ${listNames(verdict.ids.map(label))}`;
        case 'none-close':
            return 'None is close to her right now';
        case 'none-direction':
            return 'None has her wind direction now';
        case 'only':
            return `Only ${label(verdict.id)} has wind here now`;
    }
}

function heightNote(
    follow: WeatherFollowTarget,
    lengthUnit: string | undefined,
    airDraftFt: number | undefined,
): string {
    const airDraftM = follow === 'boat' ? vesselAirDraftMetres({ airDraft: airDraftFt }) : null;
    if (airDraftM === null) return 'Models are for 10 m up. A masthead anemometer usually reads a little more.';
    if (airDraftM <= 10) return 'Models are for 10 m up. Her anemometer is lower, so she may read a little less.';
    const mast = lengthUnit === 'ft' ? `${Math.round(airDraftFt!)} ft` : `${Math.round(airDraftM)} m`;
    return `Models are for 10 m up. Her mast is up to ${mast}, so she may read a little more.`;
}

export interface ModelCheckRowView {
    id: string;
    label: string;
    /** The model the chart's wind field is drawn from. */
    onChart: boolean;
    mark: 'closest' | 'too-close' | null;
    forecast: string;
    /** Short, visible (aria-hidden); `gapLong` is what a screen reader hears. */
    gap: string;
    gapLong: string;
    /** Never the only signal: the gap text says the same. */
    tone: 'emerald' | 'amber' | 'rose' | null;
}

export interface ModelCheckView {
    caveat: string;
    /** A refusal of her wind, or a model-side state, in place of the ranking. */
    status: { line1: string; line2: string | null } | null;
    her: { value: string; source: string } | null;
    verdict: string | null;
    rows: ModelCheckRowView[];
    notes: string[];
    /** Only while rows are on screen; never empty when it is. */
    credit: string | null;
}

export interface ModelCheckViewInput {
    /** Null before the first re-check. */
    assessment: HerAssessment | null;
    session: HerSession;
    series: ModelSeriesState | null;
    follow: WeatherFollowTarget;
    speedUnit?: string;
    lengthUnit?: string;
    /** settings.vessel.airDraft, stored in feet. */
    airDraftFt?: number;
    /** The chart's WindStore model id ('icon', 'ecmwf', …). */
    chartModel?: string;
}

const toneOf = (gapKt: number): ModelCheckRowView['tone'] =>
    Math.abs(gapKt) < SPREAD_SOME_KTS ? 'emerald' : Math.abs(gapKt) < SPREAD_SPLIT_KTS ? 'amber' : 'rose';

/** Every string the card shows, for one moment. Pure. */
export function buildModelCheckView(input: ModelCheckViewInput): ModelCheckView {
    const empty: ModelCheckView = {
        caveat: ONE_READING,
        status: null,
        her: null,
        verdict: null,
        rows: [],
        notes: [],
        credit: null,
    };
    const { assessment, speedUnit } = input;
    if (!assessment) return empty;
    if (!assessment.ok) return { ...empty, status: refusalLines(assessment.refusal) };

    const session: HerSession = input.session.readings.length
        ? input.session
        : { followKey: null, lane: assessment.reading.lane, readings: [assessment.reading] };
    const summary = summarizeHerSession(session)!;
    const time = new Date(summary.newest.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const minutes = Math.max(1, Math.round(summary.spanMs / 60_000));
    const averaged = summary.mode === 'averaged';
    const her = {
        value: formatHerWind({ kt: summary.meanKt, fromDeg: summary.fromDeg }, speedUnit),
        source: `${LANE_SOURCE[summary.lane]} · ${averaged ? `${minutes}-min average to ${time}` : time}`,
    };
    const withHer = { ...empty, her };

    const waiting = seriesLines(input.series);
    if (waiting || input.series?.state !== 'ready') return { ...withHer, status: waiting };
    // A reply asked for somewhere else (a request still out when the follow moved
    // on): never ranked against her. Her own is on its way.
    if (!seriesNear(input.series.spread, summary.newest.lat, summary.newest.lon))
        return { ...withHer, status: seriesLines({ state: 'loading' }) };
    if (!seriesCovers(input.series.spread, summary.newest.at))
        return {
            ...withHer,
            status: { line1: "The forecast hours don't cover her reading's time.", line2: "Check this phone's clock." },
        };
    const ranking = rankModelsAtHer(session, input.series.spread);
    if (ranking.state !== 'ranked') return { ...withHer, status: seriesLines({ state: 'no-models' }) };

    const chartId = AVAILABLE_MODELS.find((m) => m.id === input.chartModel)?.openMeteoModel ?? null;
    const tooClose = ranking.verdict.kind === 'too-close';
    const rows: ModelCheckRowView[] = ranking.rows.map((row) => {
        const base = {
            id: row.id,
            label: row.label,
            onChart: row.id === chartId,
            mark: row.marked ? (tooClose ? ('too-close' as const) : ('closest' as const)) : null,
        };
        if (row.status === 'no-wind')
            return { ...base, forecast: '—', gap: 'no wind here', gapLong: 'no wind here from this model', tone: null };
        const forecast = formatHerWind({ kt: row.meanKt!, fromDeg: row.fromDeg }, speedUnit);
        if (row.status === 'direction-off') {
            const deg = Math.round(row.offDeg!);
            return {
                ...base,
                forecast,
                gap: `${deg}° off`,
                gapLong: `${deg}° off her wind's direction`,
                tone: 'amber',
            };
        }
        const gap = formatWindGap(row.gapKt!, speedUnit);
        return { ...base, forecast, gap: gap.short, gapLong: gap.long, tone: toneOf(row.gapKt!) };
    });

    const notes = [heightNote(input.follow, input.lengthUnit, input.airDraftFt)];
    const C = summary.currentKts;
    if (C !== null && C >= CURRENT_NOTE_KT) {
        const current = formatHerWind({ kt: C, fromDeg: null }, speedUnit);
        notes.push(`About ${current} of tide or current under her shifts her wind against the models.`);
    } else if (summary.newest.sogKts !== null && summary.newest.sogKts < AT_REST_SOG_KT)
        notes.push("She isn't moving. In a marina or sheltered anchorage, land, buildings and masts can cut her wind.");

    return {
        caveat: averaged ? `${minutes} min of her wind is a snapshot, not a verdict.` : ONE_READING,
        status: null,
        her,
        verdict: verdictText(ranking.verdict),
        rows,
        notes,
        credit: creditLine(ranking.answered),
    };
}
