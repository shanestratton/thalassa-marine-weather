/**
 * voyageShareCard — a shareable Strava-style voyage summary image.
 *
 * Renders a SELF-CONTAINED SVG card (stats + a simplified track polyline
 * drawn from lat/lon — NO map tiles) and rasterises it to a PNG via an
 * offscreen canvas. We deliberately do NOT snapshot the live Leaflet map:
 * its cross-origin raster tiles taint the canvas and can't be exported.
 * A tile-free SVG has no CORS taint, so canvas.toDataURL works.
 *
 * The pure parts (model, projection, SVG string) are unit-tested; the
 * rasterise + native share steps are thin DOM/Capacitor wrappers.
 */
import type { ShipLogEntry } from '../../types';
import { isTrackworthyEntry, calculateDistanceNM } from './helpers';

export interface SummaryCardModel {
    title: string;
    dateLabel: string;
    distanceNM: number;
    durationLabel: string;
    avgKts: number;
    maxWindKt: number | null;
    pointCount: number;
    /** Track points (lat/lon) for the card polyline. */
    track: Array<{ lat: number; lon: number }>;
}

function durationLabel(ms: number): string {
    if (ms <= 0) return '0m';
    const days = Math.floor(ms / 86400000);
    const hrs = Math.floor((ms % 86400000) / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (days > 0) return `${days}d ${hrs}h`;
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

/**
 * Build the card's data model from a voyage's entries. Distance is
 * max(cumulative) with a haversine-sum fallback (mirrors the viewer), so
 * out-and-back and legacy-zeroed voyages still read right.
 */
export function buildSummaryCardModel(entries: ShipLogEntry[], opts: { title?: string } = {}): SummaryCardModel {
    const track = entries
        .filter(isTrackworthyEntry)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .map((e) => ({ lat: e.latitude as number, lon: e.longitude as number }));

    const sorted = entries
        .filter(isTrackworthyEntry)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let distanceNM = Math.max(0, ...sorted.map((e) => e.cumulativeDistanceNM || 0));
    if (distanceNM === 0 && sorted.length > 1) {
        for (let i = 1; i < sorted.length; i++) {
            distanceNM += calculateDistanceNM(
                sorted[i - 1].latitude as number,
                sorted[i - 1].longitude as number,
                sorted[i].latitude as number,
                sorted[i].longitude as number,
            );
        }
    }

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const durMs = first && last ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime() : 0;

    const speeds = sorted.filter((e) => typeof e.speedKts === 'number' && e.speedKts! > 0).map((e) => e.speedKts!);
    const avgKts = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

    let maxWindKt: number | null = null;
    for (const e of sorted) if (typeof e.windSpeed === 'number') maxWindKt = Math.max(maxWindKt ?? 0, e.windSpeed);

    const dateLabel = first
        ? new Date(first.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';

    return {
        title: opts.title || 'VOYAGE TRACK',
        dateLabel,
        distanceNM,
        durationLabel: durationLabel(durMs),
        avgKts,
        maxWindKt,
        pointCount: sorted.length,
        track,
    };
}

/**
 * Project lat/lon points into a w×h box (with padding), preserving aspect
 * ratio so the track isn't squashed, centred, y flipped (north up). Empty
 * / single-point inputs return a safe centred point.
 */
export function normaliseTrackToViewBox(
    points: Array<{ lat: number; lon: number }>,
    w: number,
    h: number,
    pad = 24,
): Array<{ x: number; y: number }> {
    if (points.length === 0) return [];
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    // Longitude degrees shrink with latitude — scale lon by cos(midLat) so
    // the shape's proportions are true.
    const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1e-6;
    const spanX = Math.max((maxLon - minLon) * cosLat, 1e-9);
    const spanY = Math.max(maxLat - minLat, 1e-9);
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const scale = Math.min(innerW / spanX, innerH / spanY);
    const drawnW = spanX * scale;
    const drawnH = spanY * scale;
    const offX = pad + (innerW - drawnW) / 2;
    const offY = pad + (innerH - drawnH) / 2;
    return points.map((p) => ({
        x: offX + (p.lon - minLon) * cosLat * scale,
        y: offY + (maxLat - p.lat) * scale, // flip: north up
    }));
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the self-contained SVG card string (no external resources). */
export function buildVoyageCardSvg(model: SummaryCardModel, size = 1080): string {
    const mapH = Math.round(size * 0.52);
    const pts = normaliseTrackToViewBox(model.track, size, mapH, 70);
    const line =
        pts.length >= 2 ? pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') : '';
    const start = pts[0];
    const end = pts[pts.length - 1];

    const stat = (x: number, value: string, label: string) =>
        `<text x="${x}" y="${size - 150}" fill="#ffffff" font-size="64" font-weight="800" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif">${esc(value)}</text>` +
        `<text x="${x}" y="${size - 108}" fill="#94a3b8" font-size="26" font-weight="700" text-anchor="middle" letter-spacing="2" font-family="-apple-system,Helvetica,Arial,sans-serif">${esc(label)}</text>`;

    const q = size / 5;
    const stats =
        stat(q, `${model.distanceNM.toFixed(1)}`, 'NM') +
        stat(q * 2, model.durationLabel, 'TIME') +
        stat(q * 3, `${model.avgKts.toFixed(1)}`, 'AVG KT') +
        stat(q * 4, model.maxWindKt != null ? `${Math.round(model.maxWindKt)}` : '—', 'MAX WIND');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="#0f172a"/>
<rect x="0" y="0" width="${size}" height="${mapH}" fill="#111c30"/>
${line ? `<path d="${line}" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>` : ''}
${line ? `<path d="${line}" fill="none" stroke="#22c55e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
${start ? `<circle cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="16" fill="#34d399" stroke="#ffffff" stroke-width="4"/>` : ''}
${end ? `<circle cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="16" fill="#ef4444" stroke="#ffffff" stroke-width="4"/>` : ''}
<text x="70" y="${mapH + 96}" fill="#ffffff" font-size="58" font-weight="800" font-family="-apple-system,Helvetica,Arial,sans-serif">${esc(model.title)}</text>
<text x="70" y="${mapH + 146}" fill="#38bdf8" font-size="30" font-weight="700" letter-spacing="1" font-family="-apple-system,Helvetica,Arial,sans-serif">${esc(model.dateLabel)} · ${model.pointCount} pts</text>
${stats}
<text x="${size - 70}" y="${size - 50}" fill="#475569" font-size="30" font-weight="800" text-anchor="end" letter-spacing="3" font-family="-apple-system,Helvetica,Arial,sans-serif">THALASSA</text>
</svg>`;
}

/** Rasterise an SVG string to a base64 PNG via an offscreen canvas. */
export async function rasterizeSvgToPngBase64(svg: string, size = 1080): Promise<string> {
    return new Promise((resolve, reject) => {
        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('no 2d context');
                ctx.drawImage(img, 0, 0, size, size);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/png').split(',')[1]);
            } catch (e) {
                URL.revokeObjectURL(url);
                reject(e);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('svg rasterise failed'));
        };
        img.src = url;
    });
}

/**
 * Build + rasterise + native-share a voyage summary card. Writes the PNG
 * to the cache dir first (passing a raw data URL to Share.share doesn't
 * reliably attach on iOS), then shares the file.
 */
export async function shareVoyageCard(entries: ShipLogEntry[], opts: { title?: string } = {}): Promise<void> {
    const model = buildSummaryCardModel(entries, opts);
    const svg = buildVoyageCardSvg(model);
    const base64 = await rasterizeSvgToPngBase64(svg);

    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const fileName = `voyage_${Date.now()}.png`;
    const res = await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache });
    await Share.share({
        title: model.title,
        text: `${model.distanceNM.toFixed(1)} NM · ${model.durationLabel} — logged with Thalassa`,
        files: [res.uri],
        dialogTitle: 'Share voyage',
    });
}
