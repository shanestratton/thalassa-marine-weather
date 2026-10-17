import { createLightningWatchHandler, type LightningWatchPorts, type LightningWork } from './handler.ts';
import { lightningRuntime } from '../licensed-lightning/runtime.ts';
import { readResponseTextLimited } from '../_shared/http-security.ts';

function dependencies(): LightningWatchPorts {
    const origin = new URL(Deno.env.get('SUPABASE_URL') ?? '');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (
        !key || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
        origin.search || origin.hash
    ) throw Error('Database unavailable');
    const rpc = async (name: string, value: unknown, parent: AbortSignal): Promise<unknown> => {
        const controller = new AbortController(), cancel = () => controller.abort();
        parent.addEventListener('abort', cancel, { once: true });
        if (parent.aborted) cancel();
        const timer = setTimeout(cancel, 4000);
        try {
            const response = await fetch(new URL('/rest/v1/rpc/' + name, origin), {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(value),
            });
            if (
                response.status !== 200 ||
                !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
            ) {
                await response.body?.cancel();
                throw Error('Database unavailable');
            }
            const body = await readResponseTextLimited(response, 32 * 1024);
            if (body === null || controller.signal.aborted) throw Error('Database unavailable');
            return JSON.parse(body);
        } finally {
            clearTimeout(timer);
            controller.abort();
            parent.removeEventListener('abort', cancel);
        }
    };
    const binding = (row: LightningWork) => ({ p_boat_id: row.boat_id, p_revision: row.revision, p_lease: row.lease });
    return {
        now: Date.now,
        work: (signal) => rpc('lightning_watch_work', {}, signal),
        current: (row, signal) => rpc('lightning_watch_attempt_current', binding(row), signal),
        claim: (row, pulse, signal) =>
            rpc('lightning_watch_claim', {
                ...binding(row),
                p_pulse_id: pulse.id,
                p_lat: pulse.lat,
                p_lon: pulse.lon,
                p_source_at: new Date(pulse.time).toISOString(),
            }, signal),
        licensed: lightningRuntime(async () => null, Deno.env),
    };
}
Deno.serve(createLightningWatchHandler(() => Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), dependencies));
