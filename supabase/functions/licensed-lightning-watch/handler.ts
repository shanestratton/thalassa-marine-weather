import { jsonResponse, readResponseTextLimited, requireServiceRolePost } from '../_shared/http-security.ts';
import { handleLicensedLightning, type LightningPorts } from '../licensed-lightning/handler.ts';
import { lightningPosition, parseLicensedLightning } from '../../../services/weather/api/licensedLightningContract.ts';
export interface LightningWork {
    boat_id: string;
    revision: string;
    lease: string;
    position_revision: string;
    position_at: number;
    latitude: number;
    longitude: number;
}
export interface LightningWatchPorts {
    now(): number;
    work(signal: AbortSignal): Promise<unknown>;
    current(row: LightningWork, signal: AbortSignal): Promise<unknown>;
    claim(
        row: LightningWork,
        pulse: { id: string; lat: number; lon: number; time: number },
        signal: AbortSignal,
    ): Promise<unknown>;
    licensed: LightningPorts;
}
const uuid = (v: unknown) =>
    typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function parseWork(value: unknown, now: number): LightningWork[] {
    if (!Array.isArray(value) || value.length > 8) throw Error('Work unavailable');
    const seen = new Set<string>();
    for (const row of value) {
        if (
            !object(row) ||
            Object.keys(row).sort().join(',') !==
                'boat_id,latitude,lease,longitude,position_at,position_revision,revision' ||
            ![row.boat_id, row.revision, row.lease, row.position_revision].every(uuid) ||
            !lightningPosition(row.latitude, row.longitude) || !Number.isSafeInteger(row.position_at) ||
            (row.position_at as number) > now || now - (row.position_at as number) >= 120_000 ||
            seen.has(row.boat_id as string)
        ) throw Error('Work unavailable');
        seen.add(row.boat_id as string);
    }
    return value as LightningWork[];
}
/** Service-only worker. No user coordinates, provider URLs, pagination, retry or all-clear push. */
export function createLightningWatchHandler(
    serviceKey: () => string | undefined,
    createPorts: () => LightningWatchPorts,
) {
    return async (request: Request): Promise<Response> => {
        const denied = requireServiceRolePost(request, serviceKey());
        if (denied) return denied;
        const abort = new AbortController(), cancel = () => abort.abort();
        request.signal.addEventListener('abort', cancel, { once: true });
        if (request.signal.aborted) cancel();
        const timer = setTimeout(cancel, 30_000);
        try {
            if (new URL(request.url).search) return jsonResponse({ error: 'No query parameters' }, 400);
            const body = await readResponseTextLimited(new Response(request.body), 256);
            if (body === null || (body.trim() && body.trim() !== '{}')) {
                return jsonResponse({ error: 'Empty object required' }, 400);
            }
            if (abort.signal.aborted) return jsonResponse({ error: 'Watch unavailable' }, 503);
            const ports = createPorts();
            const license = ports.licensed.admission();
            if (!license || !license.display || !license.push || license.expiresAt <= ports.now()) {
                return jsonResponse({ error: 'Licensed watch unavailable' }, 503);
            }
            const rows = parseWork(await ports.work(abort.signal), ports.now());
            let reads = 0, claimed = 0;
            for (const row of rows) {
                abort.signal.throwIfAborted();
                const current = async () => !abort.signal.aborted && await ports.current(row, abort.signal) === true;
                if (!await current()) continue;
                const runtime = ports.licensed;
                const response = await handleLicensedLightning(
                    new Request('https://internal.invalid/licensed-lightning', {
                        method: 'POST',
                        body: JSON.stringify({ latitude: row.latitude, longitude: row.longitude }),
                        signal: abort.signal,
                    }),
                    {
                        ...runtime,
                        // The outer exact service credential plus a one-use current
                        // database lease supplies authority, never a fabricated user JWT.
                        authorize: async () => await current() ? null : new Response(null, { status: 410 }),
                        reserve: async () => await runtime.reserve() && await current(),
                        fetch: async (input, init) => {
                            if (!await current()) throw Error('Watch retired');
                            reads++;
                            return await runtime.fetch(input, init);
                        },
                    },
                );
                if (response.status !== 200) {
                    await response.body?.cancel();
                    continue;
                }
                const text = await readResponseTextLimited(response, 512 * 1024);
                if (text === null || abort.signal.aborted) throw Error('Watch unavailable');
                const snapshot = parseLicensedLightning(JSON.parse(text), row.latitude, row.longitude, ports.now());
                if (!snapshot || !await current()) continue;
                const admitted = runtime.admission();
                if (
                    !admitted || admitted.expiresAt !== license.expiresAt || admitted.clientId !== license.clientId ||
                    admitted.secret !== license.secret || !admitted.push || !admitted.display ||
                    admitted.expiresAt <= ports.now()
                ) continue;
                const pulse = snapshot.pulses[0];
                if (pulse && await ports.claim(row, pulse, abort.signal) === true) claimed++;
            }
            return jsonResponse({ schema: 1, work: rows.length, reads, claimed }, 200);
        } catch {
            return jsonResponse({ error: 'Licensed watch unavailable' }, 503);
        } finally {
            clearTimeout(timer);
            abort.abort();
            request.signal.removeEventListener('abort', cancel);
        }
    };
}
