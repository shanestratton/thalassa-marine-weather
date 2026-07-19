/**
 * thpqPoint — point wave forecasts from a global THPQ binary via HTTP Range.
 *
 * Produced by thalassa-weather-server (`modeb/encode_points.py`) from ECMWF
 * AIFS v2 open data and published as a single ~517 MB global file per run.
 *
 * WHY A 517 MB FILE IS THE CHEAP OPTION
 *   The file is laid out TIME-MAJOR: for every grid cell, all timesteps for
 *   all params sit contiguously. So a full 7-day, 29-step, 9-variable forecast
 *   for one location is **522 bytes at a computable offset** — one Range
 *   request. Nothing is downloaded that isn't wanted, there is no query
 *   server, and the origin is a static object on a CDN.
 *
 *   Contrast the CMEMS `.bin` grids (see currentsGrid.ts): those are
 *   SPACE-major, one file per forecast hour, which is right for drawing a
 *   whole field on the map and wrong for a point series — 29 timesteps would
 *   mean 29 file fetches. The two access patterns want opposite layouts, hence
 *   two formats. This one does not replace THCU and does not touch it.
 *
 * BINARY LAYOUT — 'THPQ' v1, little-endian
 *   0..3    magic 'THPQ'
 *   4       version
 *   5       nParams
 *   6..7    nSteps            u16
 *   8..9    width             u16
 *   10..11  height            u16
 *   12..27  north,south,west,east   f32 x4
 *   28..31  baseTime          u32  unix seconds at step 0
 *   32..33  stepMinutes       u16
 *   34..35  reserved
 *   36..    param table, 16 B each: name[8], dtype u8, rsv, scale f32, rsv u16
 *           followed by nParams x f32 offsets
 *   then    data, row-major by cell (north→south, west→east)
 *
 *   value = raw * scale + offset
 *   cellStride = sum over params of nSteps * sizeof(dtype)
 *   byteOffset(ix, iy) = headerSize + (iy * width + ix) * cellStride
 *
 * NODATA
 *   Land and masked cells are all-zero. A cell whose swh is 0.00 for every
 *   step is "no data here", NOT a flat calm — global wave models mask land,
 *   and reporting 0.00 m on a beach would be a confidently wrong answer rather
 *   than an absent one. `isNoData` on the result flags this; callers should
 *   fall back rather than display it.
 *
 * ⚠ RANGE REQUESTS ON NATIVE ARE UNVERIFIED
 *   The web path uses `fetch` with a Range header, which is well supported.
 *   The native path uses CapacitorHttp with `responseType: 'arraybuffer'`;
 *   whether WKWebView/CapacitorHttp honours Range and returns a 206 partial
 *   rather than the whole 517 MB object HAS NOT BEEN TESTED ON DEVICE. If it
 *   does not, this falls back to erroring rather than silently downloading
 *   half a gigabyte on cellular — see the guard in `rangeGet`.
 */

import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../../utils/createLogger';
import { API_BASE } from '../../native/apiBase';

const log = createLogger('thpqPoint');

const MAGIC = 0x51504854; // 'THPQ' little-endian u32
const HEADER_PROBE = 512; // enough for the fixed header + a generous param table
const DTYPE_SIZE: Record<number, number> = { 1: 1, 2: 2 };

/** Guard: a partial read should never be large. If the server ignored Range
 *  and started sending the whole object, bail before it costs the user a
 *  cellular bill. */
const MAX_PARTIAL_BYTES = 64 * 1024;

export interface ThpqParam {
    name: string;
    dtype: number;
    scale: number;
    offset: number;
}

export interface ThpqHeader {
    version: number;
    nParams: number;
    nSteps: number;
    width: number;
    height: number;
    north: number;
    south: number;
    west: number;
    east: number;
    baseTime: number; // unix seconds
    stepMinutes: number;
    params: ThpqParam[];
    headerSize: number;
    cellStride: number;
}

export interface ThpqPointForecast {
    /** Grid cell actually sampled — may differ from the requested point by up to half a cell. */
    lat: number;
    lon: number;
    /** ISO timestamps, one per step. */
    times: string[];
    /** param name → values in physical units, one per step. */
    values: Record<string, number[]>;
    isNoData: boolean;
}

let headerCache: { url: string; header: ThpqHeader } | null = null;

function url(file: string): string {
    return `${API_BASE}/points/${file}`;
}

async function rangeGet(u: string, start: number, end: number): Promise<ArrayBuffer> {
    const range = `bytes=${start}-${end}`;
    const expected = end - start + 1;

    // Native first (bypasses CORS, matching the pattern in base.ts).
    try {
        const res = await CapacitorHttp.get({
            url: u,
            headers: { Range: range },
            responseType: 'arraybuffer',
        });
        if (res?.status !== 206 && res?.status !== 200) {
            throw new Error(`THPQ_HTTP_${res?.status}`);
        }
        // CapacitorHttp returns arraybuffer responses base64-encoded.
        const b64 = res.data as unknown as string;
        const bin = atob(b64);
        if (bin.length > MAX_PARTIAL_BYTES) {
            // Range was ignored and we are being sent the whole file.
            throw new Error(`THPQ_RANGE_UNSUPPORTED: asked ${expected} B, got ${bin.length}+`);
        }
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    } catch (e) {
        log.debug('CapacitorHttp range failed, falling back to fetch', e);
    }

    const res = await fetch(u, { headers: { Range: range } });
    if (!res.ok) throw new Error(`THPQ_HTTP_${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PARTIAL_BYTES) {
        throw new Error(`THPQ_RANGE_UNSUPPORTED: asked ${expected} B, got ${buf.byteLength}`);
    }
    return buf;
}

export function parseHeader(buf: ArrayBuffer): ThpqHeader {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('THPQ_BAD_MAGIC');

    const version = dv.getUint8(4);
    const nParams = dv.getUint8(5);
    const nSteps = dv.getUint16(6, true);
    const width = dv.getUint16(8, true);
    const height = dv.getUint16(10, true);
    const north = dv.getFloat32(12, true);
    const south = dv.getFloat32(16, true);
    let west = dv.getFloat32(20, true);
    const east = dv.getFloat32(24, true);
    const baseTime = dv.getUint32(28, true);
    const stepMinutes = dv.getUint16(32, true);

    // ECMWF reports the first longitude as 180, meaning -180. Without this the
    // grid reads as west=180/east=179.75 and every lookup lands half a world away.
    if (west > east) west -= 360;

    let o = 36;
    const params: ThpqParam[] = [];
    for (let i = 0; i < nParams; i++) {
        const bytes = new Uint8Array(buf, o, 8);
        let name = '';
        for (const b of bytes) {
            if (b === 0) break;
            name += String.fromCharCode(b);
        }
        params.push({ name, dtype: dv.getUint8(o + 8), scale: dv.getFloat32(o + 10, true), offset: 0 });
        o += 16;
    }
    for (let i = 0; i < nParams; i++) {
        params[i].offset = dv.getFloat32(o, true);
        o += 4;
    }

    const cellStride = params.reduce((n, p) => n + nSteps * DTYPE_SIZE[p.dtype], 0);
    return {
        version,
        nParams,
        nSteps,
        width,
        height,
        north,
        south,
        west,
        east,
        baseTime,
        stepMinutes,
        params,
        headerSize: o,
        cellStride,
    };
}

export async function fetchThpqHeader(file = 'aifs-wave.thpq'): Promise<ThpqHeader> {
    const u = url(file);
    if (headerCache?.url === u) return headerCache.header;
    const header = parseHeader(await rangeGet(u, 0, HEADER_PROBE - 1));
    headerCache = { url: u, header };
    log.info(
        `THPQ v${header.version}: ${header.width}x${header.height}, ` +
            `${header.nParams} params x ${header.nSteps} steps, ${header.cellStride} B/cell`,
    );
    return header;
}

/** Invalidate the cached header — call after a known publish. */
export function resetThpqHeader(): void {
    headerCache = null;
}

/** Pure decode of one cell block — exported for testing without any network. */
export function decodeCell(h: ThpqHeader, buf: ArrayBuffer, ix: number, iy: number): ThpqPointForecast {
    const dv = new DataView(buf);
    const dLat = (h.north - h.south) / (h.height - 1);
    const dLon = (h.east - h.west) / (h.width - 1);
    const values: Record<string, number[]> = {};
    let o = 0;
    let allZero = true;
    for (const p of h.params) {
        const out: number[] = new Array(h.nSteps);
        for (let s = 0; s < h.nSteps; s++) {
            const raw = p.dtype === 1 ? dv.getUint8(o) : dv.getUint16(o, true);
            o += DTYPE_SIZE[p.dtype];
            if (raw !== 0) allZero = false;
            out[s] = raw * p.scale + p.offset;
        }
        values[p.name] = out;
    }
    const times: string[] = new Array(h.nSteps);
    for (let s = 0; s < h.nSteps; s++) {
        times[s] = new Date((h.baseTime + s * h.stepMinutes * 60) * 1000).toISOString();
    }
    return { lat: h.north - iy * dLat, lon: h.west + ix * dLon, times, values, isNoData: allZero };
}

export async function fetchPointForecast(
    lat: number,
    lon: number,
    file = 'aifs-wave.thpq',
): Promise<ThpqPointForecast> {
    const h = await fetchThpqHeader(file);

    const dLat = (h.north - h.south) / (h.height - 1);
    const dLon = (h.east - h.west) / (h.width - 1);
    const iy = Math.min(h.height - 1, Math.max(0, Math.round((h.north - lat) / dLat)));
    const ix = ((Math.round(((((lon - h.west) % 360) + 360) % 360) / dLon) % h.width) + h.width) % h.width;

    const start = h.headerSize + (iy * h.width + ix) * h.cellStride;
    const buf = await rangeGet(url(file), start, start + h.cellStride - 1);
    const dv = new DataView(buf);

    const values: Record<string, number[]> = {};
    let o = 0;
    let allZero = true;
    for (const p of h.params) {
        const out: number[] = new Array(h.nSteps);
        for (let s = 0; s < h.nSteps; s++) {
            const raw = p.dtype === 1 ? dv.getUint8(o) : dv.getUint16(o, true);
            o += DTYPE_SIZE[p.dtype];
            if (raw !== 0) allZero = false;
            out[s] = raw * p.scale + p.offset;
        }
        values[p.name] = out;
    }

    const times: string[] = new Array(h.nSteps);
    for (let s = 0; s < h.nSteps; s++) {
        times[s] = new Date((h.baseTime + s * h.stepMinutes * 60) * 1000).toISOString();
    }

    return {
        lat: h.north - iy * dLat,
        lon: h.west + ix * dLon,
        times,
        values,
        isNoData: allZero,
    };
}
