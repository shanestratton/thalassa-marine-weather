/**
 * seabed-relay's ingest pipeline, kept free of Supabase so it can be tested
 * on its own: decode the device's batch, check every row strictly, drop rows
 * inside the platform's privacy zones (the third time that rule is applied,
 * after the device and the Pi), and recompute the index from the file itself.
 */
import {
    cleanCaptureMeta,
    cleanCounters,
    decodeSeabedCsv,
    encodeSeabedCsv,
    insideAnyZone,
    SEABED_HOLD_DAYS,
    type SeabedCounters,
    type SeabedMeta,
    type SeabedSummary,
    type SeabedZone,
    summariseRows,
} from '../_shared/seabedCore.ts';

/** Gzipped bytes accepted from a device (base64 in the JSON body). */
export const MAX_UPLOAD_BYTES = 900_000;
/** Decompressed text accepted: 7200 rows at ~85 bytes is ~612 KB; the bucket's object cap is 2 MiB. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

/** Bytes backed by a plain ArrayBuffer, which is what Blob and crypto.subtle accept. */
export type Bytes = Uint8Array<ArrayBuffer>;

export type IngestFailure = { ok: false; status: 413 | 422; error: string };

export interface PreparedBatch {
    ok: true;
    /** SHA-256 of the bytes the device sent: the idempotency key. */
    contentSha256: string;
    /** What gets stored: the device's own gzip when nothing was removed, else a re-encoded file. */
    gz: Bytes;
    rowCount: number;
    privacyDropped: number;
    summary: SeabedSummary | null;
    meta: SeabedMeta;
    counters: SeabedCounters;
}

export function base64ToBytes(text: string): Bytes | null {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
    try {
        const binary = atob(text);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

export async function sha256Hex(bytes: Bytes): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Bytes | null> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

export function gunzipCapped(bytes: Bytes, max: number): Promise<Bytes | null> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return readCapped(stream, max);
}

export async function gzip(text: string): Promise<Bytes> {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
    return (await readCapped(stream, MAX_CSV_BYTES)) ?? new Uint8Array();
}

/** 2030-01-01T00:00:01.123Z -> 20300101T000001Z, for object names. */
export function basicIso(iso: string): string {
    return iso.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

export function objectPath(ownerId: string, csbUuid: string, summary: SeabedSummary, sha: string): string {
    return `${ownerId}/${csbUuid}/${summary.t_start.slice(0, 4)}/${basicIso(summary.t_start)}_${
        sha.slice(0, 8)
    }.csv.gz`;
}

/**
 * One logger per boat: capture_device_id NULL means the boat's Pi logs, a
 * value names the one phone. The other kind of device may still send a batch
 * that ended before the logger last changed (what it held when logging moved
 * away), and nothing after. With no change time known, only the logger.
 */
export function loggerRefuses(
    device: 'pi' | 'phone',
    captureDeviceId: string | null,
    captureChangedAt: string | null,
    tEnd: string,
): boolean {
    const logger = captureDeviceId === null ? 'pi' : 'phone';
    if (device === logger) return false;
    const changed = captureChangedAt ? Date.parse(captureChangedAt) : NaN;
    return !(Number.isFinite(changed) && Date.parse(tEnd) <= changed);
}

export function eligibleAfter(summary: SeabedSummary): string {
    return new Date(Date.parse(summary.t_end) + SEABED_HOLD_DAYS * 86_400_000).toISOString();
}

/**
 * Turn a device's `batch` body into what gets stored. Any malformed row fails
 * the WHOLE batch (422): a file is either exactly what the device logged, less
 * the privacy rows, or it is not stored at all.
 */
export async function prepareBatch(
    body: Record<string, unknown>,
    zones: readonly SeabedZone[],
    nowMs: number,
): Promise<PreparedBatch | IngestFailure> {
    const encoding = body.encoding === undefined ? 'gzip' : body.encoding;
    if (encoding !== 'gzip' && encoding !== 'identity') {
        return { ok: false, status: 422, error: 'encoding must be gzip or identity' };
    }
    if (typeof body.csv_b64 !== 'string') return { ok: false, status: 422, error: 'csv_b64 is required' };
    const sent = base64ToBytes(body.csv_b64);
    if (!sent || sent.byteLength === 0) return { ok: false, status: 422, error: 'csv_b64 is not base64' };
    if (sent.byteLength > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: 'batch too large' };
    const contentSha256 = await sha256Hex(sent);
    if (body.sha256 !== undefined && body.sha256 !== contentSha256) {
        return { ok: false, status: 422, error: 'sha256 does not match the bytes sent' };
    }
    const raw = encoding === 'gzip' ? await gunzipCapped(sent, MAX_CSV_BYTES) : sent;
    if (!raw) return { ok: false, status: 413, error: 'not gzip, or larger than 2 MiB unpacked' };
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
        return { ok: false, status: 422, error: 'not UTF-8' };
    }
    const decoded = decodeSeabedCsv(text, nowMs);
    if (!decoded.ok) return { ok: false, status: 422, error: decoded.error };

    const kept = decoded.rows.filter((r) => !insideAnyZone(r.lat, r.lon, zones));
    const privacyDropped = decoded.rows.length - kept.length;
    const reencode = privacyDropped > 0 || encoding === 'identity';
    const gz = kept.length === 0 ? new Uint8Array() : reencode ? await gzip(encodeSeabedCsv(kept)) : sent;
    return {
        ok: true,
        contentSha256,
        gz,
        rowCount: kept.length,
        privacyDropped,
        summary: kept.length ? summariseRows(kept) : null,
        meta: cleanCaptureMeta(body.meta),
        counters: cleanCounters(body.counters),
    };
}
