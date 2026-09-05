/**
 * ONE wind-grid fetch, because three hand-copies is how two of them broke.
 *
 * The same request existed in services/isochroneEnhancer.ts,
 * services/weather/WindDataController.ts and hooks/useVoyageForm.ts. When the
 * Pi moved to self-signed TLS only the isochroneEnhancer copy was migrated to
 * the pinned transport; the other two kept calling plain fetch() at
 * `${piCache.baseUrl}/api/grib/wind-grid`, which cannot complete that
 * handshake and fails with NSURLErrorDomain -1202 on every iOS device.
 *
 * useVoyageForm's copy carried its own comment saying "Same fetch logic as
 * isochroneEnhancer.ensureWindGridForRoute" — the duplication was known and
 * written down, and the migration still missed it. The passage planner has
 * therefore failed to get wind ON THE BOAT, the one network where the GRIB is
 * already cached locally, for as long as the Pi has spoken TLS.
 *
 * TWO TRANSPORTS, because these are two different hosts. The Pi leg must be
 * pinned. The Supabase leg is ordinary HTTPS with a public CA and an apikey
 * header, and must NOT be pinned.
 *
 * THE PAYLOAD IS BINARY. The Pi leg asks for arraybuffer and decodes the
 * base64 the bridge hands back. Read as text, PiTlsPlugin returns
 * `String(data:encoding:.utf8) ?? ""` — a SILENT empty string with status 200,
 * which decodes into a bad forecast rather than an error.
 */
import { createLogger } from '../../utils/createLogger';

const log = createLogger('windGrid');

export interface WindGridBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

export interface WindGridResponse {
    status: number;
    buf: ArrayBuffer;
    /** Which host answered — for logging, and for telling a Pi miss from a cloud one. */
    via: 'pi' | 'cloud';
}

/** Anything smaller than this is not a GRIB2 message, whatever the status said. */
export const MIN_GRIB_BYTES = 200;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * Fetch a GFS wind GRIB for `bounds`, over the boat Pi when one is paired and
 * reachable, otherwise from the Supabase edge function.
 *
 * @param signal — aborts the CLOUD leg only. AbortSignal is a no-op under the
 *   CapacitorHttp patch (utils/deadline.ts), and the Pi leg is bounded by the
 *   plugin's own readTimeout instead, which is the bound that actually holds.
 */
export async function fetchWindGridBuffer(
    bounds: WindGridBounds,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WindGridResponse> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const supabaseUrl =
        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
        'https://pcisdplnodrphauixcau.supabase.co';
    const supabaseKey =
        (typeof import.meta !== 'undefined' &&
            (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
        '';

    const { piCache } = await import('../PiCacheService');
    // canReachPinned, not isAvailable: a Pi that is merely reachable has no
    // pinned key, and PiTlsPlugin refuses every path but the pairing card
    // without one. Asking anyway is a round trip to a guaranteed refusal.
    const usePi = piCache.canReachPinned();

    if (usePi) {
        const { pinnedPiRequest } = await import('../PiPairingService');
        const piRes = await pinnedPiRequest({
            url: `${piCache.baseUrl}/api/grib/wind-grid`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: bounds,
            readTimeout: timeoutMs,
            responseType: 'arraybuffer',
        });
        return { status: piRes.status, buf: base64ToArrayBuffer(piRes.data || ''), via: 'pi' };
    }

    const cloudRes = await fetch(`${supabaseUrl}/functions/v1/fetch-wind-grid`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(supabaseKey ? { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } : {}),
        },
        body: JSON.stringify(bounds),
        signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    });
    return { status: cloudRes.status, buf: await cloudRes.arrayBuffer(), via: 'cloud' };
}

/**
 * The whole fetch reduced to the question every caller actually asks: did a
 * usable GRIB arrive? Returns null instead of throwing, and says why in the
 * log, so a wind failure degrades to a fallback rather than to an exception.
 */
export async function fetchWindGridOrNull(
    bounds: WindGridBounds,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ArrayBuffer | null> {
    try {
        const { status, buf, via } = await fetchWindGridBuffer(bounds, opts);
        if (status < 200 || status >= 300) {
            log.warn(`wind grid fetch failed via ${via}: HTTP ${status}`);
            return null;
        }
        if (buf.byteLength < MIN_GRIB_BYTES) {
            log.warn(`wind grid fetch returned ${buf.byteLength} bytes via ${via} — not a GRIB`);
            return null;
        }
        return buf;
    } catch (e) {
        log.warn('wind grid fetch threw:', e);
        return null;
    }
}
