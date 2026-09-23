import { jsonResponse } from './http-security.ts';
import {
    type AutoroutingVesselProfile,
    autoroutingVesselWarnings,
    validateAutoroutingVesselProfile,
} from './autorouting-vessel.ts';
import {
    type AutoroutingProviderFinding,
    providerCheckSummary,
    providerFeatureFinding,
} from './autorouting-provider-check.ts';

// These endpoints are deliberately not configurable or accepted from callers.
export const SEVENCS_ROUTE_URL = 'https://aws-rnw-03.chartworld.com/api/route';
export const SEVENCS_TOKEN_URL =
    'https://cw-authentication.chartworld.com/realms/ChartWorld/protocol/openid-connect/token';
export const TRIAL_PROVIDER_TIMEOUT_MS = 35_000;
export const TRIAL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const TRIAL_MAX_CHART_TRACK_CONSTRAINTS = 8;
const MAX_POINTS = 10_000;
const MAX_WARNINGS = 100;
const MAX_WARNING_LENGTH = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNAVAILABLE = 'The autorouting trial is unavailable. No route has been activated.';
const PROVIDER_FAILED = 'The provider could not return a complete trial route. No route has been activated.';
const WARNINGS = [
    'Trial proposal only: not approved, saved or activated for navigation. Check current charts, notices and local conditions.',
    'Requested draft plus a fixed 0.5 m under-keel clearance in every water area; no tide credit. Weather optimisation is disabled.',
];
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Point = { lat: number; lon: number };
type Coordinates = [number, number];
export interface TrialRouteInput {
    departure: Point;
    destination: Point;
    draftM: number;
    speedKts: number;
    vesselProfile?: AutoroutingVesselProfile;
    chartTrackConstraints?: Point[];
}
export interface TrialDependencies {
    env: (name: string) => string | undefined;
    authorize: (req: Request, bucket: string, limit: number, seconds: number) => Promise<{ userId: string } | Response>;
    fetch: typeof fetch;
    now?: () => number;
}

// Fixed support codes only. Never return provider status text, response bodies,
// credentials, request positions or raw exceptions as diagnostics.
type TrialSupportCode =
    | 'AR_TOKEN_HTTP'
    | 'AR_TOKEN_PAYLOAD'
    | 'AR_ROUTE_HTTP'
    | 'AR_ROUTE_PAYLOAD'
    | 'AR_ROUTE_INVALID'
    | 'AR_PROVIDER_NETWORK'
    | 'AR_TIMEOUT';
type ProviderStage = 'token-fetch' | 'token-payload' | 'route-fetch' | 'route-payload' | 'route-validation';

class TrialError extends Error {
    constructor(readonly status: number, message: string, readonly code?: TrialSupportCode) {
        super(message);
    }
}

function supportCode(error: unknown, stage: ProviderStage | null): TrialSupportCode | undefined {
    if (error instanceof TrialError) {
        if (error.code) return error.code;
        if (error.status === 504) return 'AR_TIMEOUT';
        // Access can change during provider work. Do not mislabel its rejection
        // as a provider failure or expose any additional entitlement details.
        if (error.status !== 502) return undefined;
    }
    if (stage === 'token-fetch' || stage === 'route-fetch') return 'AR_PROVIDER_NETWORK';
    if (stage === 'token-payload') return 'AR_TOKEN_PAYLOAD';
    if (stage === 'route-payload') return 'AR_ROUTE_PAYLOAD';
    if (stage === 'route-validation') return 'AR_ROUTE_INVALID';
    return undefined;
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const numberIn = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const validPoint = (value: unknown): value is Point =>
    record(value) && numberIn(value.lat, -90, 90) && numberIn(value.lon, -180, 180) &&
    Object.keys(value).every((key) => key === 'lat' || key === 'lon');

export function validateTrialInput(body: Record<string, unknown>): TrialRouteInput {
    if (
        !Object.keys(body).every((key) =>
            ['action', 'departure', 'destination', 'draftM', 'speedKts', 'chartTrackConstraints', 'vesselProfile']
                .includes(key)
        ) ||
        !validPoint(body.departure) || !validPoint(body.destination) ||
        !numberIn(body.draftM, Number.MIN_VALUE, 30) || !numberIn(body.speedKts, Number.MIN_VALUE, 100) ||
        distanceM([body.departure.lon, body.departure.lat], body.destination) < 1
    ) throw new TrialError(400, 'Enter different valid endpoints, a positive draft and a positive cruising speed.');
    let vesselProfile;
    if (body.vesselProfile !== undefined) {
        try {
            vesselProfile = validateAutoroutingVesselProfile(body.vesselProfile);
            if (vesselProfile.draftStatus === 'missing') throw new Error('Missing draft.');
        } catch {
            throw new TrialError(
                400,
                'Check the stored vessel dimensions and draft in Vessel settings before calculating.',
            );
        }
    }
    const constraints = body.chartTrackConstraints;
    if (
        constraints !== undefined &&
        (!Array.isArray(constraints) || constraints.length < 1 ||
            constraints.length > TRIAL_MAX_CHART_TRACK_CONSTRAINTS || ![...constraints].every(validPoint) ||
            !constraints.every((point, index) =>
                [body.departure as Point, body.destination as Point, ...constraints.slice(0, index)].every((other) =>
                    distanceM([point.lon, point.lat], other) >= 1
                )
            ))
    ) throw new TrialError(400, 'Choose 1–8 distinct chart-track positions, different from the endpoints.');
    return {
        departure: { ...body.departure },
        destination: { ...body.destination },
        draftM: body.draftM,
        speedKts: body.speedKts,
        ...(vesselProfile ? { vesselProfile } : {}),
        ...(Array.isArray(constraints)
            ? { chartTrackConstraints: constraints.map(({ lat, lon }) => ({ lat, lon })) }
            : {}),
    };
}

export function buildSevenCsRequest(input: TrialRouteInput, now: number) {
    const profile = input.vesselProfile;
    return {
        departure: { position: `${input.departure.lat} ${input.departure.lon}` },
        arrival: { position: `${input.destination.lat} ${input.destination.lon}` },
        // RNW API 3.3.2.29: mustGo visits these GeoCoordinate positions in
        // consecutive order. No caller RTZ, geometry, cost or profile override.
        ...(input.chartTrackConstraints?.length
            ? {
                mustGo: input.chartTrackConstraints.map((point, index) => ({
                    position: `${point.lat} ${point.lon}`,
                    id: index,
                    name: `Chart track ${index + 1}`,
                })),
            }
            : {}),
        // RNW 3.3.2.29: vessel.length/beam and safety.airDraft are metres.
        // Missing is omitted, never translated into the documented zero defaults.
        // Thalassa's measurement statuses are retained in our response only.
        vessel: {
            type: 'Yacht',
            ...(profile && profile.length.status !== 'missing' ? { length: profile.length.valueM } : {}),
            ...(profile && profile.beam.status !== 'missing' ? { beam: profile.beam.valueM } : {}),
        },
        safety: {
            draft: input.draftM,
            ...(profile && profile.airDraft.status !== 'missing' ? { airDraft: profile.airDraft.valueM } : {}),
            clearance: { berthing: 0.5, confined: 0.5, coastal: 0.5, openSea: 0.5 },
        },
        schedule: {
            etd: new Date(now).toISOString(),
            speed: { sea: input.speedKts, river: input.speedKts, berthing: Math.min(3, input.speedKts) },
        },
        finalizing: {
            routeCleanerSimplified: true,
            routeCleanerXTD: true,
            splitGreatCircle: true,
            confinedWaterFinder: true,
            openSeaFinder: true,
            radioCallingPointFinder: true,
            routeExpander: true,
            routeScheduler: true,
            restrictionChecker: true,
            routeChecker: true,
            minSpotSoundingFinder: true,
            routeFinalizer: true,
            weatherOptimization: false,
            calculateVoyage: false,
        },
    };
}

function trialAccess(deps: TrialDependencies, userId: string, now: number) {
    const rawIds = deps.env('SEVENCS_TRIAL_USER_IDS') ?? '';
    const ids = rawIds.split(',').map((id) => id.trim());
    const expiry = deps.env('SEVENCS_TRIAL_EXPIRES_AT') ?? '';
    const expiresAt = ISO_TIME.test(expiry) ? Date.parse(expiry) : NaN;
    const enabled = deps.env('SEVENCS_TRIAL_ENABLED') === 'true' &&
        ids.length <= 100 && ids.every((id) => UUID.test(id)) && ids.includes(userId) &&
        Number.isFinite(expiresAt) && expiresAt > now;
    const clientId = deps.env('SEVENCS_CLIENT_ID') ?? '';
    const clientSecret = deps.env('SEVENCS_CLIENT_SECRET') ?? '';
    return { enabled, ready: enabled && !!clientId.trim() && !!clientSecret.trim(), clientId, clientSecret };
}

async function bounded<T>(milliseconds: number, upstream: AbortSignal, task: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => rejectAbort = reject);
    const onAbort = () => {
        controller.abort();
        rejectAbort(new TrialError(504, 'The trial request timed out or was cancelled. No route has been activated.'));
    };
    upstream.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, milliseconds);
    try {
        if (upstream.aborted) {
            onAbort();
            return await aborted;
        }
        return await Promise.race([aborted, task(controller.signal)]);
    } finally {
        clearTimeout(timer);
        upstream.removeEventListener('abort', onAbort);
    }
}

async function readJsonLimited(source: Request | Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
    const failure = new TrialError(
        source instanceof Request ? 400 : 502,
        source instanceof Request ? 'The trial request must be a small JSON object.' : PROVIDER_FAILED,
    );
    const declaredLength = Number(source.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes || !source.body) {
        void source.body?.cancel().catch(() => undefined);
        throw failure;
    }
    const reader = source.body.getReader();
    const onAbort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                void reader.cancel().catch(() => undefined);
                throw failure;
            }
            chunks.push(value);
        }
        if (signal.aborted) throw failure;
    } finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw failure;
    }
}

function responseJson(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
    httpCode: 'AR_TOKEN_HTTP' | 'AR_ROUTE_HTTP',
): Promise<unknown> {
    if (!response.ok || response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new TrialError(502, PROVIDER_FAILED, httpCode);
    }
    return readJsonLimited(response, maxBytes, signal);
}

function distanceM(a: Coordinates, b: Point) {
    const radians = Math.PI / 180;
    const deltaLat = (b.lat - a[1]) * radians;
    const deltaLon = (b.lon - a[0]) * radians;
    const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b.lat * radians) *
            Math.sin(deltaLon / 2) ** 2;
    return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Validate every feature, not just the visible track, before retaining the source. */
function validateGeometry(geometry: unknown): void {
    if (!record(geometry)) throw new TrialError(502, PROVIDER_FAILED);
    const depths: Record<string, number> = {
        Point: 0,
        MultiPoint: 1,
        LineString: 1,
        MultiLineString: 2,
        Polygon: 2,
        MultiPolygon: 3,
    };
    if (typeof geometry.type !== 'string' || !Object.hasOwn(depths, geometry.type)) {
        throw new TrialError(502, PROVIDER_FAILED);
    }
    const walk = (value: unknown, depth: number): void => {
        if (!Array.isArray(value) || value.length === 0) throw new TrialError(502, PROVIDER_FAILED);
        if (depth === 0) {
            if (value.length !== 2 || !numberIn(value[0], -180, 180) || !numberIn(value[1], -90, 90)) {
                throw new TrialError(502, PROVIDER_FAILED);
            }
        } else for (const child of value) walk(child, depth - 1);
    };
    walk(geometry.coordinates, depths[geometry.type]);
    const line = (points: Coordinates[], ring = false) => {
        if (
            points.length < (ring ? 4 : 2) || (ring &&
                (points[0][0] !== points.at(-1)![0] || points[0][1] !== points.at(-1)![1]))
        ) {
            throw new TrialError(502, PROVIDER_FAILED);
        }
    };
    if (geometry.type === 'LineString') line(geometry.coordinates as Coordinates[]);
    if (geometry.type === 'MultiLineString') {
        for (const points of geometry.coordinates as Coordinates[][]) line(points);
    }
    if (geometry.type === 'Polygon') {
        for (const ring of geometry.coordinates as Coordinates[][]) line(ring, true);
    }
    if (geometry.type === 'MultiPolygon') {
        for (const polygon of geometry.coordinates as Coordinates[][][]) for (const ring of polygon) line(ring, true);
    }
}

export function parseSevenCsResult(result: unknown, input: TrialRouteInput, now: number) {
    if (
        !record(result) || result.success !== true || !Number.isSafeInteger(result.id) || (result.id as number) <= 0 ||
        typeof result.geoJson !== 'string' || !result.geoJson.trim() ||
        typeof result.rtz !== 'string' || !result.rtz.trim() ||
        result.geoJson.length > TRIAL_MAX_RESPONSE_BYTES || result.rtz.length > TRIAL_MAX_RESPONSE_BYTES
    ) throw new TrialError(502, PROVIDER_FAILED);
    if (
        new TextEncoder().encode(result.rtz).byteLength + new TextEncoder().encode(result.geoJson).byteLength >
            TRIAL_MAX_RESPONSE_BYTES
    ) throw new TrialError(502, PROVIDER_FAILED);
    let geo: unknown;
    try {
        geo = JSON.parse(result.geoJson);
    } catch {
        throw new TrialError(502, PROVIDER_FAILED);
    }
    if (
        !record(geo) || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features) ||
        geo.features.length === 0 || geo.features.length > MAX_POINTS
    ) throw new TrialError(502, PROVIDER_FAILED);
    const suppliedWarnings = result.userWarnings ?? [];
    if (
        !Array.isArray(suppliedWarnings) ||
        !suppliedWarnings.every((warning) =>
            typeof warning === 'string' && warning.trim().length > 0 && warning.length <= MAX_WARNING_LENGTH
        )
    ) throw new TrialError(502, PROVIDER_FAILED);
    const warnings: string[] = [...WARNINGS, ...autoroutingVesselWarnings(input.vesselProfile), ...suppliedWarnings];
    const findings: AutoroutingProviderFinding[] = [];
    const coordinates: Coordinates[] = [];
    for (let index = 0; index < geo.features.length; index++) {
        const feature = geo.features[index];
        if (!record(feature) || feature.type !== 'Feature' || !record(feature.properties)) {
            throw new TrialError(502, PROVIDER_FAILED);
        }
        validateGeometry(feature.geometry);
        const geometry = feature.geometry as Record<string, unknown>;
        const properties = feature.properties;
        let finding: AutoroutingProviderFinding | null;
        try {
            finding = providerFeatureFinding(properties, index, feature.geometry);
        } catch {
            throw new TrialError(502, PROVIDER_FAILED);
        }
        if (finding) {
            if (finding.message.length > MAX_WARNING_LENGTH) throw new TrialError(502, PROVIDER_FAILED);
            warnings.push(finding.message);
            findings.push(finding);
        }
        if (properties.type !== 'track') continue;
        if (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString') {
            throw new TrialError(502, PROVIDER_FAILED);
        }
        const pieces =
            (geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates) as Coordinates[][];
        for (const piece of pieces) {
            if (piece.length < 2) throw new TrialError(502, PROVIDER_FAILED);
            const previous = coordinates.at(-1);
            if (previous && (previous[0] !== piece[0][0] || previous[1] !== piece[0][1])) {
                // Never invent the missing leg, reorder parts, snap or decimate.
                throw new TrialError(502, PROVIDER_FAILED);
            }
            if (coordinates.length + piece.length - (previous ? 1 : 0) > MAX_POINTS) {
                throw new TrialError(502, PROVIDER_FAILED);
            }
            coordinates.push(...piece.slice(previous ? 1 : 0));
        }
    }
    if (
        coordinates.length < 2 ||
        coordinates.every((point) => point[0] === coordinates[0][0] && point[1] === coordinates[0][1])
    ) {
        throw new TrialError(502, PROVIDER_FAILED);
    }
    const departureOffset = distanceM(coordinates[0], input.departure);
    const destinationOffset = distanceM(coordinates.at(-1)!, input.destination);
    if (departureOffset > 250 || destinationOffset > 250) throw new TrialError(502, PROVIDER_FAILED);
    if (departureOffset > 5) {
        warnings.push(
            `Provider route starts ${
                Math.round(departureOffset)
            } m from the requested departure. No connecting leg has been added.`,
        );
    }
    if (destinationOffset > 5) {
        warnings.push(
            `Provider route ends ${
                Math.round(destinationOffset)
            } m from the requested destination. No connecting leg has been added.`,
        );
    }
    if (warnings.length > MAX_WARNINGS) throw new TrialError(502, PROVIDER_FAILED);
    return {
        id: String(result.id),
        provider: 'SevenCs' as const,
        createdAt: new Date(now).toISOString(),
        coordinates,
        warnings,
        ...(input.vesselProfile ? { vesselProfile: validateAutoroutingVesselProfile(input.vesselProfile) } : {}),
        providerCheck: providerCheckSummary(findings),
        source: { rtz: result.rtz, geoJson: result.geoJson },
    };
}

/** The only persistent process state is the short-lived provider bearer, never routes. */
export function createAutoroutingTrialHandler(deps: TrialDependencies) {
    const now = deps.now ?? Date.now;
    let cachedToken: { value: string; expiresAt: number; clientId: string; clientSecret: string } | null = null;
    return async (req: Request): Promise<Response> => {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405, { ...CORS, Allow: 'POST' });
        let providerStage: ProviderStage | null = null;
        try {
            const body = await bounded(5_000, req.signal, (signal) => readJsonLimited(req, 4_096, signal));
            if (!record(body) || (body.action !== 'status' && body.action !== 'calculate')) {
                throw new TrialError(400, 'A valid trial action is required.');
            }
            const status = body.action === 'status';
            const caller = await deps.authorize(
                req,
                status ? 'autorouting_trial_status' : 'autorouting_trial_calculate',
                status ? 120 : 12,
                3_600,
            );
            if (caller instanceof Response) {
                const headers = new Headers(caller.headers);
                for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
                return new Response(caller.body, { status: caller.status, headers });
            }
            const access = trialAccess(deps, caller.userId, now());
            if (status) {
                return jsonResponse(
                    {
                        enabled: access.enabled,
                        ready: access.ready,
                        ...(access.ready ? { channelGuidance: true, vesselProfile: true } : {}),
                        message: access.ready
                            ? 'Private autorouting trial available. Proposals are not activated for navigation.'
                            : UNAVAILABLE,
                    },
                    200,
                    CORS,
                );
            }
            if (!access.enabled) throw new TrialError(403, UNAVAILABLE);
            if (!access.ready) throw new TrialError(503, UNAVAILABLE);
            const input = validateTrialInput(body);
            const route = await bounded(TRIAL_PROVIDER_TIMEOUT_MS, req.signal, async (signal) => {
                const requireCurrentAccess = () => {
                    if (signal.aborted) throw new TrialError(504, PROVIDER_FAILED);
                    const current = trialAccess(deps, caller.userId, now());
                    if (
                        !current.ready || current.clientId !== access.clientId ||
                        current.clientSecret !== access.clientSecret
                    ) {
                        throw new TrialError(403, UNAVAILABLE);
                    }
                };
                requireCurrentAccess();
                let token = cachedToken;
                if (
                    !token || token.expiresAt <= now() || token.clientId !== access.clientId ||
                    token.clientSecret !== access.clientSecret
                ) {
                    providerStage = 'token-fetch';
                    const reply = await deps.fetch(SEVENCS_TOKEN_URL, {
                        method: 'POST',
                        redirect: 'error',
                        signal,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                        body: new URLSearchParams({
                            grant_type: 'client_credentials',
                            client_id: access.clientId,
                            client_secret: access.clientSecret,
                        }),
                    });
                    providerStage = 'token-payload';
                    const data = await responseJson(reply, 32_768, signal, 'AR_TOKEN_HTTP');
                    if (
                        !record(data) || typeof data.access_token !== 'string' || !data.access_token ||
                        data.access_token.length > 24_000 ||
                        /\s/.test(data.access_token) || typeof data.token_type !== 'string' ||
                        data.token_type.toLowerCase() !== 'bearer' ||
                        !Number.isInteger(data.expires_in) || !numberIn(data.expires_in, 1, 86_400)
                    ) {
                        throw new TrialError(502, PROVIDER_FAILED);
                    }
                    requireCurrentAccess();
                    token = {
                        value: data.access_token,
                        expiresAt: now() + Math.max(0, data.expires_in - 30) * 1_000,
                        clientId: access.clientId,
                        clientSecret: access.clientSecret,
                    };
                    cachedToken = token;
                }
                requireCurrentAccess();
                providerStage = 'route-fetch';
                const response = await deps.fetch(SEVENCS_ROUTE_URL, {
                    method: 'POST',
                    redirect: 'error',
                    signal,
                    headers: {
                        Authorization: `Bearer ${token.value}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(buildSevenCsRequest(input, now())),
                });
                providerStage = 'route-payload';
                const result = await responseJson(response, TRIAL_MAX_RESPONSE_BYTES, signal, 'AR_ROUTE_HTTP');
                requireCurrentAccess();
                providerStage = 'route-validation';
                return parseSevenCsResult(result, input, now());
            });
            return jsonResponse(route, 200, CORS);
        } catch (error) {
            const code = supportCode(error, providerStage);
            return jsonResponse(
                { error: error instanceof TrialError ? error.message : PROVIDER_FAILED, ...(code ? { code } : {}) },
                error instanceof TrialError ? error.status : 502,
                CORS,
            );
        }
    };
}
