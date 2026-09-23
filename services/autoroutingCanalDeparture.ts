/** Local canal departure + authenticated SevenCs continuation. No route-store
 * writes, server settings, navigation activation or straight-line fallbacks. */
import type { FeatureCollection } from 'geojson';
import type { AutoroutingTrialRequest, AutoroutingTrialRoute } from '../types/autorouting';
import {
    AUTOROUTING_TRIAL_MAX_POINTS,
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
} from '../types/autorouting';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import { calculateAutoroutingTrial } from './autoroutingTrial';
import { fetchMapboxWater, tilesForBbox, MAPBOX_WATER_ZOOM } from './mapboxWater';
import { supabase } from './supabase';
import {
    canalDepartureBbox,
    canalDistanceM,
    canalSegmentsInWater,
    validateCanalGateCentres,
    type CanalPoint,
    type CanalDepartureGeometry,
    type buildCanalDepartureGeometry,
} from './canalDepartureGeometry';

const abortError = () => new DOMException('Canal calculation cancelled.', 'AbortError');

/** Resolved by the verified channel-profile boundary, never guessed by this
 * geometry adapter from the nearest or farthest buoy. */
export interface CanalChannelConstraints {
    gateCentres: CanalPoint[];
    outboundBearingDeg: number;
    profileId: string;
    sourceRevision: string;
}

/** A route may not cross the final gate then double back into the channel.
 * Check actual provider vertices and the interpolated first 30 m of travel;
 * don't rotate, snap or substitute any provider geometry to make it pass. */
export function canalContinuationHeadsOutward(
    coordinates: AutoroutingTrialRoute['coordinates'],
    exit: CanalPoint,
    outboundBearingDeg: number,
): boolean {
    if (!Number.isFinite(outboundBearingDeg) || outboundBearingDeg < 0 || outboundBearingDeg >= 360) return false;
    const bearing = (outboundBearingDeg * Math.PI) / 180;
    const longitudeMetres = 111_320 * Math.cos((exit.lat * Math.PI) / 180);
    const projection = (p: [number, number]) =>
        (p[0] - exit.lon) * longitudeMetres * Math.sin(bearing) + (p[1] - exit.lat) * 111_320 * Math.cos(bearing);
    const first = coordinates[0];
    if (!first || !first.every(Number.isFinite) || projection(first) < -2) return false;
    let travelled = 0;
    let advance = 0;
    for (let i = 1; i < coordinates.length && travelled < 30; i++) {
        const from = coordinates[i - 1],
            to = coordinates[i];
        if (![...from, ...to].every(Number.isFinite)) return false;
        const distance = canalDistanceM({ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] });
        if (distance < 0.000001) continue;
        const fraction = Math.min(1, (30 - travelled) / distance);
        const along = (projection(to) - projection(from)) * fraction;
        if (along < -0.000001) return false;
        advance += along;
        travelled += distance * fraction;
    }
    // A zero-length or entirely sideways continuation does not leave the gate.
    return travelled >= 20 && advance > 0.01;
}

/** A dedicated, disposable worker per attempt: abort terminates compute. Never
 * fall back to running this solver on the iOS UI thread. */
export function runCanalDepartureWorker(
    args: Parameters<typeof buildCanalDepartureGeometry>,
    signal: AbortSignal,
): Promise<CanalDepartureGeometry> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try {
            worker = new Worker(new URL('./canalDepartureWorker.ts', import.meta.url), { type: 'module' });
        } catch {
            reject(new Error('Canal routing is unavailable on this device. Plot the canal section manually.'));
            return;
        }
        let finished = false;
        const finish = (error?: Error, result?: CanalDepartureGeometry) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            worker.terminate();
            if (error) reject(error);
            else resolve(result!);
        };
        const cancel = () => finish(abortError());
        const timer = setTimeout(() => finish(new Error('Canal calculation timed out. Try a closer exit.')), 20_000);
        signal.addEventListener('abort', cancel, { once: true });
        worker.onerror = () => finish(new Error('Canal routing stopped. No substitute route was drawn.'));
        worker.onmessage = ({ data }: MessageEvent<{ error?: string; result?: CanalDepartureGeometry }>) => {
            if (data.result) finish(undefined, data.result);
            else finish(new Error(data.error || 'Canal routing returned no path.'));
        };
        try {
            worker.postMessage(args);
        } catch {
            finish(new Error('Canal map is too large to process.'));
        }
    });
}

/** Provider payload stays exact and applies ONLY to the SevenCs continuation.
 * Never silently move a provider endpoint or bridge a large handover gap. */
export function joinCanalDeparture(
    local: CanalDepartureGeometry,
    route: AutoroutingTrialRoute,
    channel?: CanalChannelConstraints,
): AutoroutingTrialRoute {
    const exit = local.coordinates.at(-1)!;
    const first = route.coordinates[0];
    if (!first || canalDistanceM({ lon: exit[0], lat: exit[1] }, { lon: first[0], lat: first[1] }) > 2)
        throw new Error('SevenCs did not start at Canal exit. Move the exit farther into open water and recalculate.');
    if (
        channel &&
        !canalContinuationHeadsOutward(route.coordinates, { lon: exit[0], lat: exit[1] }, channel.outboundBearingDeg)
    )
        throw new Error(
            'The SevenCs continuation turns back into the marked exit channel. No route has been substituted.',
        );
    if (!canalSegmentsInWater([exit, ...route.coordinates], local.grid, true))
        throw new Error(
            'The SevenCs continuation could not be confirmed in mapped unobstructed water near the canal. Move Canal exit farther out.',
        );
    const same = first[0] === exit[0] && first[1] === exit[1];
    const coordinates = [...local.coordinates, ...route.coordinates.slice(same ? 1 : 0)].map(
        (p) => [...p] as [number, number],
    );
    if (coordinates.length > AUTOROUTING_TRIAL_MAX_POINTS) throw new Error('Combined trial has too many waypoints.');
    return {
        ...route,
        coordinates,
        canalDeparture: { handoverIndex: local.coordinates.length - 1 },
        warnings: [
            ...route.warnings,
            'Thalassa canal section uses mapped water shape, not surveyed depth. Check depth, tide, bridges and local obstructions before use.',
        ],
    };
}

export async function calculateWithCanalDeparture(
    request: AutoroutingTrialRequest,
    exit: CanalPoint,
    token: string,
    signal: AbortSignal,
    onProgress: (message: string) => void,
    channel?: CanalChannelConstraints,
    calculateProvider: typeof calculateAutoroutingTrial = calculateAutoroutingTrial,
): Promise<AutoroutingTrialRoute> {
    const input = {
        ...request,
        departure: { ...request.departure },
        destination: { ...request.destination },
        ...(request.vesselProfile ? { vesselProfile: structuredClone(request.vesselProfile) } : {}),
        ...(request.chartTrackConstraints
            ? { chartTrackConstraints: request.chartTrackConstraints.map((position) => ({ ...position })) }
            : {}),
    };
    if (
        ![input.destination.lat, input.destination.lon, input.draftM, input.speedKts].every(Number.isFinite) ||
        Math.abs(input.destination.lat) > 90 ||
        Math.abs(input.destination.lon) > 180 ||
        input.draftM <= 0 ||
        input.draftM > AUTOROUTING_TRIAL_MAX_DRAFT_M ||
        input.speedKts <= 0 ||
        input.speedKts > AUTOROUTING_TRIAL_MAX_SPEED_KTS
    )
        throw new Error('Check the destination and vessel preferences before calculating.');
    const handover = { ...exit };
    const scope = getAuthIdentityScope();
    const client = supabase;
    if (!scope.userId || !client) throw new Error('Sign in to use the autorouting trial.');
    const bbox = canalDepartureBbox(input.departure, handover);
    validateCanalGateCentres(handover, bbox, channel?.gateCentres);
    if (
        channel &&
        (!Array.isArray(channel.gateCentres) ||
            !Number.isFinite(channel.outboundBearingDeg) ||
            channel.outboundBearingDeg < 0 ||
            channel.outboundBearingDeg >= 360 ||
            typeof channel.profileId !== 'string' ||
            !channel.profileId.trim() ||
            channel.profileId.length > 200 ||
            typeof channel.sourceRevision !== 'string' ||
            !channel.sourceRevision.trim() ||
            channel.sourceRevision.length > 200)
    )
        throw new Error('The verified channel exit profile is incomplete. Plot this exit manually.');
    const resolvedChannel = channel
        ? {
              gateCentres: channel.gateCentres.map((gate) => ({ ...gate })),
              outboundBearingDeg: channel.outboundBearingDeg,
              profileId: channel.profileId,
              sourceRevision: channel.sourceRevision,
          }
        : undefined;
    if (canalDistanceM(handover, input.destination) < 20) throw new Error('Choose a destination beyond Canal exit.');
    if (tilesForBbox(bbox, MAPBOX_WATER_ZOOM).length > 48)
        throw new Error('Canal map area is too large. Choose a closer exit.');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    const unsubscribe = subscribeAuthIdentityScope(cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const assertCurrent = () => {
        if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw abortError();
    };
    const timer = setTimeout(() => {
        timedOut = true;
        cancel();
    }, 85_000);
    let rejectAborted!: (e: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
        rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(abortError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const progress = (text: string) => {
        assertCurrent();
        onProgress(text);
    };
    const work = async () => {
        assertCurrent();
        progress('Loading canal water and obstacles…');
        // Pin the SAME account's bearer across the fresh obstacle lookup. Do
        // not use the legacy fail-quiet empty overlay / old-schema disk fallback.
        const { data, error } = await client.auth.getSession().catch(() => {
            throw new Error('Sign in again before calculating the canal departure.');
        });
        assertCurrent();
        if (error || data.session?.user.id !== scope.userId || !data.session.access_token)
            throw new Error('Sign in again before calculating the canal departure.');
        const [water, overlayResult, bridgeResponse] = await Promise.all([
            fetchMapboxWater(bbox, token, { requireComplete: true }),
            client.functions
                .invoke('osm-overlay', {
                    body: { bbox: bbox.join(',') },
                    headers: { Authorization: `Bearer ${data.session.access_token}` },
                    signal: controller.signal,
                })
                .catch(() => {
                    throw new Error('Canal obstacle detail is unavailable. Please try again.');
                }),
            fetch('/notices/bridges-au.json', { signal: controller.signal }).catch(() => {
                throw new Error('Canal bridge detail is unavailable.');
            }),
        ]);
        assertCurrent();
        const overlay = overlayResult.data;
        const fields = ['berths', 'breakwater', 'aeroway', 'reef'] as const;
        if (
            overlayResult.error ||
            overlayResult.response?.headers.get('X-Overlay-Cache') === 'error' ||
            !overlay ||
            !fields.every((k) => overlay[k]?.type === 'FeatureCollection' && Array.isArray(overlay[k].features)) ||
            // The deployed legacy edge function returns HTTP 200 + all-empty
            // collections on upstream failure. Empty is NOT a clearance pass.
            !['water', 'canalLines', 'berths', 'coastline', 'marina', 'breakwater'].some(
                (k) => Array.isArray(overlay[k]?.features) && overlay[k].features.length > 0,
            ) ||
            !water.features.length
        )
            throw new Error('Canal water or obstacle detail is unavailable. No route has been substituted.');
        if (!bridgeResponse.ok) throw new Error('Canal bridge detail is unavailable. Plot this section manually.');
        const bridges = await bridgeResponse.json().catch(() => {
            throw new Error('Canal bridge detail is unreadable.');
        });
        assertCurrent();
        if (!Array.isArray(bridges.bridges)) throw new Error('Canal bridge detail is unreadable.');
        const obstacles: FeatureCollection = {
            type: 'FeatureCollection',
            features: fields.flatMap((k) => overlay[k].features),
        };
        // For this geometry-only connector, every known fixed bridge is blocked:
        // neither an unknown mast height nor an estimated clearance grants passage.
        for (const bridge of bridges.bridges) {
            if (!Array.isArray(bridge.span) || bridge.span.length < 2)
                throw new Error('Canal bridge detail is incomplete.');
            if (
                bridge.span.some(
                    (p: number[]) =>
                        p[0] >= bbox[0] - 0.01 &&
                        p[0] <= bbox[2] + 0.01 &&
                        p[1] >= bbox[1] - 0.01 &&
                        p[1] <= bbox[3] + 0.01,
                )
            )
                obstacles.features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: bridge.span },
                });
        }
        if (!canalGeometryWithinBudget(water, obstacles))
            throw new Error('Canal geometry is too large. Choose a closer exit.');
        progress(resolvedChannel ? 'Following the verified channel marker gates…' : 'Finding a connected canal exit…');
        const local = await runCanalDepartureWorker(
            [input.departure, handover, bbox, water, obstacles, resolvedChannel?.gateCentres],
            controller.signal,
        );
        assertCurrent();
        if (resolvedChannel) {
            let index = -1;
            for (const gate of resolvedChannel.gateCentres) {
                index = local.coordinates.findIndex((p, i) => i > index && p[0] === gate.lon && p[1] === gate.lat);
                if (index < 0)
                    throw new Error(
                        'The local route did not preserve every verified marker gate. No route has been substituted.',
                    );
            }
        }
        progress('Calculating SevenCs from Canal exit…');
        // Optional chart guidance runs only on the provider continuation. The
        // exact canal gates and the water/outbound/seam checks still apply to
        // the chosen result; no guided line may bypass this join boundary.
        const route = await calculateProvider({ ...input, departure: handover }, controller.signal);
        assertCurrent();
        return joinCanalDeparture(local, route, resolvedChannel);
    };
    try {
        return await Promise.race([work(), aborted]);
    } catch (e) {
        if (timedOut) throw new Error('Canal trial timed out. Check the connection and try again.');
        if (controller.signal.aborted) throw abortError();
        throw e;
    } finally {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
    }
}

/** Bound structured cloning and worker input without stringify-ing an oversized
 * response on the UI thread. Unsupported or malformed geometries fail closed. */
export function canalGeometryWithinBudget(...collections: FeatureCollection[]): boolean {
    let weight = 0;
    const walk = (coordinates: unknown, depth = 0): boolean => {
        if (!Array.isArray(coordinates) || depth > 3 || ++weight > 100_000) return false;
        if (typeof coordinates[0] === 'number')
            return (
                coordinates.length >= 2 &&
                Number.isFinite(coordinates[0]) &&
                Number.isFinite(coordinates[1]) &&
                Math.abs(coordinates[0]) <= 180 &&
                Math.abs(coordinates[1]) <= 85
            );
        for (const child of coordinates) if (!walk(child, depth + 1)) return false;
        return coordinates.length > 0;
    };
    for (const fc of collections)
        for (const f of fc.features) {
            if (++weight > 100_000 || !f?.geometry || !('coordinates' in f.geometry) || !walk(f.geometry.coordinates))
                return false;
        }
    return true;
}
