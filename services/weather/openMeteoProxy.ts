import { supabase, supabaseAnonKey, supabaseUrl } from '../supabase';

export type OpenMeteoOperation = 'forecast' | 'marine';
export type OpenMeteoParameterValue = string | number;
export type OpenMeteoParameters = Record<string, OpenMeteoParameterValue>;

export interface OpenMeteoPoint {
    lat: number;
    lon: number;
}

const DEFAULT_TIMEOUT_MS = 18_000;
const MAX_RESPONSE_BYTES = 16_000_000;
const MAX_POINTS_PER_REQUEST = 50;

async function functionHeaders(): Promise<Record<string, string>> {
    if (!supabaseUrl || !supabaseAnonKey) throw new Error('Weather service is not configured');

    let bearer = supabaseAnonKey;
    if (supabase) {
        try {
            const { data } = await supabase.auth.getSession();
            const session = data.session;
            const expiresAtMs = (session?.expires_at ?? 0) * 1_000;
            if (session?.access_token && expiresAtMs > Date.now() + 30_000) bearer = session.access_token;
        } catch {
            // Signed-out/offline session lookup: use the deliberately
            // lower-quota public lane rather than exposing a provider key.
        }
    }

    return {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${bearer}`,
        apikey: supabaseAnonKey,
    };
}

async function readTextLimited(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new Error('Weather response exceeded the safe size limit');
    }
    if (!response.body) return '';

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error('Weather response exceeded the safe size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

/**
 * Invoke the fixed commercial Open-Meteo edge boundary. Provider hosts,
 * paths and credentials never enter the browser or the Pi.
 */
export async function fetchOpenMeteoProxy<T>(
    operation: OpenMeteoOperation,
    params: OpenMeteoParameters,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
    if (!supabaseUrl) throw new Error('Weather service is not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${supabaseUrl}/functions/v1/proxy-openmeteo`, {
            method: 'POST',
            headers: await functionHeaders(),
            body: JSON.stringify({ operation, params }),
            signal: controller.signal,
        });
        const text = await readTextLimited(response);
        if (!response.ok) throw new Error(`Weather service request failed (${response.status})`);

        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('Weather service returned an invalid response');
        }
        if (!data || typeof data !== 'object') throw new Error('Weather service returned an invalid response');
        return data as T;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Coordinate-list helper with a hard 50-point request size and bounded
 * concurrency. It also refuses partial/misaligned upstream batches so route
 * and grid code can never attach one coordinate's weather to another.
 */
export async function fetchOpenMeteoPoints<T>(
    operation: OpenMeteoOperation,
    points: readonly OpenMeteoPoint[],
    params: OpenMeteoParameters,
    concurrency = 4,
): Promise<T[]> {
    if (
        points.length === 0 ||
        points.some(
            ({ lat, lon }) =>
                !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180,
        )
    ) {
        throw new Error('Invalid Open-Meteo coordinate list');
    }

    const batches: OpenMeteoPoint[][] = [];
    for (let index = 0; index < points.length; index += MAX_POINTS_PER_REQUEST) {
        batches.push(points.slice(index, index + MAX_POINTS_PER_REQUEST));
    }

    const results = new Array<T[]>(batches.length);
    let nextBatch = 0;
    const worker = async () => {
        while (true) {
            const batchIndex = nextBatch++;
            const batch = batches[batchIndex];
            if (!batch) return;

            const payload = await fetchOpenMeteoProxy<T | T[]>(operation, {
                ...params,
                latitude: batch.map(({ lat }) => lat.toFixed(4)).join(','),
                longitude: batch.map(({ lon }) => lon.toFixed(4)).join(','),
            });
            const normalized = Array.isArray(payload) ? payload : [payload];
            if (normalized.length !== batch.length) {
                throw new Error('Weather service returned a misaligned coordinate batch');
            }
            results[batchIndex] = normalized;
        }
    };

    const workerCount = Math.max(1, Math.min(Math.trunc(concurrency) || 1, 6, batches.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results.flat();
}
