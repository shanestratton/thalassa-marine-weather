/**
 * todayLoader — Plan Your Day's I/O (build 124, "Today on the water").
 *
 * The engine (today.ts, places.ts, mirror.ts) is pure; everything it reads
 * is fetched here, and nowhere else. Three calls, in the order the sheet
 * makes them:
 *
 *   1. loadToday(start): the place. Its zone and light are worked out on the
 *      phone and reported at once; then, as each answers, the seven-model
 *      point block (2 proxy calls, memoised per 0.1° cell and shared with the
 *      Glass), the places (OpenStreetMap reference cells worldwide, the
 *      Queensland atlas, the OSM coastline for land-only shelter, the
 *      skipper's saved routes), WorldTides for the facts line, and the
 *      nearest tropical cyclone. The offline atlas's places are reported as
 *      soon as it answers (placesStatus still 'loading'), and merged again
 *      with OpenStreetMap and the coastline when those land.
 *   2. loadStopLegs(needsLegs): for the stops the engine names (at most
 *      three), ONE route spread (the passage HUD's five models, so the two
 *      share a cache) and ONE sea request along the one-way leg. The home
 *      leg is that leg turned round (mirror.ts), never a second request: a
 *      round trip under 20 NM would sample the start twice and never the stop.
 *   3. loadLandingWindow(stop): only when a reviewed stop's detail opens.
 *
 * FENCES. Every await is bounded by a wall-clock deadline (AbortSignal is a
 * no-op under the native HTTP patch, utils/deadline.ts), and checked against
 * the sheet's AbortSignal and the account it began under: when the sheet
 * closes or the account changes, the call rejects with an AbortError and
 * nothing more is reported, even if a request answers late.
 *
 * HONEST GAPS. A source that fails says so: the forecast reads "failed" (or
 * "offline" when the phone is), places that could not be read at all are
 * null rather than an empty list ("no anchorages mapped" would be false),
 * and a tide station that does not answer is "none". Nothing is invented to
 * fill a gap, and nothing here ever expires a plan.
 */
import { AnchorageService } from '../anchorages/AnchorageService';
import { loadReferenceTile as loadReferenceCell, type ReferenceResult } from '../anchorages/CruisingReferenceService';
import type { ReferenceTile } from '../anchorages/cruisingReference';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { FORECAST_TTL_MS, loadRouteForecast, type RouteForecast } from '../routeForecastSampler';
import { loadRouteSpread, type RouteSpread } from '../routeForecastSpread';
import { loadRouteSea, type RouteSea } from '../routeSeaSampler';
import { loadSavedTraces } from '../routeTracer';
import { fetchTideCurve, type TideCurve } from '../TideHeightService';
import { fetchActiveCyclones, type ActiveCyclone } from '../weather/CycloneTrackingService';
import {
    queryModelSpread,
    type AtmosVar,
    type ModelSpreadResult,
    type SpreadBlock,
} from '../weather/ModelSpreadService';
import { fetchTidesForPosition, type TidesForPosition } from '../weather/api/tides';
import { fetchCoastlineSegments } from '../weather/shelter/coastlineSource';
import type { Segment } from '../weather/shelter/shelterGeometry';
import type { Tide } from '../../types/weather';
import { withDeadline } from '../../utils/deadline';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import { officialWarningsSource } from '../../utils/officialWarningsSource';
import { resolveTimeZone } from '../../utils/timezone';
import {
    dayPlanTiles,
    gatherPlaces,
    marinaNear,
    nameStart,
    reachRadiusNm,
    type AtlasFeature,
    type GatheredPlaces,
    type LatLon,
    type NamedPoint,
    type SavedRouteLike,
} from './places';
import {
    CYCLONE_NOTICE_NM,
    chipDates,
    dayWindow,
    landingWindows,
    pickHeadlineMember,
    wallTime,
    addDays,
    type CycloneNotice,
    type DayPlanInput,
    type DayWindow,
    type PlacesStatus,
    type StopLegs,
} from './today';

/** The most any one source of the place is waited for. */
export const PART_DEADLINE_MS = 30_000;
/** The most a stop's route wind or sea is waited for. */
export const LEG_DEADLINE_MS = 45_000;

// ── Sources ────────────────────────────────────────────────────

/** Everything the loader reads, as functions: the defaults below, or fakes in tests. */
export interface TodayLoaderDeps {
    now(): number;
    /** False only when the phone says it has no network. */
    online(): boolean;
    querySpread(lat: number, lon: number): Promise<ModelSpreadResult>;
    loadAtlas(lat: number, lon: number, radiusNm: number): Promise<readonly AtlasFeature[]>;
    loadReferenceTile(tile: ReferenceTile, signal: AbortSignal): Promise<ReferenceResult>;
    loadCoastline(lat: number, lon: number): Promise<Segment[] | null>;
    savedRoutes(scope: AuthIdentityScope): SavedRouteLike[];
    loadTides(lat: number, lon: number): Promise<TidesForPosition | null>;
    loadCyclones(): Promise<ActiveCyclone[]>;
    loadRouteSpread(coords: readonly LatLon[], models: readonly string[]): Promise<RouteSpread | null>;
    loadRouteForecast(coords: readonly LatLon[], model: string): Promise<RouteForecast | null>;
    loadRouteSea(coords: readonly LatLon[]): Promise<RouteSea | null>;
    loadTideCurve(lat: number, lon: number, fromMs: number, toMs: number): Promise<TideCurve | null>;
}

export const TODAY_LOADER_DEPS: TodayLoaderDeps = {
    now: () => Date.now(),
    online: () => !(typeof navigator !== 'undefined' && navigator.onLine === false),
    querySpread: (lat, lon) => queryModelSpread(lat, lon),
    loadAtlas: async (lat, lon, radiusNm) =>
        (await AnchorageService.loadNear(lat, lon, radiusNm)).points.features as AtlasFeature[],
    // Points that report a restriction must say so: older caches that dropped
    // the tags are refetched rather than trusted.
    loadReferenceTile: (tile, signal) => loadReferenceCell(tile, signal, { requireRestrictionMetadata: true }),
    loadCoastline: (lat, lon) => fetchCoastlineSegments(lat, lon),
    savedRoutes: (scope) => loadSavedTraces(scope).map((trace) => ({ name: trace.name, points: trace.points })),
    loadTides: (lat, lon) => fetchTidesForPosition(lat, lon),
    loadCyclones: () => fetchActiveCyclones(),
    loadRouteSpread: (coords, models) => loadRouteSpread(coords, models),
    loadRouteForecast: (coords, model) => loadRouteForecast(coords, model),
    loadRouteSea: (coords) => loadRouteSea(coords),
    loadTideCurve: (lat, lon, fromMs, toMs) => fetchTideCurve(lat, lon, fromMs, toMs, { days: 3 }),
};

// ── Fences ─────────────────────────────────────────────────────

const CANCELLED = 'Plan Your Day was closed, or the account changed.';
const cancelled = () => new DOMException(CANCELLED, 'AbortError');

/** True for the rejection a closed sheet or a changed account produces: not an error to show. */
export function isPlanCancelled(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

interface Fence {
    scope: AuthIdentityScope;
    /** Aborts when the sheet's signal does, or the account changes; passed to sources that take one. */
    signal: AbortSignal;
    live(): boolean;
    check(): void;
    /** A source's answer, or `fallback` when it fails or overruns; rejects only when cancelled. */
    part<T>(run: () => Promise<T>, fallback: T, deadlineMs: number, label: string): Promise<T>;
    dispose(): void;
}

function fence(signal: AbortSignal): Fence {
    const scope = getAuthIdentityScope();
    const inner = new AbortController();
    const live = () => !signal.aborted && !inner.signal.aborted && isAuthIdentityScopeCurrent(scope);
    const stop = () => inner.abort();
    signal.addEventListener('abort', stop, { once: true });
    const unsubscribe = subscribeAuthIdentityScope(() => {
        if (!isAuthIdentityScopeCurrent(scope)) stop();
    });
    if (signal.aborted) stop();
    const check = () => {
        if (!live()) throw cancelled();
    };
    const part = <T>(run: () => Promise<T>, fallback: T, deadlineMs: number, label: string): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            if (!live()) {
                reject(cancelled());
                return;
            }
            const onCancel = () => {
                inner.signal.removeEventListener('abort', onCancel);
                reject(cancelled());
            };
            inner.signal.addEventListener('abort', onCancel, { once: true });
            const settle = (value: T) => {
                inner.signal.removeEventListener('abort', onCancel);
                if (live()) resolve(value);
                else reject(cancelled());
            };
            let pending: Promise<T>;
            try {
                pending = run();
            } catch (error) {
                pending = Promise.reject(error);
            }
            withDeadline(Promise.resolve(pending), deadlineMs, `Plan Your Day ${label}`).then(settle, () =>
                settle(fallback),
            );
        });
    return {
        scope,
        signal: inner.signal,
        live,
        check,
        part,
        dispose: () => {
            signal.removeEventListener('abort', stop);
            unsubscribe();
            stop();
        },
    };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validStart = (p: Partial<LatLon> | null | undefined): p is LatLon =>
    !!p && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

// ── 1. The place ───────────────────────────────────────────────

export interface TodayRequest {
    start: LatLon;
    /** A name the picker already has: a saved place, or the typed place. */
    label?: string | null;
    /** The skipper's saved places, for naming the start. */
    savedPlaces?: readonly (LatLon & { name: string })[];
    /** Her cruising speed, for how far afield to look. */
    cruiseKts: number;
}

export type { PlacesStatus } from './today';
export type TidesStatus = 'loading' | 'ok' | 'none';

export interface TodayBase {
    /** Named from the nearest mapped point within half a mile, a saved place, the picker, or the position. */
    start: LatLon & { name: string };
    /** The START's IANA zone (resolveTimeZone, offline), never the phone's. */
    zone: string;
    nowMs: number;
    /** How far afield places were looked for, NM. */
    radiusNm: number;
    weather: DayPlanInput['weather'];
    atmos: SpreadBlock<AtmosVar> | null;
    /** When this phone received the point block (the shared memo may be up to 30 min older). */
    weatherAtMs: number | null;
    /** Null until the first source answers (the offline atlas, at once in
     *  Queensland), and when no place source answered at all. */
    places: GatheredPlaces | null;
    /** 'loading' until every source has answered or run out of time, even
     *  once the atlas's places are in. */
    placesStatus: PlacesStatus;
    tides: Tide[] | null;
    /** WorldTides' station, for Sources. */
    tideStation: string | null;
    tidesStatus: TidesStatus;
    cyclone: CycloneNotice | null;
    /** The marina the start is in or beside: the detail's "Leaving a marina" line. */
    marina: NamedPoint | null;
}

/**
 * How far afield to look: the longest overnight reach over the three days
 * shown (an overnight stay always reaches furthest), so switching day or
 * stay is a recompute and never a new request.
 */
export function placesRadiusNm(start: LatLon, zone: string, nowMs: number, cruiseKts: number): number {
    return Math.max(
        ...chipDates(nowMs, zone, 3).map((date) =>
            reachRadiusNm(
                cruiseKts,
                dayWindow({ date, lat: start.lat, lon: start.lon, zone, nowMs }).usableH,
                'overnight',
            ),
        ),
    );
}

/** The nearest storm by real distance (the short way round), within the notice range. */
export function cycloneNotice(list: readonly ActiveCyclone[], start: LatLon): CycloneNotice | null {
    let best: CycloneNotice | null = null;
    for (const storm of list ?? []) {
        const at = storm?.currentPosition;
        if (!at || !validStart(at)) continue;
        const distanceNm = calculateDistance(start.lat, start.lon, at.lat, at.lon);
        if (!finite(distanceNm) || (best && distanceNm >= best.distanceNm)) continue;
        best = {
            name: storm.name?.trim() || 'unnamed',
            distanceNm,
            bearingDeg: calculateBearing(start.lat, start.lon, at.lat, at.lon),
            issuer: officialWarningsSource(start.lat, start.lon).shortName,
        };
    }
    return best && best.distanceNm <= CYCLONE_NOTICE_NM ? best : null;
}

/**
 * The place, reported as it arrives (onUpdate gets a fresh snapshot each
 * time, the first one synchronously), and resolved when every source has
 * answered or run out of time. Rejects with an AbortError (isPlanCancelled)
 * when the sheet closes or the account changes.
 */
export async function loadToday(
    request: TodayRequest,
    options: { signal: AbortSignal; onUpdate?: (base: TodayBase) => void; deps?: Partial<TodayLoaderDeps> },
): Promise<TodayBase> {
    const deps: TodayLoaderDeps = { ...TODAY_LOADER_DEPS, ...options.deps };
    if (!validStart(request.start)) throw new Error('Choose a valid position to plan from.');
    const f = fence(options.signal);
    try {
        f.check();
        const start = { lat: request.start.lat, lon: request.start.lon };
        const nowMs = deps.now();
        const zone = resolveTimeZone(start.lat, start.lon);
        const radiusNm = placesRadiusNm(start, zone, nowMs, request.cruiseKts);
        const online = deps.online();
        const saved = [
            ...(request.label?.trim() ? [{ ...start, name: request.label.trim() }] : []),
            ...(request.savedPlaces ?? []),
        ];
        let base: TodayBase = {
            start: { ...start, name: nameStart(start, [], saved) },
            zone,
            nowMs,
            radiusNm,
            weather: online ? 'loading' : 'offline',
            atmos: null,
            weatherAtMs: null,
            places: null,
            placesStatus: 'loading',
            tides: null,
            tideStation: null,
            tidesStatus: 'loading',
            cyclone: null,
            marina: null,
        };
        const emit = (patch: Partial<TodayBase>) => {
            if (!f.live()) return;
            base = { ...base, ...patch };
            options.onUpdate?.(base);
        };
        emit({});

        const weather = online
            ? f
                  .part(
                      () => deps.querySpread(start.lat, start.lon).then((r) => r ?? null),
                      null,
                      PART_DEADLINE_MS,
                      'forecast',
                  )
                  .then((result) => {
                      const atmos = result?.atmos?.models.length ? result.atmos : null;
                      if (atmos) emit({ weather: 'ok', atmos, weatherAtMs: deps.now() });
                      else emit({ weather: deps.online() ? 'failed' : 'offline', atmos: null, weatherAtMs: null });
                  })
            : Promise.resolve();

        const places = (async () => {
            const { tiles } = dayPlanTiles(start, radiusNm);
            let savedRoutes: SavedRouteLike[] = [];
            try {
                savedRoutes = deps.savedRoutes(f.scope);
            } catch {
                /* no saved routes: distances are estimates */
            }
            const atlasPart = f.part(
                () => deps.loadAtlas(start.lat, start.lon, radiusNm),
                null,
                PART_DEADLINE_MS,
                'atlas',
            );
            let settled = false;
            // The offline atlas (and her saved routes) first: in Queensland its
            // stops and the marina's name are ready at once, while OpenStreetMap
            // and the coastline can take up to the deadline. Still 'loading'.
            void atlasPart.then(
                (atlas) => {
                    if (settled || !atlas?.length) return;
                    const early = gatherPlaces({
                        start,
                        nowMs,
                        radiusNm,
                        atlas,
                        osm: [],
                        coastline: null,
                        savedRoutes,
                    });
                    emit({
                        places: early,
                        start: { ...start, name: nameStart(start, early.named, saved) },
                        marina: marinaNear(start, early.marinas),
                    });
                },
                () => {
                    /* cancelled: the sheet closed or the account changed */
                },
            );
            const [atlas, cells, coastline] = await Promise.all([
                atlasPart,
                Promise.all(
                    tiles.map((tile) =>
                        f.part(() => deps.loadReferenceTile(tile, f.signal), null, PART_DEADLINE_MS, 'places'),
                    ),
                ),
                f.part(() => deps.loadCoastline(start.lat, start.lon), null, PART_DEADLINE_MS, 'coastline'),
            ]);
            settled = true;
            f.check();
            const answered = cells.filter((cell): cell is ReferenceResult => !!cell);
            const cellsFailed = answered.length < cells.length;
            if (!answered.length && cells.length > 0 && !atlas?.length) {
                emit({ places: null, placesStatus: 'failed' });
                return;
            }
            // (Merged afresh: the coastline turns the atlas's ×1.3 guesses into
            // ×1.15 or ×1.4, and OpenStreetMap adds what the atlas lacks.)
            const gathered = gatherPlaces({
                start,
                nowMs,
                radiusNm,
                atlas: atlas ?? [],
                osm: answered,
                coastline,
                savedRoutes,
            });
            emit({
                places: gathered,
                placesStatus: cellsFailed || !atlas ? 'partial' : 'ok',
                start: { ...start, name: nameStart(start, gathered.named, saved) },
                marina: marinaNear(start, gathered.marinas),
            });
        })();

        const tides = f
            .part(() => deps.loadTides(start.lat, start.lon), null, PART_DEADLINE_MS, 'tides')
            .then((r) => {
                const list = r?.tides?.length ? r.tides : null;
                emit({
                    tides: list,
                    tideStation: list ? (r?.tideGUIDetails?.stationName ?? null) : null,
                    tidesStatus: list ? 'ok' : 'none',
                });
            });

        const storms = online
            ? f
                  .part(() => deps.loadCyclones(), [] as ActiveCyclone[], PART_DEADLINE_MS, 'cyclones')
                  .then((list) => emit({ cyclone: cycloneNotice(list, start) }))
            : Promise.resolve();

        await Promise.all([weather, places, tides, storms]);
        f.check();
        return base;
    } finally {
        f.dispose();
    }
}

// ── 2. The legs ────────────────────────────────────────────────

/** The route wind models: the passage HUD's five, by Open-Meteo id, with the chart's own first choice. */
export interface RouteWindModels {
    ids: readonly string[];
    preferred: string;
    labels: Readonly<Record<string, string>>;
}

/** From PassageModelModal's PASSAGE_MODEL_CHOICES and passageModelChoice(WindStore's model). */
export function routeWindModels(
    choices: readonly { openMeteoModel: string; label: string }[],
    preferred: { openMeteoModel: string },
): RouteWindModels {
    return {
        ids: choices.map((c) => c.openMeteoModel),
        preferred: preferred.openMeteoModel,
        labels: Object.fromEntries(choices.map((c) => [c.openMeteoModel, c.label])),
    };
}

/**
 * Each named stop's one-way leg: one route spread and one sea request. The
 * headline is the chart's own model when it answered, else the first that
 * did, named. If the spread fails (or is only a stale copy), the chart's
 * model is asked alone, as the HUD does: the spread is extra, never a
 * precondition. onLegs reports each stop as it lands.
 */
export async function loadStopLegs(
    needs: readonly { id: string; coords: readonly LatLon[] }[],
    wind: RouteWindModels,
    options: {
        signal: AbortSignal;
        onLegs?: (id: string, legs: StopLegs) => void;
        deps?: Partial<TodayLoaderDeps>;
    },
): Promise<Map<string, StopLegs>> {
    const deps: TodayLoaderDeps = { ...TODAY_LOADER_DEPS, ...options.deps };
    const f = fence(options.signal);
    const out = new Map<string, StopLegs>();
    const label = (model: string) => wind.labels[model] ?? model;
    try {
        f.check();
        const seen = new Set<string>();
        const unique = needs.filter((n) => n && !seen.has(n.id) && seen.add(n.id) && n.coords.length >= 2);
        await Promise.all(
            unique.map(async ({ id, coords }) => {
                const [spread, sea] = await Promise.all([
                    f.part(() => deps.loadRouteSpread(coords, wind.ids), null, LEG_DEADLINE_MS, 'route wind'),
                    f.part(() => deps.loadRouteSea(coords), null, LEG_DEADLINE_MS, 'route sea'),
                ]);
                const fresh = !!spread && deps.now() - spread.fetchedAt <= FORECAST_TTL_MS;
                let pick = fresh ? pickHeadlineMember(spread, wind.preferred, wind.ids) : null;
                let shownSpread: RouteSpread | null = fresh ? spread : null;
                if (!pick) {
                    const own = await f.part(
                        () => deps.loadRouteForecast(coords, wind.preferred),
                        null,
                        LEG_DEADLINE_MS,
                        'route wind',
                    );
                    pick = own
                        ? { forecast: own, model: wind.preferred, substituted: false }
                        : pickHeadlineMember(spread, wind.preferred, wind.ids);
                    // An older range is never shown under a fresher headline.
                    shownSpread = spread && pick && spread.fetchedAt >= pick.forecast.fetchedAt ? spread : null;
                }
                const legs: StopLegs = pick
                    ? {
                          headline: pick.forecast,
                          headlineModel: label(pick.model),
                          substituted: pick.substituted,
                          spread: shownSpread,
                          sea,
                      }
                    : { headline: null, headlineModel: label(wind.preferred), spread: null, sea, failed: true };
                f.check();
                out.set(id, legs);
                options.onLegs?.(id, legs);
            }),
        );
        f.check();
        return out;
    } finally {
        f.dispose();
    }
}

// ── 3. The landing window ──────────────────────────────────────

/**
 * A reviewed stop whose Parks note says "mid to high tide": the stretch of
 * the tide curve at or above mid-tide that the stay falls in (or the nearest
 * one that day), from the stop's own curve. 'no-curve' when no prediction
 * answers. Approximate by construction; the detail says so.
 */
export async function loadLandingWindow(
    stop: LatLon,
    window: DayWindow,
    stay: { arriveMs: number | null; stayEndMs: number | null } | null,
    options: { signal: AbortSignal; deps?: Partial<TodayLoaderDeps> },
): Promise<{ fromMs: number; toMs: number } | 'no-curve'> {
    const deps: TodayLoaderDeps = { ...TODAY_LOADER_DEPS, ...options.deps };
    const f = fence(options.signal);
    try {
        f.check();
        const dayStart = wallTime(window.date, 0, 0, window.zone);
        const dayEnd = Math.max(
            wallTime(addDays(window.date, 1), 0, 0, window.zone),
            finite(stay?.stayEndMs) ? stay!.stayEndMs! : -Infinity,
        );
        const curve = await f.part(
            () => deps.loadTideCurve(stop.lat, stop.lon, dayStart, dayEnd),
            null,
            PART_DEADLINE_MS,
            'tide curve',
        );
        f.check();
        if (!curve) return 'no-curve';
        const runs = landingWindows((ms) => curve.heightAt(ms), dayStart, dayEnd);
        if (!runs.length) return 'no-curve';
        const from = finite(stay?.arriveMs) ? stay!.arriveMs! : (window.firstLightMs ?? dayStart);
        const to = finite(stay?.stayEndMs) ? stay!.stayEndMs! : (window.lastLightMs ?? dayEnd);
        const overlap = (r: { fromMs: number; toMs: number }) => Math.min(r.toMs, to) - Math.max(r.fromMs, from);
        const gap = (r: { fromMs: number; toMs: number }) =>
            r.toMs < from ? from - r.toMs : r.fromMs > to ? r.fromMs - to : 0;
        return runs.reduce((a, b) => {
            const ob = overlap(b);
            const oa = overlap(a);
            if (ob > 0 || oa > 0) return ob > oa ? b : a;
            return gap(b) < gap(a) ? b : a;
        });
    } finally {
        f.dispose();
    }
}

// ── Into the engine ────────────────────────────────────────────

/**
 * The engine's input from what has loaded. Tides only once they have
 * answered; places stay null while loading and when no source answered.
 */
export function todayInput(
    base: TodayBase,
    args: Pick<DayPlanInput, 'stay' | 'limits' | 'speed' | 'usingDefaultVessel'> &
        Partial<Pick<DayPlanInput, 'date' | 'legs' | 'boatFixAgeMs' | 'nowMs'>>,
): DayPlanInput {
    return {
        nowMs: args.nowMs ?? base.nowMs,
        zone: base.zone,
        start: base.start,
        date: args.date ?? null,
        stay: args.stay,
        limits: args.limits,
        speed: args.speed,
        usingDefaultVessel: args.usingDefaultVessel,
        atmos: base.atmos,
        weather: base.weather,
        places: base.places,
        placesStatus: base.placesStatus,
        tides: base.tidesStatus === 'ok' ? base.tides : null,
        legs: args.legs,
        boatFixAgeMs: args.boatFixAgeMs ?? null,
        cyclone: base.cyclone,
    };
}
