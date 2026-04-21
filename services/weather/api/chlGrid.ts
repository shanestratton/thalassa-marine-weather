/**
 * chlGrid — fetches CMEMS ocean-chl hourly binaries produced
 * by scripts/cmems-chl-pipeline/pipeline.py.
 *
 * The pipeline attaches binaries to a rolling GitHub Release but the
 * release URLs 302 to objects.githubusercontent.com which lacks CORS
 * headers, so the client fetches through a same-origin proxy:
 *   /api/chl/manifest.json  →  Vercel edge fn → GitHub Release asset
 *   /api/chl/h00.bin        →  Vercel edge fn → GitHub Release asset
 * The edge function lives at `api/chl/[file].ts`; dev uses the
 * matching `/api/chl` proxy in vite.config.ts.
 *
 * Why `/api/chl` and not `/sst`: Vercel's Attack Challenge Mode
 * (bot mitigation) fires on non-API paths and returns HTTP 403 with an
 * `x-vercel-mitigated: challenge` header for fetches made without a
 * solved-challenge cookie. `/api/*` is exempt, so we use it directly and
 * skip the rewrite entirely.
 *
 * Binary layout (see scripts/cmems-chl-pipeline/pipeline.py):
 *   bytes  0..3   magic 'THCU'
 *   byte   4      version (1 or 2 — v2 adds land mask plane)
 *   byte   5      reserved
 *   u16    6..7   width
 *   u16    8..9   height
 *   f32   10..25  north, south, west, east
 *   u16   26..27  hours (=1)
 *   u16   28..29  reserved
 *   f32[w*h]      u  (east velocity m/s)
 *   f32[w*h]      v  (north velocity m/s)
 *   u8 [w*h]      land_mask (1=land, 0=ocean) — v2 only
 */
import type { WindGrid } from '../windField';
import { createLogger } from '../../../utils/createLogger';

const log = createLogger('chlGrid');

const MAGIC = 0x55434854; // 'THCU' little-endian u32
const HEADER_SIZE = 30;

/** Same-origin base — the Vite/Vercel proxy forwards to the GitHub Release.
 *  Must be `/api/chl` not `/sst`: Vercel Attack Challenge Mode
 *  challenges non-API paths and 403s fetches without a challenge cookie. */
const BASE = '/api/chl';

export interface ChlManifest {
    version: number;
    generated_at: string;
    hours: Array<{ hour: number; file: string; bytes: number }>;
}

export async function fetchChlManifest(): Promise<ChlManifest | null> {
    try {
        const res = await fetch(`${BASE}/manifest.json`, { cache: 'no-cache' });
        if (!res.ok) {
            log.warn(`Manifest fetch failed: ${res.status}`);
            return null;
        }
        return (await res.json()) as ChlManifest;
    } catch (err) {
        log.warn('Manifest fetch error', err);
        return null;
    }
}

/** Session-scoped caches. The pipeline updates once a day, so once we
 *  have a grid there's no reason to refetch within a session — and the
 *  inflight coalescer prevents stampedes if multiple callers race on
 *  first paint. */
let cachedGrid: WindGrid | null = null;
let inflight: Promise<WindGrid | null> | null = null;

/**
 * Fetch every hour's binary and assemble a WindGrid-shaped result so
 * the existing WebGL particle layer consumes it without changes.
 *
 * Coalesces concurrent callers and caches success for the session.
 */
export async function fetchChlGrid(): Promise<WindGrid | null> {
    if (cachedGrid) return cachedGrid;
    if (inflight) return inflight;
    inflight = doFetchChlGrid().finally(() => {
        inflight = null;
    });
    const grid = await inflight;
    if (grid) cachedGrid = grid;
    return grid;
}

async function doFetchChlGrid(): Promise<WindGrid | null> {
    const manifest = await fetchChlManifest();
    if (!manifest || manifest.hours.length === 0) return null;

    const hourCount = manifest.hours.length;
    const us: Float32Array[] = new Array(hourCount);
    const vs: Float32Array[] = new Array(hourCount);
    const speeds: Float32Array[] = new Array(hourCount);
    let landMask: Uint8Array | undefined;

    let width = 0;
    let height = 0;
    let north = 0;
    let south = 0;
    let west = 0;
    let east = 0;

    // Cache-bust the bin URLs with the manifest's generated_at timestamp.
    // The bin filenames (h00.bin etc) are stable across pipeline runs, so
    // without this the browser HTTP cache happily serves stale binaries
    // from a previous data version (e.g. v1 0.5° even though the release
    // now has v2 0.25°). The query string makes each pipeline-run-version
    // a distinct cache key while costing nothing on the server side
    // (the edge function ignores query params).
    const cacheBust = manifest.generated_at ? `?t=${encodeURIComponent(manifest.generated_at)}` : '';

    // Fetch all hours in parallel — user pays once when sst toggles on.
    // NOTE: SST is daily cadence (hour offsets 0,24,48,72,96) — same indexing rationale as waves (step-indexed arrays, hourOffsets[] alongside).
    // hourly so entry.hour is the ACTUAL forecast-hour offset (0, 3, 6,
    // …, 48) rather than a step index. The particle-layer hook indexes
    // u[] by step-index (0..N-1), so we key into u/v/speed by step index
    // and stash the manifest's real-hour offsets separately for UI use
    // (see WindGrid.hourOffsets, added for this).
    //
    // Sort by hour ascending so step-index 0 is always the freshest
    // timestep regardless of manifest order.
    const sortedEntries = [...manifest.hours].sort((a, b) => a.hour - b.hour);
    const parsed = await Promise.all(
        sortedEntries.map(async (entry, stepIdx) => {
            const res = await fetch(`${BASE}/${entry.file}${cacheBust}`, { cache: 'default' });
            if (!res.ok) throw new Error(`step ${stepIdx} (T+${entry.hour}h): HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            return { stepIdx, hourOffset: entry.hour, buf };
        }),
    );

    const hourOffsets: number[] = new Array(hourCount);
    for (const { stepIdx, hourOffset, buf } of parsed) {
        hourOffsets[stepIdx] = hourOffset;
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== MAGIC) {
            throw new Error(`step ${stepIdx}: bad magic`);
        }
        const version = dv.getUint8(4);
        const w = dv.getUint16(6, true);
        const h = dv.getUint16(8, true);
        const n = dv.getFloat32(10, true);
        const s = dv.getFloat32(14, true);
        const wLon = dv.getFloat32(18, true);
        const eLon = dv.getFloat32(22, true);

        if (width === 0) {
            width = w;
            height = h;
            north = n;
            south = s;
            west = wLon;
            east = eLon;
        }

        // Float32Array requires a 4-byte-aligned offset and our header
        // is 30 bytes — copy instead of view to sidestep RangeError.
        const uOffset = HEADER_SIZE;
        const vOffset = uOffset + w * h * 4;
        const maskOffset = vOffset + w * h * 4;
        const u = new Float32Array(buf.slice(uOffset, uOffset + w * h * 4));
        const v = new Float32Array(buf.slice(vOffset, vOffset + w * h * 4));

        // v2+: land mask plane follows v. Take it from the first hour we
        // see (mask is hour-invariant — land doesn't move overnight).
        if (version >= 2 && landMask === undefined && buf.byteLength >= maskOffset + w * h) {
            landMask = new Uint8Array(buf.slice(maskOffset, maskOffset + w * h));
        }

        const speed = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            speed[i] = Math.hypot(u[i], v[i]);
        }
        us[stepIdx] = u;
        vs[stepIdx] = v;
        speeds[stepIdx] = speed;
    }

    // Build lat/lon axes. Pipeline writes rows north→south, cols west→east.
    const lats: number[] = new Array(height);
    const lons: number[] = new Array(width);
    const latStep = height > 1 ? (south - north) / (height - 1) : 0;
    const lonStep = width > 1 ? (east - west) / (width - 1) : 0;
    for (let r = 0; r < height; r++) lats[r] = north + r * latStep;
    for (let c = 0; c < width; c++) lons[c] = west + c * lonStep;

    const oceanCells = landMask ? width * height - landMask.reduce((a, b) => a + b, 0) : null;
    log.info(
        `Loaded chl: ${hourCount}h × ${width}×${height}, bounds n=${north} s=${south} w=${west} e=${east}` +
            (oceanCells !== null ? `, ocean cells=${oceanCells}` : ', no land mask (v1 binary)'),
    );

    return {
        u: us,
        v: vs,
        speed: speeds,
        width,
        height,
        lats,
        lons,
        north,
        south,
        west,
        east,
        totalHours: hourCount,
        landMask,
        // Real forecast-hour offsets per step-index (waves are 3-hourly;
        // currents are 1-hourly, so this equals [0,1,...] for them).
        hourOffsets,
    };
}
