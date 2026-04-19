/**
 * currentsGrid — fetches CMEMS ocean-currents hourly binaries produced
 * by scripts/cmems-currents-pipeline/pipeline.py.
 *
 * The pipeline attaches binaries to a rolling GitHub Release but the
 * release URLs 302 to objects.githubusercontent.com which lacks CORS
 * headers, so the client fetches through a same-origin rewrite:
 *   /currents/manifest.json  →  github.com release asset
 *   /currents/h00.bin        →  github.com release asset
 * The rewrite is defined in vite.config.ts (dev) and vercel.json (prod).
 *
 * Binary layout (see scripts/cmems-currents-pipeline/pipeline.py):
 *   bytes  0..3   magic 'THCU'
 *   byte   4      version (1)
 *   byte   5      reserved
 *   u16    6..7   width
 *   u16    8..9   height
 *   f32   10..25  north, south, west, east
 *   u16   26..27  hours (=1)
 *   u16   28..29  reserved
 *   f32[w*h]      u  (east velocity m/s)
 *   f32[w*h]      v  (north velocity m/s)
 */
import type { WindGrid } from '../windField';
import { createLogger } from '../../../utils/createLogger';

const log = createLogger('currentsGrid');

const MAGIC = 0x55434854; // 'THCU' little-endian u32
const HEADER_SIZE = 30;

/** Same-origin base — the Vite/Vercel rewrite proxies these to the GitHub Release. */
const BASE = '/currents';

export interface CurrentsManifest {
    version: number;
    generated_at: string;
    hours: Array<{ hour: number; file: string; bytes: number }>;
}

export async function fetchCurrentsManifest(): Promise<CurrentsManifest | null> {
    try {
        const res = await fetch(`${BASE}/manifest.json`, { cache: 'no-cache' });
        if (!res.ok) {
            log.warn(`Manifest fetch failed: ${res.status}`);
            return null;
        }
        return (await res.json()) as CurrentsManifest;
    } catch (err) {
        log.warn('Manifest fetch error', err);
        return null;
    }
}

/**
 * Fetch every hour's binary and assemble a WindGrid-shaped result so
 * the existing WebGL particle layer consumes it without changes.
 */
export async function fetchCurrentsGrid(): Promise<WindGrid | null> {
    const manifest = await fetchCurrentsManifest();
    if (!manifest || manifest.hours.length === 0) return null;

    const hourCount = manifest.hours.length;
    const us: Float32Array[] = new Array(hourCount);
    const vs: Float32Array[] = new Array(hourCount);
    const speeds: Float32Array[] = new Array(hourCount);

    let width = 0;
    let height = 0;
    let north = 0;
    let south = 0;
    let west = 0;
    let east = 0;

    // Fetch all hours in parallel — each file is ~2 MB, user pays this
    // once when currents toggles on.
    const parsed = await Promise.all(
        manifest.hours.map(async (entry) => {
            const res = await fetch(`${BASE}/${entry.file}`, { cache: 'default' });
            if (!res.ok) throw new Error(`hour ${entry.hour}: HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            return { hour: entry.hour, buf };
        }),
    );

    for (const { hour, buf } of parsed) {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== MAGIC) {
            throw new Error(`hour ${hour}: bad magic`);
        }
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
        const u = new Float32Array(buf.slice(uOffset, uOffset + w * h * 4));
        const v = new Float32Array(buf.slice(vOffset, vOffset + w * h * 4));
        const speed = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            speed[i] = Math.hypot(u[i], v[i]);
        }
        us[hour] = u;
        vs[hour] = v;
        speeds[hour] = speed;
    }

    // Build lat/lon axes. Pipeline writes rows north→south, cols west→east.
    const lats: number[] = new Array(height);
    const lons: number[] = new Array(width);
    const latStep = height > 1 ? (south - north) / (height - 1) : 0;
    const lonStep = width > 1 ? (east - west) / (width - 1) : 0;
    for (let r = 0; r < height; r++) lats[r] = north + r * latStep;
    for (let c = 0; c < width; c++) lons[c] = west + c * lonStep;

    log.info(`Loaded currents: ${hourCount}h × ${width}×${height}, bounds n=${north} s=${south} w=${west} e=${east}`);

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
    };
}
