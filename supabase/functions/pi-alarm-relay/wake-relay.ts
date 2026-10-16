import { jsonResponse, readResponseJsonObjectLimited } from '../_shared/http-security.ts';
import type { PiRelayIdentity } from '../_shared/pi-relay-auth.ts';
import { parseWakeRelayRequest, WAKE_EVENT_KEY, type WakeRelayRequest, wakeRelayUuid } from './wake-contract.ts';

export interface WakeRelayDeps {
    capability: () => Promise<boolean>;
    /** One fixed RPC, no arbitrary caller-supplied method/table/path. */
    apply: (identity: PiRelayIdentity, request: WakeRelayRequest) => Promise<unknown>;
    deliver: (queueId: string) => void;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const answer = (value: unknown, status = 200) => jsonResponse(value, status, { 'Access-Control-Allow-Origin': '*' });
/** Called only after the existing authenticated paired-Pi door and 8KiB reader. */
export async function handleWakeRelay(
    body: Record<string, unknown>,
    identity: PiRelayIdentity,
    deps: WakeRelayDeps,
    now = Date.now(),
): Promise<Response> {
    const request = await parseWakeRelayRequest(body, identity, now);
    if (!request) return answer({ error: 'invalid_wake_request' }, 400);
    try {
        const enabled = await deps.capability();
        if (!enabled) {
            return request.action === 'probe'
                ? answer({
                    ok: true,
                    devices: 0,
                    wake: { v: 1, enabled: false },
                    contextRevision: null,
                    context: null,
                    retired: false,
                })
                : answer({ error: 'wake_unavailable' }, 503);
        }
        const result = await deps.apply(identity, request);
        if (!record(result)) return answer({ error: 'wake_unavailable' }, 503);
        if (result.conflict === true) return answer({ error: 'wake_context_conflict' }, 409);
        if (request.action === 'probe') {
            if (
                !Number.isSafeInteger(result.devices) || (result.devices as number) < 0 ||
                (result.devices as number) > 1000 ||
                !(result.contextRevision === null || wakeRelayUuid(result.contextRevision)) ||
                typeof result.retired !== 'boolean'
            ) return answer({ error: 'wake_unavailable' }, 503);
            if (result.context !== null) {
                if (
                    !wakeRelayUuid(result.contextRevision) ||
                    !await parseWakeRelayRequest(
                        { family: 'wake', action: 'bind', context: result.context, expectedContextRevision: null },
                        identity,
                        now,
                    )
                ) return answer({ error: 'wake_unavailable' }, 503);
            } else if (result.contextRevision !== null) return answer({ error: 'wake_unavailable' }, 503);
            return answer({
                ok: true,
                devices: result.devices,
                wake: { v: 1, enabled: true },
                contextRevision: result.contextRevision,
                context: result.context,
                retired: result.retired,
            });
        }
        if (
            !wakeRelayUuid(result.contextRevision) ||
            (request.action === 'sync' && result.contextRevision !== request.contextRevision) ||
            (request.action === 'bind' && result.bound !== true) ||
            (request.action === 'retire' &&
                (result.retired !== true || result.contextRevision === request.contextRevision))
        ) return answer({ error: 'wake_unavailable' }, 503);
        const queued = request.action === 'bind' ? [] : result.queued,
            acked = request.action === 'bind' ? [] : result.acked;
        if (
            !Array.isArray(queued) || queued.length > 8 || queued.some((id) => !wakeRelayUuid(id)) ||
            !Array.isArray(acked) || acked.length > 8 || acked.some((key) =>
                typeof key !== 'string' || !WAKE_EVENT_KEY.test(key)
            )
        ) return answer({ error: 'wake_unavailable' }, 503);
        for (const id of new Set(queued)) deps.deliver(id);
        return answer({
            ok: true,
            wake: { v: 1, enabled: true },
            contextRevision: result.contextRevision,
            queued: queued.length,
            acked,
            ...(request.action === 'retire' ? { retired: true } : {}),
        });
    } catch {
        return answer({ error: 'wake_unavailable' }, 503);
    }
}
/** Both separately reviewed deployed halves must prove their exact capability. No attempted push. */
export async function wakeCapabilityReady(
    schema: () => Promise<unknown>,
    projectUrl: string | undefined,
    serviceKey: string | undefined,
    fetcher: typeof fetch = fetch,
): Promise<boolean> {
    if (!projectUrl || !serviceKey) return false;
    try {
        if (await schema() !== 1) return false;
        const base = new URL(projectUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return false;
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
        return (await readResponseJsonObjectLimited(response, 1024))?.wake_alarm === 1;
    } catch {
        return false;
    }
}
