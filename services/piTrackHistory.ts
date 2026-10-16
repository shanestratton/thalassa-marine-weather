/** Explicit, memory-only replay of the boat's private track over the paired TLS lane. */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import { getPairing, pinnedPiRequest } from './PiPairingService';
import { piCache } from './PiCacheService';
import { isPinnedTransportAvailable } from './piTls';
import { utf8ByteLength } from './enc/types';

export interface PiTrackHistoryPoint {
    sample_id: number;
    at_ms: number;
    lat: number;
    lon: number;
    reason: string;
    sog_kts: number | null;
    cog_deg: number | null;
    stw_kts: number | null;
    hdg_deg: number | null;
    depth_m: number | null;
    tws_kts: number | null;
    twd_deg: number | null;
    water_temp_c: number | null;
    pressure_hpa: number | null;
    heel_deg: number | null;
    engine_rpm: number | null;
    engine_rpm_at_ms?: number | null;
    twa_deg: number | null;
    sog_at_ms?: number | null;
    cog_true_at_ms?: number | null;
    stw_at_ms?: number | null;
    heading_true_deg?: number | null;
    heading_true_at_ms?: number | null;
    leeway_deg?: number | null;
    leeway_at_ms?: number | null;
    leeway_source?: string | null;
}

export interface PiTrackHistory {
    points: PiTrackHistoryPoint[];
    truncated: boolean;
    from: number;
    to: number;
    /** Resume replaces the displayed batch; it never grows an unbounded in-memory voyage. */
    nextCursor: string | null;
    snapshot: number;
}

export class PiTrackHistoryError extends Error {
    constructor(public readonly code: 'unavailable' | 'update' | 'invalid' | 'cancelled') {
        super(
            code === 'update'
                ? 'Update the Pi to read complete, paged track history.'
                : code === 'cancelled'
                  ? 'Track request cancelled.'
                  : code === 'invalid'
                    ? 'The Pi returned an invalid or oversized track page.'
                    : 'The paired Pi is not reachable on its private lane.',
        );
        this.name = 'PiTrackHistoryError';
    }
}

const PAGE_POINTS = 500;
const PAGE_BYTES = 1_048_576;
const TOTAL_BYTES = 8 * PAGE_BYTES;
const DEADLINE_MS = 20_000;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
function controls(value: string): boolean {
    for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32) return true;
    return false;
}
const numericFields = [
    'sog_kts',
    'cog_deg',
    'stw_kts',
    'hdg_deg',
    'depth_m',
    'tws_kts',
    'twd_deg',
    'water_temp_c',
    'pressure_hpa',
    'heel_deg',
    'engine_rpm',
    'engine_rpm_at_ms',
    'twa_deg',
    'sog_at_ms',
    'cog_true_at_ms',
    'stw_at_ms',
    'heading_true_deg',
    'heading_true_at_ms',
    'leeway_deg',
    'leeway_at_ms',
] as const;

function point(value: unknown, from: number, to: number, snapshot: number): PiTrackHistoryPoint {
    if (
        !object(value) ||
        !int(value.sample_id) ||
        value.sample_id < 1 ||
        value.sample_id > snapshot ||
        !int(value.at_ms) ||
        value.at_ms < from ||
        value.at_ms > to ||
        typeof value.lat !== 'number' ||
        !Number.isFinite(value.lat) ||
        Math.abs(value.lat) > 90 ||
        typeof value.lon !== 'number' ||
        !Number.isFinite(value.lon) ||
        Math.abs(value.lon) > 180 ||
        typeof value.reason !== 'string' ||
        value.reason.length > 80 ||
        controls(value.reason)
    )
        throw new PiTrackHistoryError('invalid');
    const clean: Record<string, unknown> = {
        sample_id: value.sample_id,
        at_ms: value.at_ms,
        lat: value.lat,
        lon: value.lon,
        reason: value.reason,
    };
    for (const field of numericFields) {
        const n = value[field];
        if (n !== undefined && n !== null && (typeof n !== 'number' || !Number.isFinite(n)))
            throw new PiTrackHistoryError('invalid');
        clean[field] = n ?? null;
    }
    if (
        value.leeway_source !== undefined &&
        value.leeway_source !== null &&
        (typeof value.leeway_source !== 'string' || value.leeway_source.length > 80 || controls(value.leeway_source))
    )
        throw new PiTrackHistoryError('invalid');
    clean.leeway_source = value.leeway_source ?? null;
    return clean as unknown as PiTrackHistoryPoint;
}

export async function loadPiTrackHistory(options: {
    from: number;
    to: number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    maxPoints?: number;
    maxPages?: number;
    /** A prior result's opaque composite cursor, for a new bounded batch. */
    cursor?: string;
}): Promise<PiTrackHistory> {
    const { from, to, signal } = options;
    if (
        !int(from) ||
        !int(to) ||
        from > to ||
        (options.cursor !== undefined && !/^\d{1,16}:\d{1,16}:\d{1,16}$/.test(options.cursor))
    )
        throw new PiTrackHistoryError('invalid');
    if (options.cursor) {
        const [at, row, snapshot] = options.cursor.split(':').map(Number);
        if (![at, row, snapshot].every(int) || at < from || at > to || row < 1 || row > snapshot)
            throw new PiTrackHistoryError('invalid');
    }
    const cap = (value: number | undefined, maximum: number) => {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
            throw new PiTrackHistoryError('invalid');
        return Math.min(value ?? maximum, maximum);
    };
    const maxPoints = cap(options.maxPoints, 10_000);
    const maxPages = cap(options.maxPages, 20);
    const scope = getAuthIdentityScope();
    const record = getPairing();
    const pairing = record ? { ...record } : null;
    const base = piCache.lanBaseUrlNow();
    if (!base || !pairing?.publicKeySpki || !isPinnedTransportAvailable()) throw new PiTrackHistoryError('unavailable');
    const current = () => {
        const now = getPairing();
        return (
            !signal?.aborted &&
            options.isCurrent?.() !== false &&
            isAuthIdentityScopeCurrent(scope) &&
            piCache.lanBaseUrlNow() === base &&
            now?.publicKeySpki === pairing.publicKeySpki &&
            now?.deviceId === pairing.deviceId &&
            now?.pairedAt === pairing.pairedAt
        );
    };
    const guard = () => {
        if (!current()) throw new PiTrackHistoryError('cancelled');
    };
    const points: PiTrackHistoryPoint[] = [];
    const deadline = performance.now() + DEADLINE_MS;
    let cursor: string | null = options.cursor ?? null;
    let snapshot: number | null = cursor ? Number(cursor.split(':')[2]) : null;
    let bytes = 0;
    const partial = (): PiTrackHistory => ({
        points,
        truncated: true,
        from,
        to,
        nextCursor: cursor,
        snapshot: snapshot ?? 0,
    });
    for (let page = 0; page < maxPages; page++) {
        guard();
        const remaining = deadline - performance.now();
        if (remaining <= 0) return partial();
        const limit = Math.min(PAGE_POINTS, maxPoints - points.length);
        const query = new URLSearchParams({ page: '1', from: String(from), to: String(to), limit: String(limit) });
        if (cursor) query.set('cursor', cursor);
        // The native bridge has its own bounded request timeout. Cancellation
        // discards its eventual result and stops subsequent pages; no WAN fallback.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let response;
        try {
            response = await Promise.race([
                pinnedPiRequest({
                    url: `${base}/api/track/points?${query}`,
                    method: 'GET',
                    responseType: 'text',
                    connectTimeout: Math.min(3000, remaining),
                    readTimeout: Math.min(5000, remaining),
                }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new PiTrackHistoryError('unavailable')), remaining);
                    onAbort = () => reject(new PiTrackHistoryError('cancelled'));
                    signal?.addEventListener('abort', onAbort, { once: true });
                }),
            ]);
        } catch (error) {
            guard();
            if (performance.now() >= deadline && points.length) return partial();
            throw error instanceof PiTrackHistoryError ? error : new PiTrackHistoryError('unavailable');
        } finally {
            clearTimeout(timer);
            if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
        guard();
        if (performance.now() >= deadline) return partial();
        if (response.status !== 200) throw new PiTrackHistoryError('unavailable');
        if (
            typeof response.data !== 'string' ||
            response.data.length > PAGE_BYTES ||
            utf8ByteLength(response.data, PAGE_BYTES) > PAGE_BYTES
        )
            throw new PiTrackHistoryError('invalid');
        bytes += utf8ByteLength(response.data, PAGE_BYTES);
        if (bytes > TOTAL_BYTES) return partial();
        let body: unknown;
        try {
            body = JSON.parse(response.data);
        } catch {
            throw new PiTrackHistoryError('invalid');
        }
        if (!object(body) || body.page !== 1) throw new PiTrackHistoryError('update');
        if (
            body.from !== from ||
            body.to !== to ||
            !int(body.snapshot) ||
            (snapshot !== null && body.snapshot !== snapshot) ||
            !Array.isArray(body.points) ||
            body.points.length > limit ||
            typeof body.truncated !== 'boolean'
        )
            throw new PiTrackHistoryError('invalid');
        snapshot = body.snapshot;
        const rows = body.points.map((row) => point(row, from, to, snapshot!));
        let previous = points.at(-1);
        if (!previous && cursor) {
            const [at_ms, sample_id] = cursor.split(':').map(Number);
            previous = { at_ms, sample_id } as PiTrackHistoryPoint;
        }
        for (const row of rows) {
            if (
                previous &&
                (row.at_ms < previous.at_ms || (row.at_ms === previous.at_ms && row.sample_id <= previous.sample_id))
            )
                throw new PiTrackHistoryError('invalid');
            previous = row;
        }
        const last = rows.at(-1);
        const expected = last ? `${last.at_ms}:${last.sample_id}:${snapshot}` : null;
        if (body.truncated ? !rows.length || body.nextCursor !== expected : body.nextCursor !== null)
            throw new PiTrackHistoryError('invalid');
        points.push(...rows);
        cursor = body.truncated ? expected : null;
        if (!body.truncated) return { points, truncated: false, from, to, nextCursor: null, snapshot };
        if (points.length === maxPoints) return partial();
    }
    guard();
    return partial();
}
