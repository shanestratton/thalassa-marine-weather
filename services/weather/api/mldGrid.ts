/**
 * mldGrid — fetches CMEMS mixed-layer-depth daily binaries produced
 * by scripts/cmems-mld-pipeline/pipeline.py.
 *
 * Same v2 THCU binary as the rest of the CMEMS layer suite — the
 * pipeline log10-normalises MLD over [1m, 1000m] and packs the
 * result into the u-channel. Frontend extracts u[step] as the data
 * plane and renders with the plasma ramp.
 */
import type { WindGrid } from '../windField';
import { createLogger } from '../../../utils/createLogger';
import { API_BASE } from '../../native/apiBase';

const log = createLogger('mldGrid');

const MAGIC = 0x55434854; // 'THCU' little-endian u32
const HEADER_SIZE = 30;

// Resolves to '/api/mld' on web and to the configured production URL
// on native (Capacitor has no proxy for relative /api paths).
const BASE = `${API_BASE}/mld`;

export interface MldManifest {
    version: number;
    generated_at: string;
    hours: Array<{ hour: number; file: string; bytes: number }>;
}

export async function fetchMldManifest(): Promise<MldManifest | null> {
    try {
        // 'default' lets the browser reuse the manifest within the edge
        // proxy's max-age=600 window — pipeline updates once daily so a
        // 10min reuse is safe and saves a round-trip on every layer toggle.
        const res = await fetch(`${BASE}/manifest.json`, { cache: 'default' });
        if (!res.ok) {
            log.warn(`Manifest fetch failed: ${res.status}`);
            return null;
        }
        return (await res.json()) as MldManifest;
    } catch (err) {
        log.warn('Manifest fetch error', err);
        return null;
    }
}

let cachedGrid: WindGrid | null = null;
let inflight: Promise<WindGrid | null> | null = null;

export async function fetchMldGrid(): Promise<WindGrid | null> {
    if (cachedGrid) return cachedGrid;
    if (inflight) return inflight;
    inflight = doFetchMldGrid().finally(() => {
        inflight = null;
    });
    const grid = await inflight;
    if (grid) cachedGrid = grid;
    return grid;
}

async function doFetchMldGrid(): Promise<WindGrid | null> {
    const manifest = await fetchMldManifest();
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

    const cacheBust = manifest.generated_at ? `?t=${encodeURIComponent(manifest.generated_at)}` : '';

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

        const uOffset = HEADER_SIZE;
        const vOffset = uOffset + w * h * 4;
        const maskOffset = vOffset + w * h * 4;
        const u = new Float32Array(buf.slice(uOffset, uOffset + w * h * 4));
        const v = new Float32Array(buf.slice(vOffset, vOffset + w * h * 4));

        if (version >= 2 && landMask === undefined && buf.byteLength >= maskOffset + w * h) {
            landMask = new Uint8Array(buf.slice(maskOffset, maskOffset + w * h));
        }

        const speed = new Float32Array(w * h); // unused for scalar layers
        us[stepIdx] = u;
        vs[stepIdx] = v;
        speeds[stepIdx] = speed;
    }

    const lats: number[] = new Array(height);
    const lons: number[] = new Array(width);
    const latStep = height > 1 ? (south - north) / (height - 1) : 0;
    const lonStep = width > 1 ? (east - west) / (width - 1) : 0;
    for (let r = 0; r < height; r++) lats[r] = north + r * latStep;
    for (let c = 0; c < width; c++) lons[c] = west + c * lonStep;

    const oceanCells = landMask ? width * height - landMask.reduce((a, b) => a + b, 0) : null;
    log.info(
        `Loaded mld: ${hourCount}d × ${width}×${height}, bounds n=${north} s=${south} w=${west} e=${east}` +
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
        hourOffsets,
        // Pipeline run time — day 0 of the MLD forecast. Used by
        // useWeatherLayers to align the scrubber to wall-clock "Today".
        refTime: manifest.generated_at,
    };
}
