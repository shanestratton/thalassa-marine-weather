/** Isolated, authenticated trial requests. No route stores or persistence. */
import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import {
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_POINTS,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
    AUTOROUTING_TRIAL_MAX_SOURCE_BYTES,
    AUTOROUTING_TRIAL_MAX_WARNING_LENGTH,
    AUTOROUTING_TRIAL_MAX_WARNINGS,
    type AutoroutingTrialRequest,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
} from '../types/autorouting';

export type { AutoroutingTrialRequest, AutoroutingTrialRoute, AutoroutingTrialStatus } from '../types/autorouting';

const UNAVAILABLE = 'The autorouting trial is unavailable. No route has been activated.';
const AUTH_REQUIRED = 'Sign in to use the autorouting trial.';
const INVALID_RESPONSE = 'The trial returned an unreadable route. No route has been activated.';
const TIMED_OUT = 'The trial request timed out. Please try again.';

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const finiteWithin = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function validPoint(value: unknown): value is { lat: number; lon: number } {
    return record(value) && finiteWithin(value.lat, -90, 90) && finiteWithin(value.lon, -180, 180);
}

function validSource(value: unknown): value is { rtz: string; geoJson: string } {
    if (
        !record(value) ||
        typeof value.rtz !== 'string' ||
        !value.rtz.trim() ||
        typeof value.geoJson !== 'string' ||
        !value.geoJson.trim() ||
        value.rtz.length + value.geoJson.length > AUTOROUTING_TRIAL_MAX_SOURCE_BYTES
    )
        return false;
    const encoder = new TextEncoder();
    return (
        encoder.encode(value.rtz).byteLength + encoder.encode(value.geoJson).byteLength <=
        AUTOROUTING_TRIAL_MAX_SOURCE_BYTES
    );
}

function snapshotRequest(request: AutoroutingTrialRequest): AutoroutingTrialRequest {
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
    return {
        departure: { lat: request.departure.lat, lon: request.departure.lon },
        destination: { lat: request.destination.lat, lon: request.destination.lon },
        draftM: request.draftM,
        speedKts: request.speedKts,
    };
}

function abortError(): DOMException {
    return new DOMException('The trial request was cancelled or the account changed.', 'AbortError');
}

async function invokeTrial(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const scope = getAuthIdentityScope();
    const client = supabase;
    if (!client || !scope.userId) throw new Error(AUTH_REQUIRED);

    const controller = new AbortController();
    let timedOut = false;
    let rejectAborted!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(timedOut ? new Error(TIMED_OUT) : abortError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    const unsubscribe = subscribeAuthIdentityScope(() => {
        if (!isAuthIdentityScopeCurrent(scope)) controller.abort();
    });
    const timeout = setTimeout(
        () => {
            timedOut = true;
            controller.abort();
        },
        body.action === 'status' ? 15_000 : 45_000,
    );
    const assertCurrent = () => {
        if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw abortError();
    };

    try {
        // Pin the request to this session's bearer rather than allowing a later
        // auth-token change to send the old account's coordinates as a new user.
        // The Edge Function still verifies authentication and trial entitlement.
        const sessionResult = await Promise.race([client.auth.getSession(), aborted]);
        assertCurrent();
        const session = sessionResult.data.session;
        if (sessionResult.error || session?.user.id !== scope.userId || !session.access_token) {
            throw new Error(AUTH_REQUIRED);
        }
        const { data, error } = await Promise.race([
            client.functions.invoke('autorouting-trial', {
                body,
                headers: { Authorization: `Bearer ${session.access_token}` },
                signal: controller.signal,
            }),
            aborted,
        ]);
        assertCurrent();
        if (error) throw new Error(UNAVAILABLE);
        return data;
    } catch (error) {
        if (controller.signal.aborted) throw timedOut ? new Error(TIMED_OUT) : abortError();
        if (error instanceof Error && [AUTH_REQUIRED, UNAVAILABLE].includes(error.message)) throw error;
        // Never expose SDK/provider details, URLs, bearer values or raw payloads.
        throw new Error(UNAVAILABLE);
    } finally {
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener('abort', onCallerAbort);
        controller.signal.removeEventListener('abort', onAbort);
    }
}

export async function getAutoroutingTrialStatus(signal?: AbortSignal): Promise<AutoroutingTrialStatus> {
    try {
        const data = await invokeTrial({ action: 'status' }, signal);
        if (
            !record(data) ||
            typeof data.enabled !== 'boolean' ||
            typeof data.ready !== 'boolean' ||
            (!data.enabled && data.ready) ||
            (data.message !== undefined && (typeof data.message !== 'string' || data.message.length > 500))
        ) {
            throw new Error(UNAVAILABLE);
        }
        return {
            enabled: data.enabled,
            ready: data.ready,
            ...(typeof data.message === 'string' ? { message: data.message } : {}),
        };
    } catch (error) {
        // DOMException is not an Error in every WebView/realm.
        if (record(error) && error.name === 'AbortError') throw error;
        // Network/auth/malformed status never enables an unauthorised trial.
        return {
            enabled: false,
            ready: false,
            message: error instanceof Error && error.message === AUTH_REQUIRED ? AUTH_REQUIRED : UNAVAILABLE,
        };
    }
}

export async function calculateAutoroutingTrial(
    request: AutoroutingTrialRequest,
    signal?: AbortSignal,
): Promise<AutoroutingTrialRoute> {
    const input = snapshotRequest(request);
    const data = await invokeTrial({ action: 'calculate', ...input }, signal);
    if (
        !record(data) ||
        data.provider !== 'SevenCs' ||
        typeof data.id !== 'string' ||
        !data.id.trim() ||
        data.id.length > 200 ||
        typeof data.createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.createdAt) ||
        !Number.isFinite(Date.parse(data.createdAt)) ||
        !Array.isArray(data.coordinates) ||
        data.coordinates.length < 2 ||
        data.coordinates.length > AUTOROUTING_TRIAL_MAX_POINTS ||
        !Array.isArray(data.warnings) ||
        (data.source !== undefined && !validSource(data.source)) ||
        data.warnings.length > AUTOROUTING_TRIAL_MAX_WARNINGS ||
        !data.warnings.every(
            (warning) =>
                typeof warning === 'string' &&
                warning.trim().length > 0 &&
                warning.length <= AUTOROUTING_TRIAL_MAX_WARNING_LENGTH,
        )
    ) {
        throw new Error(INVALID_RESPONSE);
    }
    const coordinates: [number, number][] = [];
    for (const pair of data.coordinates) {
        if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !finiteWithin(pair[0], -180, 180) ||
            !finiteWithin(pair[1], -90, 90)
        ) {
            throw new Error(INVALID_RESPONSE);
        }
        coordinates.push([pair[0], pair[1]]);
    }
    if (coordinates.every(([lon, lat]) => lon === coordinates[0][0] && lat === coordinates[0][1])) {
        throw new Error(INVALID_RESPONSE);
    }
    return {
        id: data.id,
        coordinates,
        warnings: [...data.warnings],
        createdAt: data.createdAt,
        provider: 'SevenCs',
        ...(validSource(data.source) ? { source: { rtz: data.source.rtz, geoJson: data.source.geoJson } } : {}),
    };
}
