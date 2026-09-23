/** Isolated, authenticated trial requests. No route stores or persistence. */
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import {
    providerCheckSummary,
    providerFeatureFinding,
    snapshotProviderFindingDetails,
} from '../supabase/functions/_shared/autorouting-provider-check';
import { validateAutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';
import {
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS,
    AUTOROUTING_TRIAL_MAX_POINTS,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
    AUTOROUTING_TRIAL_MAX_SOURCE_BYTES,
    AUTOROUTING_TRIAL_MAX_WARNING_LENGTH,
    AUTOROUTING_TRIAL_MAX_WARNINGS,
    type AutoroutingTrialRequest,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
    type AutoroutingProviderCheck,
    type AutoroutingProviderFinding,
} from '../types/autorouting';

export type { AutoroutingTrialRequest, AutoroutingTrialRoute, AutoroutingTrialStatus } from '../types/autorouting';

const UNAVAILABLE = 'The autorouting trial is unavailable. No route has been activated.';
const AUTH_REQUIRED = 'Sign in to use the autorouting trial.';
const INVALID_RESPONSE = 'The trial returned an unreadable route. No route has been activated.';
const TIMED_OUT = 'The trial request timed out. Please try again.';
const PROFILE_UNSUPPORTED =
    'Auto routing cannot use the stored vessel profile on this server yet. No route has been requested.';
const PROFILE_INVALID = 'Check the stored vessel dimensions and draft in Vessel settings before calculating.';
const HTTP_FAILURE_MESSAGES: Readonly<Record<number, string>> = {
    400: 'The routing service rejected this request. Check the positions and vessel settings. No route has been activated.',
    401: AUTH_REQUIRED,
    403: 'This account cannot access the autorouting trial. No route has been activated.',
    429: 'The autorouting request limit has been reached. Please wait before trying again. No route has been activated.',
    502: 'The routing provider could not complete this request. No route has been activated.',
    503: 'The routing service is temporarily unavailable. Please try again later. No route has been activated.',
    504: TIMED_OUT,
};
const PROVIDER_FAILURE_CODES = new Set([
    'AR_TOKEN_HTTP',
    'AR_TOKEN_PAYLOAD',
    'AR_ROUTE_HTTP',
    'AR_ROUTE_PAYLOAD',
    'AR_ROUTE_INVALID',
    'AR_PROVIDER_NETWORK',
]);

/** Only locally selected copy can leave the request boundary. */
class TrialRequestError extends Error {}

/** Optional support reference, not provider prose. Bound bytes and time even
 * when a failing service returns a huge body or never closes its stream. */
async function readFailureReference(response: Response, signal: AbortSignal): Promise<string | null> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        if (signal.aborted || response.bodyUsed || !response.body) return null;
        reader = response.body.getReader();
        const read = async () => {
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
                const { value, done } = await reader!.read();
                if (signal.aborted) return null;
                if (done) break;
                // Fetch bytes can originate in another realm (including a
                // WebView bridge), so avoid a realm-specific instanceof test.
                if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1 || chunks.length >= 64) return null;
                size += value.byteLength;
                if (size > 1_024) return null;
                chunks.push(value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
            if (!record(data) || typeof data.code !== 'string') return null;
            if (response.status === 502 && PROVIDER_FAILURE_CODES.has(data.code)) return data.code;
            if (response.status === 504 && data.code === 'AR_TIMEOUT') return 'AR_TIMEOUT';
            return null;
        };
        const stopped = new Promise<null>((resolve) => {
            onAbort = () => resolve(null);
            signal.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(() => resolve(null), 1_000);
        });
        return await Promise.race([read(), stopped]);
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        // A broken stream must not hold up cancellation or keep buffering.
        try {
            void reader?.cancel().catch(() => undefined);
        } catch {
            /* No transport details leave this boundary. */
        }
    }
}

async function invocationFailure(error: unknown, signal: AbortSignal): Promise<TrialRequestError> {
    try {
        // Do not trust arbitrary SDK messages, plain objects or error getters.
        // The installed SDK supplies its actual fetch Response as context.
        if (!(error instanceof FunctionsHttpError) || !(error.context instanceof Response)) {
            return new TrialRequestError(UNAVAILABLE);
        }
        const response: Response = error.context;
        const status = response.status;
        if (!Number.isInteger(status) || status < 400 || status > 599) return new TrialRequestError(UNAVAILABLE);
        const message = HTTP_FAILURE_MESSAGES[status];
        if (!message) return new TrialRequestError(UNAVAILABLE);
        const reference =
            response.status === 502 || response.status === 504 ? await readFailureReference(response, signal) : null;
        return new TrialRequestError(reference ? `${message} Reference: ${reference}.` : message);
    } catch {
        return new TrialRequestError(UNAVAILABLE);
    }
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const finiteWithin = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function validPoint(value: unknown): value is { lat: number; lon: number } {
    return record(value) && finiteWithin(value.lat, -90, 90) && finiteWithin(value.lon, -180, 180);
}

function distinctPosition(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
    const radians = Math.PI / 180;
    const h =
        Math.sin(((b.lat - a.lat) * radians) / 2) ** 2 +
        Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(((b.lon - a.lon) * radians) / 2) ** 2;
    return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h))) >= 1;
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

/** Read old and new server replies without allowing absent/inconsistent
 * metadata to hide an unsafe finding still present in the original payload. */
function snapshotProviderCheck(data: Record<string, unknown>): AutoroutingProviderCheck | undefined {
    const findings: AutoroutingProviderFinding[] = [];
    const text = (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0 && value.length <= AUTOROUTING_TRIAL_MAX_WARNING_LENGTH;
    const add = (finding: AutoroutingProviderFinding) => {
        if (
            !text(finding.message) ||
            (finding.featureType !== undefined && !text(finding.featureType)) ||
            (finding.providerSeverity !== undefined && !text(finding.providerSeverity)) ||
            !Number.isSafeInteger(finding.featureIndex) ||
            finding.featureIndex < 0 ||
            finding.featureIndex >= AUTOROUTING_TRIAL_MAX_POINTS
        )
            throw new Error(INVALID_RESPONSE);
        const details = snapshotProviderFindingDetails(finding);
        if (!details) throw new Error(INVALID_RESPONSE);
        const existing = findings.find((f) => f.featureIndex === finding.featureIndex && f.message === finding.message);
        if (existing) {
            if (finding.severity === 'danger') existing.severity = 'danger';
            if (!existing.geometry && details.geometry) existing.geometry = details.geometry;
            if (!existing.provenance && details.provenance) existing.provenance = details.provenance;
        } else
            findings.push({
                featureIndex: finding.featureIndex,
                ...(finding.featureType !== undefined ? { featureType: finding.featureType } : {}),
                ...(finding.providerSeverity !== undefined ? { providerSeverity: finding.providerSeverity } : {}),
                severity: finding.severity,
                message: finding.message,
                ...details,
            });
        if (findings.length > AUTOROUTING_TRIAL_MAX_WARNINGS) throw new Error(INVALID_RESPONSE);
    };
    const check = data.providerCheck;
    if (check !== undefined) {
        if (
            !record(check) ||
            !['unsafe', 'caution', 'not-reported'].includes(check.status as string) ||
            !Array.isArray(check.findings) ||
            check.findings.length > AUTOROUTING_TRIAL_MAX_WARNINGS
        ) {
            throw new Error(INVALID_RESPONSE);
        }
        for (const finding of check.findings) {
            if (!record(finding) || !['danger', 'caution'].includes(finding.severity as string)) {
                throw new Error(INVALID_RESPONSE);
            }
            add(finding as unknown as AutoroutingProviderFinding);
        }
        if (providerCheckSummary(findings).status !== check.status) throw new Error(INVALID_RESPONSE);
    }
    if (validSource(data.source)) {
        let geo: unknown;
        try {
            geo = JSON.parse(data.source.geoJson);
        } catch {
            /* Legacy source can be opaque; never infer clearance. */
        }
        if (record(geo) && geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
            if (geo.features.length > AUTOROUTING_TRIAL_MAX_POINTS) throw new Error(INVALID_RESPONSE);
            for (let index = 0; index < geo.features.length; index++) {
                const feature = geo.features[index];
                if (!record(feature) || !record(feature.properties)) throw new Error(INVALID_RESPONSE);
                let finding: AutoroutingProviderFinding | null;
                try {
                    finding = providerFeatureFinding(feature.properties, index, feature.geometry);
                } catch {
                    throw new Error(INVALID_RESPONSE);
                }
                if (finding) add(finding);
            }
        }
    }
    // Earliest servers retained only these exact formatted reports. Ordinary
    // advisory prose is not parsed as a clearance claim or a located hazard.
    for (const warning of data.warnings as string[]) {
        const match =
            /^Provider check feature ([1-9]\d*)( \(unsafe\))?: (.*)\. Review the original checker output before use\.$/.exec(
                warning,
            );
        if (!match) continue;
        const featureIndex = Number(match[1]) - 1;
        const known = findings.find((finding) => finding.featureIndex === featureIndex);
        // Original source/new metadata carries the provider's real severity;
        // an old type:'danger' string alone must not upgrade Info or Warning.
        if (known && (!match[2] || known.severity === 'danger')) continue;
        const featureType = match[3].split(' · ')[0];
        add({
            featureIndex,
            ...(featureType ? { featureType } : {}),
            severity: match[2] || /danger|obstruction|hazard/i.test(featureType) ? 'danger' : 'caution',
            message: warning,
        });
    }
    return check !== undefined || findings.length ? providerCheckSummary(findings) : undefined;
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
    let vesselProfile;
    if (request.vesselProfile !== undefined) {
        try {
            vesselProfile = validateAutoroutingVesselProfile(request.vesselProfile);
            if (vesselProfile.draftStatus === 'missing') throw new Error(PROFILE_INVALID);
        } catch {
            throw new Error(PROFILE_INVALID);
        }
    }
    const constraints = request.chartTrackConstraints;
    if (
        constraints !== undefined &&
        (!Array.isArray(constraints) ||
            constraints.length < 1 ||
            constraints.length > AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS ||
            !Array.from(constraints).every(
                (point) => validPoint(point) && Object.keys(point).every((key) => key === 'lat' || key === 'lon'),
            ) ||
            !constraints.every((point, index) =>
                [request.departure, request.destination, ...constraints.slice(0, index)].every((other) =>
                    distinctPosition(point, other),
                ),
            ))
    )
        throw new Error(
            `Choose 1–${AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS} distinct chart-track positions, different from the endpoints.`,
        );
    return {
        departure: { lat: request.departure.lat, lon: request.departure.lon },
        destination: { lat: request.destination.lat, lon: request.destination.lon },
        draftM: request.draftM,
        speedKts: request.speedKts,
        ...(vesselProfile ? { vesselProfile } : {}),
        ...(constraints ? { chartTrackConstraints: constraints.map(({ lat, lon }) => ({ lat, lon })) } : {}),
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
            throw new TrialRequestError(AUTH_REQUIRED);
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
        if (error) {
            const failure = await Promise.race([invocationFailure(error, controller.signal), aborted]);
            assertCurrent();
            throw failure;
        }
        return data;
    } catch (error) {
        if (controller.signal.aborted) throw timedOut ? new Error(TIMED_OUT) : abortError();
        if (error instanceof TrialRequestError) throw error;
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
            (data.channelGuidance !== undefined && typeof data.channelGuidance !== 'boolean') ||
            (data.channelGuidance === true && (!data.enabled || !data.ready)) ||
            (data.vesselProfile !== undefined && typeof data.vesselProfile !== 'boolean') ||
            (data.vesselProfile === true && (!data.enabled || !data.ready)) ||
            (data.message !== undefined && (typeof data.message !== 'string' || data.message.length > 500))
        ) {
            throw new Error(UNAVAILABLE);
        }
        return {
            enabled: data.enabled,
            ready: data.ready,
            ...(typeof data.channelGuidance === 'boolean' ? { channelGuidance: data.channelGuidance } : {}),
            ...(typeof data.vesselProfile === 'boolean' ? { vesselProfile: data.vesselProfile } : {}),
            ...(typeof data.message === 'string' ? { message: data.message } : {}),
        };
    } catch (error) {
        // DOMException is not an Error in every WebView/realm.
        if (record(error) && error.name === 'AbortError') throw error;
        // Network/auth/malformed status never enables an unauthorised trial.
        return {
            enabled: false,
            ready: false,
            message:
                error instanceof TrialRequestError || (error instanceof Error && error.message === AUTH_REQUIRED)
                    ? error.message
                    : UNAVAILABLE,
        };
    }
}

export async function calculateAutoroutingTrial(
    request: AutoroutingTrialRequest,
    signal?: AbortSignal,
): Promise<AutoroutingTrialRoute> {
    const scope = getAuthIdentityScope();
    const input = snapshotRequest(request);
    if (input.vesselProfile) {
        const status = await getAutoroutingTrialStatus(signal);
        if (!isAuthIdentityScopeCurrent(scope)) throw abortError();
        if (!status.enabled || !status.ready || status.vesselProfile !== true) throw new Error(PROFILE_UNSUPPORTED);
    }
    const data = await invokeTrial({ action: 'calculate', ...input }, signal);
    if (!isAuthIdentityScopeCurrent(scope)) throw abortError();
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
    const providerCheck = snapshotProviderCheck(data);
    let vesselProfile;
    if (input.vesselProfile || data.vesselProfile !== undefined) {
        try {
            vesselProfile = validateAutoroutingVesselProfile(data.vesselProfile);
            // Explicit acknowledgement protects against an older/mixed deployment
            // silently omitting dimensions after a successful capability probe.
            if (!input.vesselProfile || JSON.stringify(vesselProfile) !== JSON.stringify(input.vesselProfile)) {
                throw new Error(INVALID_RESPONSE);
            }
        } catch {
            throw new Error(INVALID_RESPONSE);
        }
    }
    return {
        id: data.id,
        coordinates,
        warnings: [...data.warnings],
        ...(providerCheck ? { providerCheck } : {}),
        createdAt: data.createdAt,
        provider: 'SevenCs',
        ...(vesselProfile ? { vesselProfile } : {}),
        ...(validSource(data.source) ? { source: { rtz: data.source.rtz, geoJson: data.source.geoJson } } : {}),
    };
}
