import { supabase, supabaseAnonKey, supabaseUrl } from '../supabase';
import { satelliteModeActive } from '../networkPolicy';
import { aromeDomain } from './aromeDomains';
import { parseAromePoint, type AromePointForecast } from './aromePointContract';
import { withDeadline } from '../../utils/deadline';

const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 12_000;

/** Only our fixed Edge operation can read our separately admitted wx ingest.
 * No commercial fallback, provider URL, user-supplied origin or persistent
 * position cache. Missing deployment/cohort/mask is an unavailable model.
 */
export async function fetchOwnAromePoint(
    model: string,
    point: { lat: number; lon: number },
    signal?: AbortSignal,
): Promise<AromePointForecast | null> {
    const domain = aromeDomain(model);
    if (
        !domain ||
        !supabaseUrl ||
        !supabaseAnonKey ||
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        satelliteModeActive() ||
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        signal?.aborted
    )
        return null;
    const [south, north, west, east] = domain.region;
    if (point.lat < south || point.lat > north || point.lon < west || point.lon > east) return null;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        return await withDeadline(
            (async () => {
                let bearer = supabaseAnonKey;
                if (supabase) {
                    const { data } = await supabase.auth.getSession();
                    if (data.session?.access_token && (data.session.expires_at ?? 0) * 1000 > Date.now() + 30_000)
                        bearer = data.session.access_token;
                }
                if (controller.signal.aborted) return null;
                const response = await fetch(`${supabaseUrl}/functions/v1/regional-arome`, {
                    method: 'POST',
                    redirect: 'error',
                    headers: {
                        'Content-Type': 'application/json',
                        apikey: supabaseAnonKey,
                        Authorization: `Bearer ${bearer}`,
                    },
                    body: JSON.stringify({
                        model,
                        lat: Number(point.lat.toFixed(4)),
                        lon: Number(point.lon.toFixed(4)),
                    }),
                    signal: controller.signal,
                });
                if (
                    !response.ok ||
                    controller.signal.aborted ||
                    Number(response.headers.get('content-length')) > MAX_BODY_BYTES ||
                    !response.body
                ) {
                    void response.body?.cancel().catch(() => undefined);
                    return null;
                }
                reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let total = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > MAX_BODY_BYTES || controller.signal.aborted) return null;
                    chunks.push(value);
                }
                if (controller.signal.aborted) return null;
                const body = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    body.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return parseAromePoint(
                    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
                    model,
                    point,
                );
            })(),
            TIMEOUT_MS,
            'original AROME sea-cell request',
        );
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (reader) {
            const finished = reader;
            void finished
                .cancel()
                .then(() => finished.releaseLock())
                .catch(() => undefined);
        }
        controller.abort();
    }
}
