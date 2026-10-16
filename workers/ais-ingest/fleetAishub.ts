/** One shared provider budget, never one timer/key/boat. No network before a persisted claim. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VesselDB } from './db.js';
import { parseAishubResponse } from './aishub.js';

export const FLEET_AIS_LIMITS = Object.freeze({
    activeCentres: 64,
    boxesPerCentre: 24,
    bytes: 1024 * 1024,
    rows: 500,
    timeoutMs: 25000,
    claimMaxAgeMs: 5000,
    reportAgeMs: 15 * 60000,
    radiusNm: 200,
});
export interface FleetCentre {
    lat: number;
    lon: number;
}
export interface FleetBox {
    key: string;
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
}
const longitude = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
/** Coverage rectangles are bounded even at the poles/dateline. Never merge distant boats into a world query. */
export function planFleetBoxes(centres: readonly FleetCentre[]): FleetBox[] {
    const boxes = new Map<string, FleetBox>();
    for (const centre of centres.slice(0, FLEET_AIS_LIMITS.activeCentres)) {
        if (![centre.lat, centre.lon].every(Number.isFinite) || Math.abs(centre.lat) > 90 || Math.abs(centre.lon) > 180)
            continue;
        // Coarse interests protect exact fleet positions. Padding covers their rounding error.
        const lat = Math.round(centre.lat * 4) / 4,
            lon = longitude(Math.round(centre.lon * 4) / 4),
            delta = 220 / 60;
        const latMin = Math.max(-90, lat - delta),
            latMax = Math.min(90, lat + delta);
        const polar = Math.abs(lat) + delta >= 90;
        const half = polar
            ? 180
            : (Math.asin(Math.min(1, Math.sin((delta * Math.PI) / 180) / Math.cos((lat * Math.PI) / 180))) * 180) /
              Math.PI;
        const west = polar ? -180 : longitude(lon - half),
            east = polar ? 180 : longitude(lon + half);
        const ranges =
            polar || west < east
                ? [[west, east]]
                : [
                      [west, 180],
                      [-180, east],
                  ];
        for (const [left, right] of ranges) {
            const count = Math.ceil((right - left) / 16);
            for (let i = 0; i < count; i++) {
                const bounds = {
                    latMin: Number(latMin.toFixed(4)),
                    latMax: Number(latMax.toFixed(4)),
                    lonMin: Number((left + ((right - left) * i) / count).toFixed(4)),
                    lonMax: Number((left + ((right - left) * (i + 1)) / count).toFixed(4)),
                };
                const key = [bounds.latMin, bounds.lonMin, bounds.latMax, bounds.lonMax].join(':');
                boxes.set(key, { key, ...bounds });
            }
        }
    }
    return [...boxes.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export interface FleetClaim {
    token: string;
    cursor: number;
    centres: FleetCentre[];
    issued_at: string;
}
export interface FleetPollStore {
    claim(): Promise<FleetClaim | null>;
    finish(
        token: string,
        box: FleetBox | null,
        outcome: 'ok' | 'limited' | 'failed' | 'empty',
        bytes: number,
        rows: number,
    ): Promise<void>;
}
export function postgresFleetPollStore(client: SupabaseClient): FleetPollStore {
    return {
        async claim() {
            const { data, error } = await client.rpc('claim_ais_fleet_poll').abortSignal(AbortSignal.timeout(5000));
            if (error) throw Error('AIS claim unavailable');
            if (!data) return null;
            const c = data as FleetClaim;
            if (
                !/^[a-f0-9-]{36}$/.test(c.token) ||
                !Number.isSafeInteger(c.cursor) ||
                !Array.isArray(c.centres) ||
                c.centres.length > 64 ||
                !Number.isFinite(Date.parse(c.issued_at))
            )
                throw Error('Invalid AIS claim');
            return c;
        },
        async finish(token, box, outcome, bytes, rows) {
            const { error } = await client
                .rpc('finish_ais_fleet_poll', {
                    claim_token: token,
                    polled_box: box,
                    outcome,
                    byte_count: bytes,
                    row_count: rows,
                })
                .abortSignal(AbortSignal.timeout(5000));
            if (error) throw Error('AIS receipt unavailable');
        },
    };
}
export interface FleetAisStats {
    state: 'held' | 'waiting' | 'polling' | 'ok' | 'limited' | 'failed';
    polls: number;
    bytes: number;
    accepted: number;
    errors: number;
}
const stats: FleetAisStats = { state: 'held', polls: 0, bytes: 0, accepted: 0, errors: 0 };
export const getFleetAisStats = () => ({ ...stats });
/** The byte deadline covers headers AND the streamed body. Redirects never expose the provider key. */
export async function readAisBody(response: Response, signal: AbortSignal): Promise<{ text: string; bytes: number }> {
    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > FLEET_AIS_LIMITS.bytes) {
        await response.body?.cancel().catch(() => undefined);
        throw Error('AIS byte limit');
    }
    if (!response.body) throw Error('AIS body unavailable');
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let bytes = 0;
    const abort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            if (signal.aborted) throw Error('AIS deadline');
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > FLEET_AIS_LIMITS.bytes) throw Error('AIS byte limit');
            chunks.push(chunk.value);
        }
        if (signal.aborted) throw Error('AIS deadline');
        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(all), bytes };
    } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
export function startFleetAishubPoller(
    db: Pick<VesselDB, 'enqueue'>,
    store: FleetPollStore,
    apiKey: string,
    doFetch: typeof fetch = fetch,
): () => void {
    let stopped = false,
        busy = false,
        active: AbortController | null = null;
    const poll = async () => {
        if (stopped || busy) return;
        busy = true;
        let claim: FleetClaim | null = null,
            box: FleetBox | null = null,
            bytes = 0,
            rows = 0;
        let outcome: 'ok' | 'limited' | 'failed' | 'empty' = 'failed';
        const started = Date.now();
        try {
            claim = await store.claim();
            if (!claim) {
                stats.state = 'held';
                return;
            }
            if (stopped || Date.now() - started > FLEET_AIS_LIMITS.claimMaxAgeMs) return;
            const boxes = planFleetBoxes(claim.centres);
            box = boxes[claim.cursor % Math.max(1, boxes.length)] ?? null;
            if (!box) {
                outcome = 'empty';
                stats.state = 'waiting';
                return;
            }
            const params = new URLSearchParams({
                username: apiKey,
                format: '1',
                output: 'json',
                compress: '0',
                interval: '15',
                latmin: String(box.latMin),
                latmax: String(box.latMax),
                lonmin: String(box.lonMin),
                lonmax: String(box.lonMax),
            });
            active = new AbortController();
            const timer = setTimeout(() => active?.abort(), FLEET_AIS_LIMITS.timeoutMs);
            stats.state = 'polling';
            stats.polls++;
            try {
                const response = await doFetch(`https://data.aishub.net/ws.php?${params}`, {
                    signal: active.signal,
                    redirect: 'error',
                    credentials: 'omit',
                });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => undefined);
                    throw Error('AIS provider response');
                }
                const body = await readAisBody(response, active.signal);
                bytes = body.bytes;
                if (stopped || active.signal.aborted) return;
                const parsed = parseAishubResponse(JSON.parse(body.text), Date.now());
                if ('error' in parsed) throw Error('AIS provider envelope');
                rows = parsed.total;
                outcome = rows > FLEET_AIS_LIMITS.rows ? 'limited' : 'ok';
                for (const record of parsed.records.slice(0, FLEET_AIS_LIMITS.rows)) {
                    if (
                        record.lat === undefined ||
                        record.lon === undefined ||
                        record.lat < box.latMin ||
                        record.lat > box.latMax ||
                        record.lon < box.lonMin ||
                        record.lon > box.lonMax
                    )
                        continue;
                    db.enqueue(record);
                    stats.accepted++;
                }
                stats.bytes += bytes;
                stats.state = outcome;
            } finally {
                clearTimeout(timer);
                active = null;
            }
        } catch {
            stats.errors++;
            stats.state = 'failed';
        } finally {
            if (claim)
                await store
                    .finish(claim.token, box, outcome, bytes, Math.min(rows, FLEET_AIS_LIMITS.rows))
                    .catch(() => {
                        stats.errors++;
                    });
            busy = false;
        }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
        await poll();
        if (!stopped) timer = setTimeout(() => void run(), 61000);
    };
    void run();
    return () => {
        stopped = true;
        clearTimeout(timer);
        active?.abort();
    };
}
