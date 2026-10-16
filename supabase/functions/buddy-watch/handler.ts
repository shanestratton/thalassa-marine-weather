import {
    emptyBuddyState,
    evaluateBuddy,
    parseBuddyConfiguration,
    parseBuddyFacts,
    parseBuddyState,
} from '../../../utils/buddyWatch.ts';
import { jsonResponse, readResponseTextLimited, requireServiceRolePost } from '../_shared/http-security.ts';
interface Environment {
    get(name: string): string | undefined;
}
export interface BuddyDependencies {
    work(after: string | null): Promise<unknown>;
    apply(
        id: string,
        revision: string,
        stateRevision: string | null,
        facts: unknown,
        result: unknown,
    ): Promise<unknown>;
    finish(success: boolean): Promise<void>;
    now(): number;
}
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
/** Eight bounded pages, no provider/network acquisition. Cursor order must be strict. */
export async function runBuddyWatch(deps: BuddyDependencies): Promise<{ complete: boolean; checked: number }> {
    const started = deps.now();
    let after: string | null = null, checked = 0;
    try {
        for (let page = 0; page < 8; page++) {
            if (deps.now() - started >= 16_000) throw new Error('Work deadline');
            const rows = await deps.work(after);
            if (!Array.isArray(rows) || rows.length > 32) throw new Error('Held or invalid work');
            for (const value of rows) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid work row');
                const r = value as Record<string, unknown>;
                if (
                    !uuid(r.id) || !uuid(r.revision) || (r.stateRevision !== null && !uuid(r.stateRevision)) ||
                    (after !== null && r.id <= after) || Object.keys(r).some((k) =>
                        !['id', 'revision', 'configuration', 'stateRevision', 'state', 'facts'].includes(k)
                    )
                ) {
                    throw new Error('Invalid work identity');
                }
                const config = parseBuddyConfiguration(r.configuration),
                    state = r.state === null ? emptyBuddyState() : parseBuddyState(r.state),
                    facts = r.facts === null ? null : parseBuddyFacts(r.facts);
                if (
                    !config?.enabled || !state || (r.facts !== null && !facts) ||
                    (r.state === null) !== (r.stateRevision === null)
                ) {
                    throw new Error('Invalid fixed evidence');
                }
                if (deps.now() - started >= 16_000) {
                    throw new Error('Work deadline');
                }
                const result = evaluateBuddy(state, facts, config.area, deps.now());
                const applied = await deps.apply(r.id, r.revision, r.stateRevision as string | null, facts, result);
                if (applied !== true && applied !== false) {
                    throw new Error('Invalid commit result');
                }
                after = r.id;
                checked++;
            }
            if (rows.length < 32) {
                await deps.finish(true);
                return { complete: true, checked };
            }
        }
    } catch { /* Failed/over-cap work never advertises readiness. */ }
    await deps.finish(false).catch(() => undefined);
    return { complete: false, checked };
}
export function buddyDependencies(env: Environment, fetcher = fetch): BuddyDependencies {
    const root = new URL(env.get('SUPABASE_URL') ?? 'http://invalid'), key = env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (
        root.protocol !== 'https:' || root.username || root.password || root.pathname !== '/' || root.search ||
        root.hash || !key
    ) throw new Error('Database configuration');
    const headers = { authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' };
    async function rpc(name: string, body: unknown) {
        const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000);
        try {
            const response = await fetcher(new URL(`/rest/v1/rpc/${name}`, root), {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                redirect: 'error',
                signal: abort.signal,
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Database unavailable');
            }
            const text = await readResponseTextLimited(response, 128_000);
            if (text === null) throw new Error('Bounded response required');
            return text.trim() ? JSON.parse(text) : null;
        } finally {
            clearTimeout(timer);
        }
    }
    return {
        now: Date.now,
        work: (after) => rpc('buddy_watch_work', { p_after: after, p_limit: 32 }),
        apply: (id, revision, stateRevision, facts, result) =>
            rpc('buddy_watch_apply', {
                p_id: id,
                p_revision: revision,
                p_state_revision: stateRevision,
                p_facts: facts,
                p_result: result,
            }),
        finish: async (success) => {
            await rpc('buddy_watch_finish', { p_success: success });
        },
    };
}
export function createBuddyWatchHandler(env: Environment, deps?: BuddyDependencies) {
    return async (request: Request) => {
        const refusal = requireServiceRolePost(request, env.get('SUPABASE_SERVICE_ROLE_KEY'));
        if (refusal) return refusal;
        try {
            if (new URL(request.url).search) return jsonResponse({ error: 'No parameters' }, 400);
            const body = await readResponseTextLimited(new Response(request.body), 128);
            if (body === null || (body.trim() && body.trim() !== '{}')) {
                return jsonResponse({ error: 'Empty object required' }, 400);
            }
            const result = await runBuddyWatch(deps ?? buddyDependencies(env));
            return jsonResponse({ schema: 1, ...result }, result.complete ? 200 : 503);
        } catch {
            return jsonResponse({ error: 'Buddy watch unavailable' }, 503);
        }
    };
}
