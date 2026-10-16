import { jsonResponse, readResponseJsonObjectLimited } from '../_shared/http-security.ts';
import type { PiRelayIdentity } from '../_shared/pi-relay-auth.ts';
import { RADAR_RELAY_BATCH, RADAR_RELAY_KEY } from '../../../utils/radarRelayContract.ts';
import { parseRadarRelayRequest, type RadarRelayRequest, radarRelayUuid } from './radar-contract.ts';

export interface RadarRelayDeps {
    capability: () => Promise<boolean>;
    /** The single fixed service-role RPC owns context CAS, stale evidence and queue budget. */
    apply: (identity: PiRelayIdentity, request: RadarRelayRequest) => Promise<unknown>;
    deliver: (queueId: string) => void;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const answer = (body: unknown, status = 200) => jsonResponse(body, status, { 'Access-Control-Allow-Origin': '*' });
/** Runs only after the shared 8KiB reader and paired-Pi authentication. Probe never arms a source. */
export async function handleRadarRelay(
    body: Record<string, unknown>,
    identity: PiRelayIdentity,
    deps: RadarRelayDeps,
    now = Date.now(),
): Promise<Response> {
    const request = await parseRadarRelayRequest(body, identity, now);
    if (!request) return answer({ error: 'invalid_radar_request' }, 400);
    try {
        if (!await deps.capability()) {
            return request.action === 'probe'
                ? answer({
                    ok: true,
                    devices: 0,
                    radar: { v: 1, enabled: false },
                    contextRevision: null,
                    context: null,
                    retired: false,
                })
                : answer({ error: 'radar_unavailable' }, 503);
        }
        const result = await deps.apply(identity, request);
        if (!record(result)) return answer({ error: 'radar_unavailable' }, 503);
        if (result.conflict === true) return answer({ error: 'radar_context_conflict' }, 409);
        if (request.action === 'probe') {
            if (
                !Number.isSafeInteger(result.devices) || (result.devices as number) < 0 ||
                (result.devices as number) > 1000 ||
                !(result.contextRevision === null || radarRelayUuid(result.contextRevision)) ||
                typeof result.retired !== 'boolean'
            ) return answer({ error: 'radar_unavailable' }, 503);
            if (result.context !== null) {
                if (
                    !radarRelayUuid(result.contextRevision) ||
                    !await parseRadarRelayRequest(
                        { family: 'radar', action: 'bind', context: result.context, expectedContextRevision: null },
                        identity,
                        now,
                    )
                ) return answer({ error: 'radar_unavailable' }, 503);
            } else if (result.contextRevision !== null) return answer({ error: 'radar_unavailable' }, 503);
            return answer({
                ok: true,
                devices: result.devices,
                radar: { v: 1, enabled: true },
                contextRevision: result.contextRevision,
                context: result.context,
                retired: result.retired,
            });
        }
        if (
            !radarRelayUuid(result.contextRevision) ||
            (request.action === 'sync' && result.contextRevision !== request.contextRevision) ||
            (request.action === 'bind' && result.bound !== true) ||
            (request.action === 'retire' &&
                (result.retired !== true || result.contextRevision === request.contextRevision))
        ) return answer({ error: 'radar_unavailable' }, 503);
        const queued = request.action === 'bind' ? [] : result.queued,
            acked = request.action === 'bind' ? [] : result.acked;
        const requestedKeys = request.action === 'sync'
            ? new Set([...request.upserts, ...request.acks].map((e) => e.key))
            : new Set<string>();
        if (
            !Array.isArray(queued) || queued.length > RADAR_RELAY_BATCH || queued.some((id) => !radarRelayUuid(id)) ||
            !Array.isArray(acked) || acked.length > RADAR_RELAY_BATCH || acked.some((key) =>
                typeof key !== 'string' || !RADAR_RELAY_KEY.test(key) || !requestedKeys.has(key)
            ) ||
            (request.action === 'retire' && (queued.length !== 0 || acked.length !== 0))
        ) return answer({ error: 'radar_unavailable' }, 503);
        for (const id of new Set(queued)) deps.deliver(id);
        return answer({
            ok: true,
            radar: { v: 1, enabled: true },
            contextRevision: result.contextRevision,
            queued: queued.length,
            acked,
            ...(request.action === 'retire' ? { retired: true } : {}),
        });
    } catch {
        return answer({ error: 'radar_unavailable' }, 503);
    }
}
/** Both schema and configured sender must support the fixed family before the Pi can bind. */
export async function radarCapabilityReady(
    schema: () => Promise<unknown>,
    projectUrl: string | undefined,
    serviceKey: string | undefined,
    fetcher: typeof fetch = fetch,
): Promise<boolean> {
    if (!projectUrl || !serviceKey) return false;
    try {
        if (await schema() !== 1) return false;
        const base = new URL(projectUrl);
        if (
            base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
            (base.pathname !== '/' && base.pathname !== '')
        ) return false;
        const response = await fetcher(new URL('/functions/v1/send-push', base), {
            method: 'POST',
            headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'capabilities' }),
            signal: AbortSignal.timeout(3000),
            redirect: 'error',
            cache: 'no-store',
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return false;
        }
        return (await readResponseJsonObjectLimited(response, 1024))?.radar_alarm === 1;
    } catch {
        return false;
    }
}
