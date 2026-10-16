import { useFollowRouteStore } from '../../stores/followRouteStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { WindStore } from '../../stores/WindStore';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../authIdentityScope';
import { acquireFreshOwnshipPosition } from '../ownshipPosition';
import { ShipLogService } from '../ShipLogService';
import { VoyageLogService } from '../VoyageLogService';
import { supabase } from '../supabase';
import { currentRouteReplaceDecision } from '../shiplog/routeAuthority';
import { getDeviceId, getDeviceName } from '../skipperDevice';
import { requestPassageMode, peekPassageRequest } from '../passageHandoff';
import { markWrittenHere } from '../shiplog/planLinkIntent';
import { isochroneRoutingContext } from './isochronePolicy';
import { OFFSHORE_COMPARISON_MODELS } from './offshoreModelComparison';
import { remainingReplanVias, replanFixUsable, replanWindCovered, replanAuthoritySnapshot } from './routeReplanPolicy';
import {
    readRouteReplan,
    setRouteReplan,
    cancelRouteReplan,
    type RouteReplanBase,
    type RouteReplanCandidate,
} from './routeReplanSession';
import { withDeadline } from '../../utils/deadline';
import { haversineNm } from '../isochrone/geodesy';
import type { VoyagePlan } from '../../types';
import { resolveRouteConstraints, routeRetainsConstraints } from './routeConstraints';

const followKey = () => {
    const state = useFollowRouteStore.getState();
    return JSON.stringify([state.isFollowing, state.voyageId, state.startedAt, state.routeCoords, state.voyagePlan]);
};
const settingsKey = () => isochroneRoutingContext('', useSettingsStore.getState().settings);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let epoch = 0;
export function replanContextCurrent(base: RouteReplanBase): boolean {
    return (
        isAuthIdentityScopeCurrent(base.owner) &&
        useSettingsStore.getState().activeVesselId === base.boatId &&
        ShipLogService.getCurrentVoyageId() === base.voyageId &&
        ShipLogService.getTrackingStatus().boatId === base.boatId &&
        !ShipLogService.getTrackingStatus().isPaused &&
        followKey() === base.followKey &&
        settingsKey() === base.settingsKey &&
        JSON.stringify(replanAuthoritySnapshot(useSettingsStore.getState().settings)) ===
            JSON.stringify(base.authority) &&
        currentRouteReplaceDecision() !== 'refuse' &&
        WindStore.getState().model === base.model
    );
}
function requireCurrent(base: RouteReplanBase): void {
    if (!replanContextCurrent(base))
        throw Error('The account, boat, followed route, authority or routing settings changed. Re-plan again.');
}
function requireReviewedCurrent(base: RouteReplanBase): void {
    requireCurrent(base);
    const age = Date.now() - Date.parse(base.departureTime);
    if (!Number.isFinite(age) || age < -5000 || age > 300000)
        throw Error('The reviewed candidate expired. Re-plan again.');
}
async function geometryHash(coordinates: number[][]): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(coordinates));
    if (bytes.byteLength > 1024 * 1024) throw Error('Candidate geometry exceeds the accepted size.');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');
}
async function currentSession(): Promise<string> {
    if (!supabase) throw Error('Connect to review the current followed-route link.');
    const { data, error } = await withDeadline(supabase.auth.getSession(), 8000, 'replan session');
    const token = data.session?.access_token;
    if (error || !token || data.session?.user.id !== getAuthIdentityScope().userId)
        throw Error('Sign in again before re-planning.');
    try {
        const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(encoded));
        if (typeof claims.session_id === 'string' && claims.session_id.length <= 128) return claims.session_id;
    } catch {
        /* An unverified/unreadable session cannot authorize replacement. */
    }
    throw Error('The current sign-in session could not be verified.');
}
subscribeAuthIdentityScope(() => {
    epoch++;
    setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
});

/** Explicit action only. Preparation and computation share one 60-second deadline. */
export async function requestRouteReplan(expectedArrivalMs: number | null = null): Promise<void> {
    const current = readRouteReplan();
    if (current.phase === 'preparing' || current.phase === 'computing' || current.phase === 'accepting') return;
    const turn = ++epoch,
        token = crypto.randomUUID(),
        owner = getAuthIdentityScope(),
        deadlineMs = Date.now() + 60000;
    const owns = () => epoch === turn && isAuthIdentityScopeCurrent(owner) && Date.now() < deadlineMs;
    setRouteReplan({
        phase: 'preparing',
        base: null,
        candidate: null,
        message: 'Checking position and the current route link…',
    });
    try {
        const settings = useSettingsStore.getState(),
            followed = useFollowRouteStore.getState(),
            voyageId = ShipLogService.getCurrentVoyageId();
        const boatId = settings.activeVesselId;
        if (
            !owner.userId ||
            !boatId ||
            !voyageId ||
            !followed.isFollowing ||
            !followed.voyagePlan ||
            !followed.voyageId
        )
            throw Error('Follow a saved route on this boat’s active voyage before re-planning.');
        const tracking = ShipLogService.getTrackingStatus();
        if (!uuid.test(voyageId) || tracking.boatId !== boatId || tracking.isPaused)
            throw Error('An active Cast Off passage bound to this boat is required. The current route stays.');
        if (settings.settings.satelliteMode)
            throw Error(
                'Satellite Mode: a fresh forecast and route-link check need ordinary internet. The current route stays.',
            );
        if (currentRouteReplaceDecision() === 'refuse')
            throw Error('Only the skipper’s device can change this followed route.');
        const speed = settings.settings.vessel?.cruisingSpeed;
        if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 50)
            throw Error('Set this boat’s cruising speed before re-planning.');
        const original = structuredClone(followed.voyagePlan),
            oldCoords = structuredClone(followed.routeCoords),
            originalFollowKey = followKey(),
            originalSettingsKey = settingsKey();
        const model = OFFSHORE_COMPARISON_MODELS.find((row) => row.id === WindStore.getState().model);
        if (!model) throw Error('Choose a supported global wind model before re-planning.');
        const [fix, sessionId, link] = await Promise.all([
            acquireFreshOwnshipPosition({ locationAccess: 'foreground-request', timeoutSec: 8, maxGpsAgeMs: 30000 }),
            currentSession(),
            withDeadline(VoyageLogService.getPlanLink(voyageId), 8000, 'replan link'),
        ]);
        if (!owns() || readRouteReplan().phase !== 'preparing') return;
        if (!replanFixUsable(fix, Date.now()))
            throw Error('A fresh boat or phone position is required. No last-known position is substituted.');
        if (
            !link.ok ||
            !link.row?.updatedAt ||
            link.row.voyageId !== voyageId ||
            (link.row.planVoyageId !== followed.voyageId && voyageId !== followed.voyageId)
        )
            throw Error(
                'The current server-stamped route link is unavailable or differs from this phone. Keep the original route.',
            );
        const remaining = remainingReplanVias(original, oldCoords, fix!);
        if (!remaining)
            throw Error(
                'The remaining accepted route constraints are ambiguous. Open the full planner to review them.',
            );
        const dest = original.destinationCoordinates!;
        const constraints = resolveRouteConstraints(fix!, remaining.remaining, dest);
        if (!constraints) throw Error('The remaining waypoint constraints cannot be retained from this position.');
        const lons = [fix!.lon];
        for (const p of constraints.points.slice(1))
            lons.push(lons.at(-1)! + ((((p.lon - lons.at(-1)! + 180) % 360) + 360) % 360) - 180);
        const north = Math.max(...constraints.points.map((p) => p.lat)),
            south = Math.min(...constraints.points.map((p) => p.lat)),
            west = Math.min(...lons),
            east = Math.max(...lons);
        if (north - south > 20 || east - west > 20 || north > 83 || south < -83)
            throw Error('This re-plan exceeds the bounded regional forecast window. Open the full planner.');
        const { fetchModelWindGrid } = await import('../weather/OpenMeteoWindFetcher');
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), Math.max(1, deadlineMs - Date.now()));
        const wind = await withDeadline(
            fetchModelWindGrid(
                model.id,
                {
                    north: north + 2,
                    south: south - 2,
                    west: west - 2,
                    east: east + 2,
                },
                168,
                2,
                model.domain,
                abort.signal,
            ),
            Math.max(1, deadlineMs - Date.now()),
            'replan regional forecast',
        ).finally(() => {
            clearTimeout(timer);
            abort.abort();
        });
        if (!owns() || readRouteReplan().phase !== 'preparing') return;
        if (
            !wind?.refTime ||
            !Number.isFinite(Date.parse(wind.refTime)) ||
            [wind.u, wind.v, wind.speed, wind.gust ?? []].flat().reduce((n, a) => n + a.byteLength, 0) > 8 * 1024 * 1024
        )
            throw Error('A bounded time-stamped forecast is unavailable. The current route stays.');
        const now = Date.now(),
            departureTime = new Date(now).toISOString();
        if (!replanFixUsable(fix, now))
            throw Error('The position aged out while loading the forecast. Keep the original and try again.');
        const base: RouteReplanBase = {
            token,
            owner,
            boatId,
            voyageId,
            sessionId,
            followKey: originalFollowKey,
            settingsKey: originalSettingsKey,
            authority: replanAuthoritySnapshot(settings.settings),
            link: link.row,
            fix: fix!,
            departureTime,
            speed,
            deadlineMs,
            original,
            remainingConstraints: constraints.canonicalVias,
            oldCoords,
            remainingNm: remaining.remainingNm,
            oldRemainingHours:
                expectedArrivalMs !== null && Number.isFinite(expectedArrivalMs) && expectedArrivalMs > now
                    ? (expectedArrivalMs - now) / 3600000
                    : null,
            wind,
            model: model.id,
            sourceKey: JSON.stringify([model.domain, wind.refTime, now]),
            sourceLabel: `${model.label} via Open-Meteo · valid from ${wind.refTime} · fetched ${new Date(now).toISOString()}`,
        };
        requireReviewedCurrent(base);
        setRouteReplan({
            phase: 'computing',
            base,
            candidate: null,
            message: 'Comparing a candidate. The followed route stays unchanged.',
        });
        requestPassageMode(
            {
                departure: { lat: fix!.lat, lon: fix!.lon, name: 'Current position' },
                arrival: { ...dest, name: original.destination },
                via: constraints.canonicalVias.map((p, i) => ({ ...p, name: p.name ?? `VIA${i + 1}` })),
                departureTime,
                speed,
                replanToken: token,
            },
            owner,
        );
    } catch (error) {
        if (epoch === turn && isAuthIdentityScopeCurrent(owner) && readRouteReplan().phase === 'preparing')
            setRouteReplan({
                phase: 'error',
                base: null,
                candidate: null,
                message: error instanceof Error ? error.message : 'Re-plan unavailable. The original route stays.',
            });
    }
}

export function offerRouteReplanCandidate(token: string, candidate: RouteReplanCandidate): void {
    const state = readRouteReplan(),
        base = state.base;
    if (!base || base.token !== token || state.phase !== 'computing') return;
    const constraints = resolveRouteConstraints(
        base.fix,
        base.remainingConstraints ?? [],
        base.original.destinationCoordinates!,
    );
    if (
        !constraints ||
        !routeRetainsConstraints(candidate.result.route, constraints) ||
        !replanContextCurrent(base) ||
        Date.now() > base.deadlineMs ||
        !Number.isFinite(candidate.result.totalDurationHours) ||
        candidate.result.totalDurationHours <= 0 ||
        !Number.isFinite(candidate.result.totalDistanceNM) ||
        candidate.result.totalDistanceNM <= 0 ||
        !replanWindCovered(candidate.result, base.wind, Date.parse(base.departureTime))
    ) {
        setRouteReplan({
            ...state,
            phase: 'error',
            candidate: null,
            message:
                'The candidate lacks complete current forecast/geometry verification or its context changed. Keep the original route.',
        });
        return;
    }
    setRouteReplan({
        ...state,
        phase: 'ready',
        candidate: structuredClone(candidate),
        message: 'Review the new line beside the original. Nothing changes until you accept.',
    });
}

/** Explicit acceptance only; absent held RPC has no old-client/upsert fallback. */
export async function acceptRouteReplan(): Promise<boolean> {
    const state = readRouteReplan(),
        base = state.base,
        candidate = state.candidate;
    if (state.phase !== 'ready' || !base || !candidate) return false;
    setRouteReplan({ ...state, phase: 'accepting', message: 'Saving and checking the exact followed-route revision…' });
    try {
        requireReviewedCurrent(base);
        if (peekPassageRequest()?.replanToken !== base.token)
            throw Error('The displayed candidate changed. Re-plan again.');
        const fix = await acquireFreshOwnshipPosition({
            locationAccess: 'already-granted',
            timeoutSec: 8,
            maxGpsAgeMs: 30000,
        });
        requireReviewedCurrent(base);
        if (!replanFixUsable(fix, Date.now()) || haversineNm(base.fix.lat, base.fix.lon, fix!.lat, fix!.lon) > 0.1)
            throw Error('The boat has moved beyond this candidate’s start. Re-plan from her fresh position.');
        if ((await currentSession()) !== base.sessionId) throw Error('The sign-in session changed. Re-plan again.');
        requireReviewedCurrent(base);
        const points = candidate.result.routeCoordinates.map(([lon, lat]) => ({ lat, lon }));
        const plan: VoyagePlan = {
            origin: `Current position ${new Date(base.departureTime).toISOString()}`,
            destination: base.original.destination,
            departureDate: base.departureTime,
            originCoordinates: points[0],
            destinationCoordinates: points.at(-1)!,
            distanceApprox: `${candidate.result.totalDistanceNM} NM`,
            durationApprox: `${candidate.result.totalDurationHours} hours`,
            overview: 'Reviewed re-plan from the boat’s position',
            routeConstraints: structuredClone(base.remainingConstraints ?? []),
            waypoints: candidate.turns
                .slice(1, -1)
                .map((p) => ({ name: p.id, coordinates: { lat: p.lat, lon: p.lon } })),
            routeGeoJSON: {
                type: 'Feature',
                properties: { _source: 'explicit-follow-route' },
                geometry: { type: 'LineString', coordinates: structuredClone(candidate.result.routeCoordinates) },
            },
            __inshoreRouting: { status: 'success', caveats: candidate.caveats, cellsUsed: candidate.cells },
            sailingStats: candidate.result.sailingStats,
            routeComfort: candidate.result.comfort,
        };
        const { savePassagePlanToLogbook } = await import('../shiplog/PassagePlanSave');
        const planId = await withDeadline(savePassagePlanToLogbook(plan), 25000, 'reviewed replan save');
        requireReviewedCurrent(base);
        if (!planId || !supabase) throw Error('The candidate could not be saved. The original route stays.');
        const [newGeometryHash, expectedGeometryHash] = await Promise.all([
            geometryHash(candidate.result.routeCoordinates),
            geometryHash(base.oldCoords.map((p) => [p.lon, p.lat])),
        ]);
        requireReviewedCurrent(base);
        if (peekPassageRequest()?.replanToken !== base.token || readRouteReplan().base?.token !== base.token)
            throw Error('The displayed candidate changed. The original route stays.');
        const { data, error } = await withDeadline(
            Promise.resolve(
                supabase.rpc('accept_reviewed_route_replan', {
                    p_request_id: base.token,
                    p_boat_id: base.boatId,
                    p_voyage_id: base.voyageId,
                    p_expected_plan: base.link.planVoyageId,
                    p_expected_device: base.link.deviceId,
                    p_expected_updated_at: base.link.updatedAt,
                    p_plan: planId,
                    p_device: getDeviceId(),
                    p_device_name: getDeviceName(),
                    p_session_id: base.sessionId,
                    p_reviewed_at: base.departureTime,
                    p_fix_at: new Date(fix!.relay?.reportedAt ?? fix!.timestamp).toISOString(),
                    p_source_key: base.sourceKey,
                    p_plan_rows: plan.waypoints.length + 2,
                    p_geometry_sha256: newGeometryHash,
                    p_authority: base.authority,
                    p_expected_geometry_sha256: expectedGeometryHash,
                }),
            ),
            10000,
            'reviewed replan compare-and-swap',
        );
        requireCurrent(base);
        if (error || !data || typeof data !== 'object' || data.applied !== true)
            throw Error(
                'The server could not confirm this exact replacement. The original local route stays; check the current link before retrying.',
            );
        if (peekPassageRequest()?.replanToken !== base.token || readRouteReplan().base?.token !== base.token)
            throw Error('The review changed during confirmation. Read the current server route before following.');
        useFollowRouteStore.getState().startFollowing(plan, planId, points);
        markWrittenHere(base.voyageId, planId);
        setRouteReplan({ phase: 'idle', base: null, candidate: null, message: null });
        return true;
    } catch (error) {
        if (isAuthIdentityScopeCurrent(base.owner) && readRouteReplan().base?.token === base.token)
            setRouteReplan({
                ...state,
                phase: 'error',
                candidate: null,
                message:
                    error instanceof Error ? error.message : 'Replacement unconfirmed. The original local route stays.',
            });
        return false;
    }
}
export function dismissRouteReplan(): void {
    epoch++;
    cancelRouteReplan();
}
