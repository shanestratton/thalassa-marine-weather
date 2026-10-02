/**
 * Auto's route provider: Thalassa's own router, on this phone (2026-10-01).
 *
 * Shane 2026-09-30: "sevenc's has never been connected properly, it does not
 * work, it can go at your leisure". Auto now runs tryInshoreRoute — the same
 * engine every Pro user already runs through the manual ⚡ Auto route and the
 * passage planner — from the installed charts. Nothing here calls a server to
 * decide whether Auto is offered or to compute the line.
 *
 * Auto keeps its stricter framing: a trial, never cleared for navigation, an
 * independent chart review before a planned-only save. And the ⚡ rule (see
 * components/map/useAutoRouteLeg.ts): on ANY failure Auto shows no line and
 * says why — it never falls back to a straight line. A null from the engine is
 * never left unexplained: the two gates that answer null (the 50 NM cap and
 * endpoint coverage) are checked here first, in plain words.
 *
 * Always the 'safest' profile (Shane 2026-07-02, as the passage planner): the
 * tide changes whether and when, never which way.
 */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import { AUTO_ROUTE_TRIAL_OFF, isAutorouteTrialOn } from './autorouteTrialSwitch';
import { listCells } from './enc/EncCellMetadata';
import { validateAutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';
import { thalassaVesselWarnings } from './autoroutingVesselProfile';
import { inshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { waterPackRefusal, type WaterPackEnd } from './waterPack/waterPackWords';
import {
    BackstopLandRefusal,
    backstopUnavailableNote,
    backstopUnavailableWords,
    chartedLandFinding,
    landBackstopRefusal,
} from './routing/landBackstopWords';
import {
    dangerWithoutChartedDepth,
    inshoreSegmentStates,
    surveyAmberMetres,
} from '../components/map/inshoreRouteState';
import { createLogger } from '../utils/createLogger';
import { withTimeout } from '../utils/deadline';
import {
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_POINTS,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
    type AutoroutingTrialRequest,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
    type AutoroutingVesselProfile,
    type ThalassaRouteDisclosure,
} from '../types/autorouting';

export type { AutoroutingTrialRequest, AutoroutingTrialRoute, AutoroutingTrialStatus } from '../types/autorouting';

const log = createLogger('autoroutingThalassa');

/** First line of every Auto proposal: what it is, before anything it found. */
export const THALASSA_PLANNED_ONLY_WARNING =
    'Proposal only: not cleared for navigation. Review every leg against the chart before you save or use it.';
/** The router's under-keel clearance (InshoreRouter safetyM, owner decision 11). */
const UKC_M = 0.5;
/** A route end this far from its pin is said (the fix-first follow-up, 2026-10-01). */
const PIN_GAP_SAY_M = 50;
/** Further than this, an end the engine does not explain (a pin on land, on
 *  a drying bank, in water no tide clears) is no route by water to that pin
 *  at all: the engine's far-snap threshold (inshoreRouterEngine FAR_SNAP_M).
 *  Review fix-up, 2026-10-01: a 400 m land wall between the pins gave a
 *  "route" that ended 11.6 km from the destination, on the wrong side of
 *  the wall, saveable and counted by Plan My Day as reaching the stop. */
const PIN_GAP_REFUSE_M = 500;
/** How long the Notice to Mariners lookups may hold a finished route. */
const NOTICE_LOOKUP_MS = 5_000;
/** The ⚡ Auto route's cloud fill pad around the leg (useAutoRouteLeg). */
const FILL_PAD_DEG = 0.03;
/** Lets the status paint before the engine's synchronous A* holds the thread
 *  (20–47 s measured on iPhone; the passage planner yields the same). */
const PAINT_YIELD_MS = 80;

const AUTH_REQUIRED = 'Sign in to use Auto routing.';
const NO_ROUTE = 'Thalassa could not route this passage. Nothing changed.';
const WATCHDOG = 'Routing took longer than this phone allows (85 s). Try a shorter passage. Nothing changed.';
const BUCKET_UNREACHABLE =
    "This passage needs charts this phone doesn't have, and the chart cloud isn't reachable. Check your connection and that you're signed in (the charts are licensed). Nothing changed.";
const NOT_SIGNED_IN_FILL =
    "The missing charts wouldn't download — you're probably not signed in (the chart bucket is licensed-access). Sign in and try again. Nothing changed.";

/**
 * Whether Auto is offered, worked out on the phone: a signed-in identity and
 * the Auto route (trial) switch in Preferences (enabled), and at least one
 * installed navigation chart (ready). No network. The switch is off by
 * default (2026-10-01, services/autorouteTrialSwitch.ts): Pro alone is every
 * beta account. The rest of Auto's gate is unchanged and lives with its
 * callers: Pro route planning (RoutePlanner) and a confirmed draft
 * (runWithConfirmedDraft).
 */
export function getThalassaAutorouteStatus(): AutoroutingTrialStatus {
    const scope = getAuthIdentityScope();
    if (!scope.userId)
        return { enabled: false, ready: false, message: 'Sign in to use Auto routing. Manual is ready.' };
    if (!isAutorouteTrialOn()) return { enabled: false, ready: false, message: AUTO_ROUTE_TRIAL_OFF };
    let cells = 0;
    try {
        cells = listCells().length;
    } catch {
        cells = 0;
    }
    return cells > 0
        ? { enabled: true, ready: true }
        : { enabled: true, ready: false, message: 'Install charts for your area to use Auto. Manual is ready.' };
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteWithin = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const validPoint = (value: unknown): value is { lat: number; lon: number } =>
    record(value) && finiteWithin(value.lat, -90, 90) && finiteWithin(value.lon, -180, 180);

/** Validate and detach the request before any asynchronous work. */
function snapshotRequest(request: AutoroutingTrialRequest): {
    departure: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    draftM: number;
    speedKts: number;
    vesselProfile?: AutoroutingVesselProfile;
} {
    if (
        !record(request) ||
        !validPoint(request.departure) ||
        !validPoint(request.destination) ||
        (request.departure.lat === request.destination.lat && request.departure.lon === request.destination.lon) ||
        !finiteWithin(request.draftM, Number.MIN_VALUE, AUTOROUTING_TRIAL_MAX_DRAFT_M) ||
        !finiteWithin(request.speedKts, Number.MIN_VALUE, AUTOROUTING_TRIAL_MAX_SPEED_KTS)
    ) {
        throw new Error('Enter two different valid positions, a positive draft and a positive cruising speed.');
    }
    let vesselProfile: AutoroutingVesselProfile | undefined;
    if (request.vesselProfile !== undefined) {
        try {
            vesselProfile = validateAutoroutingVesselProfile(request.vesselProfile);
        } catch {
            vesselProfile = undefined;
        }
        if (!vesselProfile || vesselProfile.draftStatus === 'missing')
            throw new Error('Check the stored vessel dimensions and draft in Vessel settings before calculating.');
    }
    return {
        departure: { lat: request.departure.lat, lon: request.departure.lon },
        destination: { lat: request.destination.lat, lon: request.destination.lon },
        draftM: request.draftM,
        speedKts: request.speedKts,
        ...(vesselProfile ? { vesselProfile } : {}),
    };
}

/** Haversine, nautical miles — the engine's own radius (InshoreRouter). */
function distanceNM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const r = Math.PI / 180;
    const h =
        Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
        Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
    return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function abortError(): DOMException {
    return new DOMException('Auto routing was cancelled or the account changed.', 'AbortError');
}

const roundedMetres = (m: number): number => Math.max(10, Math.round(m / 10) * 10);
/** Metres in a skipper's words: "11.6 km", "650 m". */
const distanceWords = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${roundedMetres(m)} m`);
/** "27.393° S, 153.172° E" — the engine's own way (tideCeiling positionWords). */
const positionWords = ([lon, lat]: [number, number]): string =>
    `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;

/**
 * What a current Notice to Mariners says about this line, as the passage
 * planner says it (usePassagePlanner: the NtM routing banner, and the
 * standing notices within 500 m of the route). Best effort: a lookup that
 * fails or runs long says nothing, and never holds the route.
 */
async function noticeLines(polyline: readonly [number, number][]): Promise<string[]> {
    const lines: string[] = [];
    let bbox: [number, number, number, number] | null = null;
    for (const [lon, lat] of polyline)
        bbox = bbox
            ? [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)]
            : [lon, lat, lon, lat];
    if (!bbox) return lines;
    const corridor = bbox;
    try {
        const { packsForCorridor } = await import('./ntmRouting');
        const applied = (await withTimeout(packsForCorridor(corridor), [], NOTICE_LOOKUP_MS)).filter(
            ({ status, optedOut }) => status.status === 'current' && !optedOut,
        );
        if (applied.length > 0)
            lines.push(
                `Routing follows a current Notice to Mariners — ${applied
                    .map(({ pack }) => `${pack.noticeKey} — ${pack.title} (surveyed ${pack.surveyed})`)
                    .join(
                        ' · ',
                    )}. Surveyed depths and the promulgated track are applied. Read the notice before you go.`,
            );
    } catch (err) {
        log.warn(`notice packs unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const { loadLocalNotices, localNoticesNearPolyline } = await import('./localNotices');
        const hits = localNoticesNearPolyline(
            await withTimeout(loadLocalNotices(), [], NOTICE_LOOKUP_MS),
            polyline,
            500,
        );
        if (hits.length > 0)
            lines.push(
                `Notice to Mariners on this route — ${hits.map((n) => n.title).join(' · ')}. Read it before you go.`,
            );
    } catch (err) {
        log.warn(`standing notices unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return lines;
}

function routeId(): string {
    let rand = '';
    try {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
    } catch {
        rand = Math.random().toString(36).slice(2, 10);
    }
    return `thalassa-${Date.now().toString(36)}-${rand || '0'}`;
}

type EngineSuccess = Extract<
    Awaited<ReturnType<typeof import('./InshoreRouter').tryInshoreRoute>>,
    { polyline: [number, number][] }
>;

/**
 * Route one passage with Thalassa's router. Resolves with a proposal whose
 * coordinates are the engine's polyline exactly, or throws an Error whose
 * message is the plain reason — the engine's own words for a final refusal
 * (no tide clears, overhead clearance), whole. An abort or account change
 * throws an AbortError and returns nothing.
 */
export async function calculateThalassaProposal(
    request: AutoroutingTrialRequest,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
): Promise<AutoroutingTrialRoute> {
    const scope = getAuthIdentityScope();
    const input = snapshotRequest(request);
    if (!scope.userId) throw new Error(AUTH_REQUIRED);
    // Off by default (2026-10-01): no route from Auto or Plan Your Day until
    // the skipper switches Auto route (trial) on, whoever asks.
    if (!isAutorouteTrialOn()) throw new Error(AUTO_ROUTE_TRIAL_OFF);
    const assertCurrent = () => {
        if (signal?.aborted || !isAuthIdentityScopeCurrent(scope)) throw abortError();
    };
    assertCurrent();
    const { tryInshoreRoute, hasEncCoverageForRoute, MAX_INSHORE_NM } = await import('./InshoreRouter');
    assertCurrent();
    const { departure, destination, draftM, vesselProfile } = input;

    // The two gates the engine answers with a silent null, said first.
    const directNM = distanceNM(departure, destination);
    if (directNM > MAX_INSHORE_NM)
        throw new Error(
            `Auto routes inshore passages up to ${MAX_INSHORE_NM} NM; this one is ${directNM.toFixed(1)} NM. Split it, or plot it in Manual.`,
        );
    const startCovered = hasEncCoverageForRoute(departure, departure);
    const endCovered = hasEncCoverageForRoute(destination, destination);
    if (!startCovered || !endCovered)
        throw new Error(
            `No installed chart covers the ${!startCovered && !endCovered ? 'departure or the destination' : !startCovered ? 'departure' : 'destination'}.`,
        );

    // Air draft not set → null: every charted and curated structure blocks
    // (owner decision 5). An estimated one is used as given and said so.
    const airDraftM =
        vesselProfile && vesselProfile.airDraft.status !== 'missing' ? vesselProfile.airDraft.valueM : null;
    const departureMs = Date.now();
    const progress = (message: string) => {
        if (!signal?.aborted && isAuthIdentityScopeCurrent(scope)) onProgress?.(message);
    };
    const run = async () => {
        progress('Following deep water…');
        await new Promise((resolve) => setTimeout(resolve, PAINT_YIELD_MS));
        assertCurrent();
        // The engine's own 85 s watchdog is the only timeout: a shorter one
        // here would abort good computes on the phone (the old trial's 45 s).
        let res: Awaited<ReturnType<typeof tryInshoreRoute>>;
        try {
            res = await tryInshoreRoute(departure, destination, draftM, airDraftM, 'safest', { departureMs });
        } catch (error) {
            assertCurrent();
            log.warn(`engine threw: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(NO_ROUTE);
        }
        assertCurrent();
        return res;
    };

    let res = await run();
    // A corridor gap: fetch the missing charts from the cloud once, then route
    // once more — exactly as the ⚡ Auto route does (useAutoRouteLeg).
    if (res && 'error' in res && res.code === 'coverage-gap') {
        progress('Fetching the missing charts…');
        let fill: { downloaded: number; needed: number; bucketAvailable: boolean };
        try {
            const { downloadCloudCellsForBBox } = await import('./enc/cloudCellSync');
            fill = await downloadCloudCellsForBBox([
                Math.min(departure.lon, destination.lon) - FILL_PAD_DEG,
                Math.min(departure.lat, destination.lat) - FILL_PAD_DEG,
                Math.max(departure.lon, destination.lon) + FILL_PAD_DEG,
                Math.max(departure.lat, destination.lat) + FILL_PAD_DEG,
            ]);
        } catch (error) {
            assertCurrent();
            throw new Error(
                `Couldn't fetch the missing charts (${error instanceof Error ? error.message.slice(0, 60) : 'error'}). Check your connection and sign-in, then try again. Nothing changed.`,
            );
        }
        assertCurrent();
        log.warn(`cloud fill downloaded=${fill.downloaded} needed=${fill.needed} bucket=${fill.bucketAvailable}`);
        if (!fill.bucketAvailable) throw new Error(BUCKET_UNREACHABLE);
        if (fill.downloaded === 0 && fill.needed > 0) throw new Error(NOT_SIGNED_IN_FILL);
        if (fill.downloaded > 0) res = await run();
    }
    if (!res) throw new Error(NO_ROUTE);
    if ('error' in res) {
        if (res.code === 'watchdog-timeout') throw new Error(WATCHDOG);
        // The engine's words, whole: a final refusal names the spot, its
        // depth, the tide and the need (owner decision 11), or the structure.
        throw new Error(typeof res.error === 'string' && res.error.trim() ? res.error : NO_ROUTE);
    }
    const ok: EngineSuccess = res;
    const polyline = ok.polyline;
    if (!Array.isArray(polyline) || polyline.length < 2) throw new Error(NO_ROUTE);
    if (polyline.length > AUTOROUTING_TRIAL_MAX_POINTS)
        throw new Error(
            `This route has too many points for Auto to review (${polyline.length}). Split the passage, or plot it in Manual.`,
        );
    if (
        !polyline.every(
            (p) => Array.isArray(p) && p.length === 2 && finiteWithin(p[0], -180, 180) && finiteWithin(p[1], -90, 90),
        )
    )
        throw new Error(NO_ROUTE);

    // Never across charted land (review fix-up, 2026-10-01). The engine
    // refuses only a run over 500 m, and its localized relax retry can open
    // land up to 4 km from a far-snapped pin: a 400 m land wall between two
    // pins came back as a red line straight across it. Land at a pin's own
    // edge (a pin on land or a drying bank, decision 7) is that pin's, and
    // the route says so; any other is no route.
    // Owner decision 2 (Phase 2b, 2026-10-01): offline, an end whose harbour
    // water is not on the phone is said first — the charts alone paint the
    // Newport canal as land.
    // The pack's facts for these ends only; `gaps` (some water along the
    // route not saved) only for a refusal about the whole route.
    const packFor = (ends: readonly WaterPackEnd[], gaps = false): Parameters<typeof waterPackRefusal>[1] =>
        ok.waterPack && (ok.waterPack.source === 'pack' || ok.waterPack.source === 'none')
            ? {
                  missing: ok.waterPack.missing.filter((e) => ends.includes(e)),
                  ...(gaps && ok.waterPack.gaps ? { gaps: true as const } : {}),
                  ...(ok.waterPack.offline ? { offline: true as const } : {}),
              }
            : undefined;
    // The words are shared with the passage planner and the voyage form,
    // which refuse it too (landBackstopWords.chartedLandFinding).
    const chartedLand = chartedLandFinding(ok.hardLand);
    if (chartedLand)
        throw new Error(
            waterPackRefusal(`${chartedLand} No route. Nothing changed.`, packFor(['departure', 'destination'], true)),
        );
    const stateMask = inshoreSegmentStates(ok);
    // Red with no charted depth behind it, inside a relax zone, when the
    // tides were loaded (review fix-up, 2026-10-01): the relaxed rescue of a
    // pin cut off by water no tide clears, routed through what no chart
    // vouches is water. Decision 11 gives no route rather than that.
    if (ok.tideCeilingsLoaded && ok.relaxZones?.length && stateMask) {
        const unchecked = dangerWithoutChartedDepth({ ...ok, stateMask }) ?? [];
        const inZone = unchecked.find((i) => {
            const [lonA, latA] = polyline[i];
            const [lonB, latB] = polyline[i + 1];
            const mid = { lat: (latA + latB) / 2, lon: (lonA + lonB) / 2 };
            return ok.relaxZones!.some((z) => distanceNM(z, mid) * 1852 <= z.radiusM);
        });
        if (inZone !== undefined) {
            const [lonA, latA] = polyline[inZone];
            const [lonB, latB] = polyline[inZone + 1];
            throw new Error(
                `The only way Thalassa found runs over water no chart gives a depth for, near ${positionWords([(lonA + lonB) / 2, (latA + latB) / 2])}. No route. Nothing changed.`,
            );
        }
    }

    // A route end far from its pin that the engine does not explain is no
    // route by water to that pin (review fix-up, 2026-10-01).
    const toPoint = ([lon, lat]: [number, number]) => ({ lat, lon });
    const startGapM = distanceNM(departure, toPoint(polyline[0])) * 1852;
    const endGapM = distanceNM(destination, toPoint(polyline[polyline.length - 1])) * 1852;
    const startExplained = !!ok.pinOffWater?.origin;
    const endExplained = !!ok.pinOffWater?.destination || !!ok.destinationInlandTrimM;
    if (endGapM > PIN_GAP_REFUSE_M && !endExplained)
        throw new Error(
            waterPackRefusal(
                `No route by water to your destination: the nearest water Thalassa could reach is ${distanceWords(endGapM)} from the pin. Nothing changed.`,
                packFor(['destination']),
            ),
        );
    if (startGapM > PIN_GAP_REFUSE_M && !startExplained)
        throw new Error(
            waterPackRefusal(
                `No route by water from your departure: the nearest water Thalassa could reach is ${distanceWords(startGapM)} from the pin. Nothing changed.`,
                packFor(['departure']),
            ),
        );

    // The satellite land check, as the passage planner runs it. Land refuses;
    // when the check cannot finish the route is shown and says what happened
    // (2026-10-02: online, it had timed out and said "offline"), and Review's
    // Retry re-runs the check alone from the chart verdicts kept here.
    // ETOPO land counts only where this route's own charts do not vouch for
    // water (2026-10-02, Coral Sea Marina → Daydream Island: its ~1.8 km
    // pixels read the marina and the deep water off a headland as land), and
    // the refusal says where, and whether the charts are missing there.
    const { inshoreRouteCrossesLand } = await import('./routing/landBackstop');
    assertCurrent();
    const backstop = await inshoreRouteCrossesLand(polyline, { chartWater: ok.chartWater });
    assertCurrent();
    if (backstop.status === 'verified' && backstop.crossesLand) throw new Error(landBackstopRefusal(backstop));
    const backstopState: ThalassaRouteDisclosure['backstop'] =
        backstop.status === 'verified' ? 'verified' : 'unavailable';
    const backstopReason = backstopState === 'unavailable' ? backstopUnavailableWords(backstop.unavailable) : null;

    const coordinates = polyline.map(([lon, lat]): [number, number] => [lon, lat]);
    const engineCaveats = inshoreRouteCaveats({
        destinationInlandTrimM: ok.destinationInlandTrimM,
        structuresUnknownCells: ok.structuresUnknownCells,
        pinOffWater: ok.pinOffWater,
        tideCheck: ok.tideCheck,
        surveyRuns: ok.surveyRuns,
        surveyUncheckedCells: ok.surveyUncheckedCells,
        // Where the canal water came from offline (Phase 2b, 2026-10-01).
        waterPack: ok.waterPack,
        // Auto draws the survey dots (the workspace's surveyDashLayers), so
        // the words name them as the planner's do.
        ...(stateMask
            ? { surveyAmber: surveyAmberMetres(polyline, stateMask, ok.surveyRuns, ok.chartedShallowSpans) }
            : {}),
    });
    const notices = await noticeLines(polyline);
    assertCurrent();
    const extra: string[] = [];
    if (!stateMask)
        extra.push(
            "Route shown, verification incomplete: the router's safety classifications were missing or did not match the line. Recalculate before saving.",
        );
    if (ok.destinationInlandTrimM)
        extra.push(
            `Your destination pin sits ~${Math.round(ok.destinationInlandTrimM)} m onto charted land — the route ends at the nearest navigable water.`,
        );
    if (backstopReason) extra.push(backstopUnavailableNote(backstopReason));
    // A route end short of its pin is said (the fix-first follow-up): unless
    // the engine already said why (a pin on land, a bank or water no tide clears).
    if (startGapM > PIN_GAP_SAY_M && !startExplained)
        extra.push(
            `The route starts ~${roundedMetres(startGapM)} m from your departure pin; the water before it could not be reached.`,
        );
    if (endGapM > PIN_GAP_SAY_M && !endExplained)
        extra.push(
            `The route ends ~${roundedMetres(endGapM)} m short of your destination pin; the water beyond could not be reached.`,
        );
    const warnings = [
        THALASSA_PLANNED_ONLY_WARNING,
        `Routed on this phone by Thalassa from your installed charts: draft ${draftM.toFixed(2)} m + ${UKC_M} m under the keel at chart datum (LAT). Tide is shown, never assumed.`,
        ...engineCaveats,
        ...extra,
        ...notices,
        ...thalassaVesselWarnings(vesselProfile),
    ];
    const copy = <T>(value: T | undefined): T | undefined => (value === undefined ? undefined : structuredClone(value));
    const engine: ThalassaRouteDisclosure = {
        stateMask,
        ...(ok.cautionMask ? { cautionMask: [...ok.cautionMask] } : {}),
        ...(ok.canalMask ? { canalMask: [...ok.canalMask] } : {}),
        ...((ok.channelMask ?? ok.tier4Mask) ? { channelMask: [...(ok.channelMask ?? ok.tier4Mask)!] } : {}),
        ...(ok.offshoreMask ? { offshoreMask: [...ok.offshoreMask] } : {}),
        ...(ok.chartedShallowMask ? { chartedShallowMask: [...ok.chartedShallowMask] } : {}),
        ...(ok.landPaintConflictMask ? { landPaintConflictMask: [...ok.landPaintConflictMask] } : {}),
        ...(ok.cautionWhy ? { cautionWhy: [...ok.cautionWhy] } : {}),
        ...(ok.cautionDepthM ? { cautionDepthM: [...ok.cautionDepthM] } : {}),
        ...(ok.tideDepthM ? { tideDepthM: [...ok.tideDepthM] } : {}),
        ...(typeof ok.tideNeedM === 'number' ? { tideNeedM: ok.tideNeedM } : {}),
        ...(ok.shallowRuns ? { shallowRuns: copy(ok.shallowRuns) } : {}),
        ...(ok.chartedShallowSpans ? { chartedShallowSpans: copy(ok.chartedShallowSpans) } : {}),
        ...(ok.surveyRuns ? { surveyRuns: copy(ok.surveyRuns) } : {}),
        ...(ok.surveyUncheckedCells ? { surveyUncheckedCells: [...ok.surveyUncheckedCells] } : {}),
        ...(ok.structuresUnknownCells ? { structuresUnknownCells: [...ok.structuresUnknownCells] } : {}),
        ...(ok.pinOffWater ? { pinOffWater: { ...ok.pinOffWater } } : {}),
        ...(ok.tideCheck ? { tideCheck: ok.tideCheck } : {}),
        ...(ok.destinationInlandTrimM ? { destinationInlandTrimM: ok.destinationInlandTrimM } : {}),
        cellsUsed: [...(ok.cellsUsed ?? [])],
        distanceNM: ok.distanceNM,
        elapsedMs: ok.elapsedMs,
        ...(ok.debug?.seaway ? { seaway: copy(ok.debug.seaway) } : {}),
        backstop: backstopState,
        ...(backstopReason ? { backstopReason } : {}),
        ...(backstopReason && Array.isArray(backstop.chartVerdicts)
            ? { backstopCharts: [...backstop.chartVerdicts] }
            : {}),
        ...(ok.hardLand ? { hardLandAwayM: ok.hardLand.awayM } : {}),
        ...(typeof ok.tideCeilingsLoaded === 'boolean' ? { tideCeilingsLoaded: ok.tideCeilingsLoaded } : {}),
    };
    return {
        id: routeId(),
        coordinates,
        warnings,
        createdAt: new Date().toISOString(),
        provider: 'Thalassa',
        ...(vesselProfile ? { vesselProfile } : {}),
        engine,
    };
}

/**
 * Review's Retry for the satellite land check (2026-10-02): the check alone,
 * on this exact line, from the chart verdicts the proposal kept — never the
 * route, never the chart review. Resolves with the proposal as it now stands:
 * the same id and line, its backstop 'verified' and the note dropped, or still
 * 'unavailable' with what happened this time. Throws Auto's land refusal as a
 * BackstopLandRefusal when the check now finds land (the route must not be
 * shown), and a plain Error when this proposal cannot be rechecked here
 * (Recalculate instead) — Review keeps the route for that one.
 */
export async function recheckThalassaBackstop(route: AutoroutingTrialRoute): Promise<AutoroutingTrialRoute> {
    const engine = route.engine;
    if (route.provider !== 'Thalassa' || route.localEdit !== undefined || !engine)
        throw new Error('This route cannot be rechecked here. Recalculate.');
    if (engine.backstop === 'verified') return route;
    const scope = getAuthIdentityScope();
    const { inshoreRouteCrossesLand, samplePolyline } = await import('./routing/landBackstop');
    const charts = engine.backstopCharts;
    if (!Array.isArray(charts) || charts.length !== samplePolyline(route.coordinates).length)
        throw new Error("This route's chart evidence for the satellite check is not kept. Recalculate.");
    const backstop = await inshoreRouteCrossesLand(route.coordinates, { chartVerdicts: charts });
    if (!isAuthIdentityScopeCurrent(scope)) throw abortError();
    if (backstop.status === 'verified' && backstop.crossesLand)
        throw new BackstopLandRefusal(landBackstopRefusal(backstop));
    const oldNote = engine.backstopReason ? backstopUnavailableNote(engine.backstopReason) : null;
    const others = route.warnings.filter((w) => w !== oldNote);
    if (backstop.status === 'verified') {
        const { backstopReason: _reason, backstopCharts: _charts, ...rest } = engine;
        return { ...route, warnings: others, engine: { ...rest, backstop: 'verified' } };
    }
    const backstopReason = backstopUnavailableWords(backstop.unavailable);
    const note = backstopUnavailableNote(backstopReason);
    const at = oldNote ? route.warnings.indexOf(oldNote) : -1;
    const warnings = at >= 0 ? route.warnings.map((w, i) => (i === at ? note : w)) : [...route.warnings, note];
    return { ...route, warnings, engine: { ...engine, backstop: 'unavailable', backstopReason } };
}
