/**
 * radarGlassEngine — view math, frame planning, tile fetching and
 * compositing for the Glass radar card (EssentialMapSlide).
 *
 * The card frames the punter's position with a fixed ~300 nm reach in every
 * direction, so the zoom is continuous (computed from the measured container)
 * rather than a stepped slippy zoom. Radar tiles are fetched at the nearest
 * integer zoom and pre-composited once per timeline frame into a
 * container-sized canvas; scrubbing and playback then cost two drawImage
 * calls per repaint. Everything is CPU/2D-canvas — this surface deliberately
 * avoids WebGL (see HeroSlide: static map to prevent GPU heating).
 *
 * Timeline sources:
 *   past      → RainViewer public radar index (observed, ~10 min cadence)
 *   forecast  → Rainbow.ai nowcast tiles via proxy-rainbow (+10 min … +4 h)
 *
 * Rainbow requests ride the authenticated Supabase lane when a session
 * exists — the credentialless public bucket is only 30 snapshots/hr per IP
 * and exhausting it is exactly how the old card died.
 */

import { CapacitorHttp } from '@capacitor/core';
import { piCache } from '../../../services/PiCacheService';
import { getAuthenticatedFunctionHeaders } from '../../../services/supabaseAuth';
import { buildRainViewerTileUrl } from '../../../services/weather/api/rainviewerTiles';
import { fetchRainviewerIndex } from '../../../services/weather/api/rainviewerIndex';
import { createLogger } from '../../../utils/createLogger';
import { registerDetachedCanvasAccountant } from '../../../utils/animationBudget';
import { sniffImageMime } from '../../../utils/imageBytes';

const log = createLogger('RadarGlass');

export const RADAR_RADIUS_NM = 300;
export const RADAR_OPACITY = 0.7;
const NM_IN_METERS = 1852;
const EQUATOR_M = 40075016.686;
const WORLD_TILE = 256;
/** Observed history to keep on the scrubber (seconds). */
const PAST_WINDOW_SEC = 90 * 60;
/** Rainbow forecast steps: 10-min out to +2 h, then 30-min out to +4 h. */
const FORECAST_SECS: number[] = [...Array.from({ length: 12 }, (_, i) => (i + 1) * 600), 9000, 10800, 12600, 14400];
// 20, down from 36 (2026-08-04): frame canvases are detached, UNPURGEABLE
// backing store (~600KB each at card size) in an app that already lives near
// the WKWebView memory ceiling. 20 covers the visible timeline comfortably;
// deeper scrubs refetch from the (cheap, cached) tile layer.
const MAX_FRAME_CANVASES = 20;
const SNAPSHOT_TTL_MS = 4 * 60 * 1000;

// ── View geometry ─────────────────────────────────────────────

export interface RadarView {
    lat: number;
    lon: number;
    wCss: number;
    hCss: number;
    /** Fractional zoom in the 256-px slippy convention. */
    z: number;
    /** Integer zoom radar tiles are fetched at. */
    zt: number;
    /** Grid signature — part of the composited-frame cache key. */
    key: string;
}

/**
 * Frame the view so the SMALLER container dimension spans 2×RADAR_RADIUS_NM;
 * the longer dimension then shows a little more than 300 nm each way.
 */
export function computeRadarView(lat: number, lon: number, wCss: number, hCss: number): RadarView {
    const metersPerPx = (2 * RADAR_RADIUS_NM * NM_IN_METERS) / Math.max(1, Math.min(wCss, hCss));
    const latRad = (lat * Math.PI) / 180;
    const rawZ = Math.log2((EQUATOR_M * Math.cos(latRad)) / (WORLD_TILE * metersPerPx));
    const z = Math.min(9, Math.max(2.5, rawZ));
    // Prefer downscaling tiles slightly (crisper) over upscaling. Ceiling 7
    // keeps RainViewer at its native max; Rainbow precip allows 12.
    const zt = Math.min(7, Math.max(3, Math.ceil(z - 0.2)));
    const key = `${zt}:${lat.toFixed(3)}:${lon.toFixed(3)}:${wCss}x${hCss}`;
    return { lat, lon, wCss, hCss, z, zt, key };
}

export interface TilePlan {
    tx: number;
    ty: number;
    /** CSS-px placement inside the container. */
    left: number;
    top: number;
    span: number;
}

/** Tiles (with placements) covering the view at view.zt. */
export function planTiles(view: RadarView): TilePlan[] {
    const n = Math.pow(2, view.zt);
    // One zt-tile's width in css px at the fractional display zoom.
    const span = WORLD_TILE * Math.pow(2, view.z - view.zt);
    const cx = ((view.lon + 180) / 360) * n;
    const latRad = (view.lat * Math.PI) / 180;
    const cy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

    const minTx = Math.floor(cx - view.wCss / 2 / span);
    const maxTx = Math.floor(cx + view.wCss / 2 / span);
    const minTy = Math.floor(cy - view.hCss / 2 / span);
    const maxTy = Math.floor(cy + view.hCss / 2 / span);

    const tiles: TilePlan[] = [];
    for (let ty = minTy; ty <= maxTy; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = minTx; tx <= maxTx; tx++) {
            tiles.push({
                tx: ((tx % n) + n) % n,
                ty,
                left: view.wCss / 2 + (tx - cx) * span,
                top: view.hCss / 2 + (ty - cy) * span,
                span,
            });
        }
    }
    return tiles;
}

/**
 * Mapbox Static Images URL matching the view exactly. The Static API uses
 * the 512-px tile convention, hence the −1 on the zoom. `extraZoom` (log2 of
 * the pinch factor) re-renders the basemap crisp at a zoomed-in view.
 */
export function buildBasemapUrl(view: RadarView, token: string, extraZoom = 0): string {
    const zStatic = Math.max(0, view.z - 1 + extraZoom).toFixed(2);
    const w = Math.min(1280, view.wCss);
    const h = Math.min(1280, view.hCss);
    return (
        `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/` +
        `${view.lon.toFixed(4)},${view.lat.toFixed(4)},${zStatic},0/${w}x${h}@2x` +
        `?access_token=${token}&attribution=false&logo=false`
    );
}

// ── Frame planning ────────────────────────────────────────────

export interface RadarFrame {
    /** Stable identity for caching (source + provider timestamp/path). */
    id: string;
    /** Unix seconds this frame is valid for. */
    time: number;
    kind: 'past' | 'forecast';
    source: 'rainviewer' | 'rainbow';
    buildTileUrl: (tile: TilePlan, view: RadarView) => string;
    needsSupabaseAuth: boolean;
}

export interface RadarTimeline {
    frames: RadarFrame[];
    /** Index of the newest observed frame — the "NOW" anchor. */
    nowIdx: number;
    snapshot: number | null;
}

function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

function getSupabaseAnonKey(): string {
    if (typeof import.meta !== 'undefined') {
        return import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY || '';
    }
    return '';
}

async function getRainbowHeaders(): Promise<Record<string, string>> {
    try {
        return await getAuthenticatedFunctionHeaders();
    } catch {
        const anon = getSupabaseAnonKey();
        return anon ? { Authorization: `Bearer ${anon}`, apikey: anon } : {};
    }
}

let snapshotCache: { value: number; fetchedAt: number } | null = null;
let snapshotInflight: Promise<number | null> | null = null;

/** Current Rainbow.ai tile snapshot id (600-s-aligned unix time), cached 4 min. */
export async function fetchRainbowSnapshot(): Promise<number | null> {
    if (snapshotCache && Date.now() - snapshotCache.fetchedAt < SNAPSHOT_TTL_MS) {
        return snapshotCache.value;
    }
    if (snapshotInflight) return snapshotInflight;

    snapshotInflight = (async (): Promise<number | null> => {
        const supabaseUrl = getSupabaseUrl();
        if (!supabaseUrl) return null;
        const url = `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot`;
        try {
            let data: { snapshot?: unknown } | null = null;
            // Boat network first — the Pi shares one upstream fetch fleet-wide.
            if (piCache.isAvailable()) {
                try {
                    const piUrl = piCache.passthroughUrl(url, SNAPSHOT_TTL_MS, 'rainbow-snapshot');
                    if (piUrl) {
                        const res = await fetch(piUrl, { signal: AbortSignal.timeout(8000) });
                        if (res.ok) data = await res.json();
                    }
                } catch {
                    /* Pi down — fall through to direct */
                }
            }
            if (!data) {
                // CapacitorHttp: WebView fetch() to Supabase functions has
                // silently failed on iOS before (see rainbowPrecip.ts).
                const headers = await getRainbowHeaders();
                try {
                    const res = await CapacitorHttp.get({ url, headers, readTimeout: 10000, connectTimeout: 10000 });
                    if (res.status === 200 && res.data) {
                        data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                    }
                } catch {
                    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
                    if (res.ok) data = await res.json();
                }
            }
            const snapshot = typeof data?.snapshot === 'number' ? data.snapshot : null;
            if (snapshot) {
                snapshotCache = { value: snapshot, fetchedAt: Date.now() };
                return snapshot;
            }
            log.warn('Rainbow snapshot unavailable — forecast frames disabled');
            return null;
        } catch (err) {
            log.warn('Rainbow snapshot fetch failed', err);
            return null;
        } finally {
            snapshotInflight = null;
        }
    })();
    return snapshotInflight;
}

/** Assemble the scrubber timeline: RainViewer history + Rainbow forecast. */
export async function planRadarFrames(): Promise<RadarTimeline> {
    const nowSec = Date.now() / 1000;
    const supabaseUrl = getSupabaseUrl();

    const [index, snapshot] = await Promise.all([fetchRainviewerIndex().catch(() => null), fetchRainbowSnapshot()]);

    const frames: RadarFrame[] = [];

    const past = (index?.radar?.past ?? []).filter((f) => nowSec - f.time < PAST_WINDOW_SEC);
    for (const f of past) {
        frames.push({
            id: `rv|${f.path}`,
            time: f.time,
            kind: 'past',
            source: 'rainviewer',
            needsSupabaseAuth: false,
            buildTileUrl: (t, v) =>
                buildRainViewerTileUrl(f.path, { host: index?.host, size: 512, zoom: v.zt, x: t.tx, y: t.ty }),
        });
    }

    if (snapshot && supabaseUrl) {
        const lastPast = frames.length ? frames[frames.length - 1].time : 0;
        const secs = frames.length ? FORECAST_SECS : [0, ...FORECAST_SECS];
        for (const f of secs) {
            const time = snapshot + f;
            // Skip forecast steps that land behind the observed history.
            if (time <= lastPast + 60) continue;
            frames.push({
                id: `rb|${snapshot}|${f}`,
                time,
                kind: 'forecast',
                source: 'rainbow',
                needsSupabaseAuth: true,
                buildTileUrl: (t, v) =>
                    `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile` +
                    // color=4 (Weather Channel), not 6: this canvas has no
                    // Mapbox raster-color to ramp grayscale with, so it must
                    // take a server-baked palette — and it must be the SAME
                    // family the observed RainViewer tiles beside it are baked
                    // in (RAINVIEWER_COLOR_SCHEME = 4) and the Obs map's
                    // forecast ramp targets. Otherwise this card shows two
                    // colour maps for one quantity, exactly as the chart did
                    // until 2026-08-21.
                    `&snapshot=${snapshot}&forecast=${f}&z=${v.zt}&x=${t.tx}&y=${t.ty}&color=4`,
            });
        }
    }

    frames.sort((a, b) => a.time - b.time);
    let nowIdx = 0;
    for (let i = 0; i < frames.length; i++) {
        if (frames[i].time <= nowSec + 60) nowIdx = i;
    }
    return { frames, nowIdx, snapshot };
}

// ── Tile fetching + frame compositing ─────────────────────────

async function blobToDrawable(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
    // Never hand unproven bytes to the decoder — a 200-status error page or
    // truncated body faults ImageIO, and on beta WebKit a decoder fault is a
    // renderer kill ("'WEBP' initImage failed err=-50", 2026-08-04).
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (!sniffImageMime(head, blob.size)) return null;
    if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
    }
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function fetchTileDrawable(
    directUrl: string,
    needsSupabaseAuth: boolean,
    signal: AbortSignal,
): Promise<ImageBitmap | HTMLImageElement | null> {
    // Boat network cache first — no credential needed on the LAN hop.
    const piUrl = piCache.passthroughTileUrl(directUrl);
    if (piUrl) {
        try {
            const res = await fetch(piUrl, { signal });
            if (res.ok) return await blobToDrawable(await res.blob());
        } catch {
            /* Pi miss — fall through to direct */
        }
    }
    const headers = needsSupabaseAuth ? await getRainbowHeaders() : undefined;
    try {
        const res = await fetch(directUrl, { headers, signal });
        if (res.ok) return await blobToDrawable(await res.blob());
        return null;
    } catch (err) {
        if (signal.aborted) return null;
        // Native fallback: CapacitorHttp bypasses WebView cross-origin quirks.
        if (needsSupabaseAuth) {
            try {
                const res = await CapacitorHttp.get({
                    url: directUrl,
                    headers,
                    responseType: 'blob',
                    readTimeout: 12000,
                    connectTimeout: 12000,
                });
                if (res.status === 200 && typeof res.data === 'string' && res.data.length > 0) {
                    const bin = atob(res.data);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    if (signal.aborted) return null;
                    // Decode ONLY bytes that prove they are a complete image
                    // (shared sniff: full PNG magic, RIFF-length-validated
                    // WebP). Anything else is a tile miss, never a decode.
                    const sniffed = sniffImageMime(bytes);
                    if (!sniffed) return null;
                    return await blobToDrawable(new Blob([bytes], { type: sniffed }));
                }
            } catch {
                /* give up on this tile */
            }
        }
        if (!signal.aborted) log.warn('Radar tile fetch failed', err);
        return null;
    }
}

/** Composited frames, LRU-capped. Keyed by frame id + grid signature. */
const frameCanvasCache = new Map<string, HTMLCanvasElement>();
const framesInflight = new Map<string, Promise<boolean>>();

// These canvases live OUTSIDE the DOM, invisible to the page-health guard's
// document query — report them so the device log carries the true total.
registerDetachedCanvasAccountant('radar-frames', () => {
    let bytes = 0;
    for (const canvas of frameCanvasCache.values()) bytes += canvas.width * canvas.height * 4;
    return { count: frameCanvasCache.size, bytes };
});

function frameCacheKey(frame: RadarFrame, view: RadarView): string {
    return `${frame.id}|${view.key}`;
}

export function getFrameCanvas(frame: RadarFrame, view: RadarView): HTMLCanvasElement | undefined {
    const key = frameCacheKey(frame, view);
    const hit = frameCanvasCache.get(key);
    if (hit) {
        // Refresh LRU position.
        frameCanvasCache.delete(key);
        frameCanvasCache.set(key, hit);
    }
    return hit;
}

async function compositeFrame(frame: RadarFrame, view: RadarView, signal: AbortSignal): Promise<boolean> {
    const key = frameCacheKey(frame, view);
    if (frameCanvasCache.has(key)) return true;
    // Another slide instance may already be compositing this frame — share it.
    const pending = framesInflight.get(key);
    if (pending) return pending;
    const work = (async (): Promise<boolean> => {
        const tiles = planTiles(view);
        const drawables = await Promise.all(
            tiles.map((t) => fetchTileDrawable(frame.buildTileUrl(t, view), frame.needsSupabaseAuth, signal)),
        );
        if (signal.aborted) return false;
        if (!drawables.some(Boolean)) return false;

        // dpr 1 on purpose: radar data is coarser than css pixels already,
        // and 24 retina-sized buffers is exactly the OOM shape this app has
        // been bitten by before.
        const canvas = document.createElement('canvas');
        canvas.width = view.wCss;
        canvas.height = view.hCss;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        // OFF for indexed-palette radar tiles. Bilinear smoothing averages
        // ADJACENT PALETTE COLOURS — blending a blue light-rain pixel with a
        // red heavy-rain pixel yields a purple that means no intensity at all,
        // and the palette stops matching the legend at every tile seam. Sharp
        // pixels tell the truth; the softness was never worth an invented
        // colour (recon, 2026-08-21).
        ctx.imageSmoothingEnabled = false;
        for (let i = 0; i < tiles.length; i++) {
            const d = drawables[i];
            if (!d) continue;
            const t = tiles[i];
            ctx.drawImage(d, t.left, t.top, t.span, t.span);
            if ('close' in d) d.close();
        }
        frameCanvasCache.set(key, canvas);
        while (frameCanvasCache.size > MAX_FRAME_CANVASES) {
            const oldest = frameCanvasCache.keys().next().value;
            if (oldest === undefined) break;
            frameCanvasCache.delete(oldest);
        }
        return true;
    })();
    const tracked = work.finally(() => framesInflight.delete(key));
    framesInflight.set(key, tracked);
    return tracked;
}

/**
 * Load every frame's tiles and pre-composite them, nearest-to-now first so
 * the card is interactive as soon as the LIVE frame lands. Calls onFrameReady
 * after each completed frame.
 */
export async function loadRadarFrames(
    timeline: RadarTimeline,
    view: RadarView,
    signal: AbortSignal,
    onFrameReady: (frame: RadarFrame) => void,
): Promise<void> {
    const anchor = timeline.frames[timeline.nowIdx]?.time ?? Date.now() / 1000;
    const queue = [...timeline.frames].sort((a, b) => Math.abs(a.time - anchor) - Math.abs(b.time - anchor));
    const CONCURRENCY = 3;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length > 0 && !signal.aborted) {
            const frame = queue.shift();
            if (!frame) return;
            try {
                const ok = await compositeFrame(frame, view, signal);
                if (ok && !signal.aborted) onFrameReady(frame);
            } catch (err) {
                if (!signal.aborted) log.warn(`Radar frame ${frame.id} failed`, err);
            }
        }
    });
    await Promise.all(workers);
}
