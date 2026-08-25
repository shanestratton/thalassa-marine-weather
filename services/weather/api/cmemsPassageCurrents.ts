/**
 * cmemsPassageCurrents — passage-briefing samples from Thalassa's OWN
 * CMEMS currents pipeline: the same verified THCU frames the Obs particle
 * layer paints (cmems_mod_glo_phy_anfc_merged-uv_PT1H-i — hourly TOTAL
 * current: geostrophic + tides + wind-driven), instead of a third-party
 * feed.
 *
 * Primary source for OceanCurrentService since 2026-08-25 (Shane: "you can
 * do this for me so it will be ready in the morning"), the same day NOAA
 * retired the previous ERDDAP dataset chain out from under the briefing.
 * NOAA blended remains the fallback; this module answers null on ANY
 * doubt — a missing manifest, a stale frame, an empty sample — and the
 * caller falls through. It must never convert uncertainty into an apparent
 * zero-current field.
 *
 * Frame lifecycle: fetchCurrentsGrid shares the bounded verified frame
 * cache with the Obs layer (2 frames / 32 MB). Deliberately NO release
 * here — releaseCurrentsGrid() bumps the dataset epoch and would yank a
 * frame out from under a live particle layer on the map.
 */
import { createLogger } from '../../../utils/createLogger';
import { fetchCurrentsGrid, fetchCurrentsManifest } from './currentsGrid';

const log = createLogger('cmemsPassageCurrents');

export interface CmemsPassageVector {
    lat: number;
    lon: number;
    /** m/s, +east */
    u: number;
    /** m/s, +north */
    v: number;
}

export interface CmemsPassageSample {
    vectors: CmemsPassageVector[];
    /** The frame's own data_time — the honesty field the card shows. */
    dataTime: string;
    datasetId: string;
    generation: string;
}

/** Cap so a long passage cannot turn the briefing into a megavector soup —
 *  the NOAA path returned ~150-250 cells for a 240 NM passage; parity. */
export const CMEMS_PASSAGE_MAX_VECTORS = 300;

/** A pipeline whose nearest frame lies more than this off the wall clock
 *  is dead or wedged — fall back rather than brief on old water. The
 *  publisher cuts 13 hourly frames several times a day; healthy skew is
 *  minutes. */
export const CMEMS_PASSAGE_MAX_FRAME_SKEW_MS = 48 * 3_600_000;

interface Bbox {
    north: number;
    south: number;
    east: number;
    west: number;
}

/**
 * Sample the verified CMEMS currents frame nearest "now" over the passage
 * bbox. Null on any failure or doubt — the caller has a fallback chain.
 */
export async function sampleCmemsPassageCurrents(
    bbox: Bbox,
    nowMs: number = Date.now(),
): Promise<CmemsPassageSample | null> {
    // An antimeridian-crossing box needs split sampling this module does
    // not attempt (see the antimeridian projection saga) — let the
    // fallback provider answer instead of sampling the wrong hemisphere.
    if (bbox.west > bbox.east) return null;
    try {
        const manifest = await fetchCurrentsManifest();
        if (!manifest || manifest.dataset.key !== 'currents') return null;

        let best: { step: number; dataTime: string } | null = null;
        let bestSkewMs = Infinity;
        for (const file of manifest.files) {
            const t = Date.parse(file.data_time);
            if (!Number.isFinite(t)) continue;
            const skew = Math.abs(t - nowMs);
            if (skew < bestSkewMs) {
                bestSkewMs = skew;
                best = { step: file.step, dataTime: file.data_time };
            }
        }
        if (!best || bestSkewMs > CMEMS_PASSAGE_MAX_FRAME_SKEW_MS) {
            log.warn(`CMEMS frame skew ${Math.round(bestSkewMs / 3_600_000)}h exceeds guard — falling back`);
            return null;
        }

        const grid = await fetchCurrentsGrid(best.step);
        // Frames are SPARSE by step index — only the fetched plane exists.
        const uPlane = grid?.u?.[best.step];
        const vPlane = grid?.v?.[best.step];
        if (!grid || !uPlane || !vPlane) return null;

        // Row 0 is the NORTH edge (lats descend); row-major row*width+col.
        const rows: number[] = [];
        for (let r = 0; r < grid.height; r += 1) {
            const lat = grid.lats[r];
            if (lat <= bbox.north && lat >= bbox.south) rows.push(r);
        }
        const cols: number[] = [];
        for (let c = 0; c < grid.width; c += 1) {
            const lon = grid.lons[c];
            if (lon >= bbox.west && lon <= bbox.east) cols.push(c);
        }
        if (rows.length === 0 || cols.length === 0) return null;

        const stride = Math.max(1, Math.ceil(Math.sqrt((rows.length * cols.length) / CMEMS_PASSAGE_MAX_VECTORS)));
        const mask = grid.landMask;
        const vectors: CmemsPassageVector[] = [];
        for (let ri = 0; ri < rows.length; ri += stride) {
            const r = rows[ri];
            for (let ci = 0; ci < cols.length; ci += stride) {
                const c = cols[ci];
                const index = r * grid.width + c;
                if (mask && mask[index] === 1) continue;
                const u = uPlane[index];
                const v = vPlane[index];
                if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
                vectors.push({ lat: grid.lats[r], lon: grid.lons[c], u, v });
            }
        }
        if (vectors.length === 0) return null;

        return {
            vectors,
            dataTime: best.dataTime,
            datasetId: manifest.dataset.id,
            generation: manifest.generation,
        };
    } catch (error) {
        log.warn('CMEMS passage sample failed — falling back:', error);
        return null;
    }
}
