/**
 * useCycloneLayer — Renders active tropical cyclones on the Mapbox map.
 *
 * ALL elements render as DOM overlays ABOVE the wind particle layer:
 *   - Storm markers: mapboxgl.Marker (DOM, z-index 500)
 *   - Track lines: SVG overlay (DOM, z-index 450)
 *
 * Features:
 *   - Regional storm classification (Hurricane/Typhoon/Cyclone based on basin)
 *   - Semantic zoom: marker size + track detail scales with zoom level
 *   - Intensity-colored track segments
 *   - Track point dots at high zoom (> 8)
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { ActiveCyclone, CyclonePosition, GfsTrackerPosition } from '../../services/weather/CycloneTrackingService';
import { cloudOverlayBeforeId } from './imageryOrder';
import { mountCloudOverlay, removeCloudOverlay } from './cloudOverlay';
import { WindStore } from '../../stores/WindStore';

import { createLogger } from '../../utils/createLogger';

/**
 * The zoom the storm view opens at (Shane 2026-08-23: "can we start the storm
 * layer at zoom 2.1?").
 *
 * It used to open at 1 in three separate places, hard-coded. z1 is the whole
 * globe: at Newport that puts the Coral Sea storms and the Atlantic on screen
 * together, most of it ocean nobody is looking at. 2.1 is the frame Shane
 * settled on himself and asked for by name — the west Pacific and Australia,
 * which is the basin pair that actually matters from this boat.
 *
 * Not a floor: minZoom stays 1, so pulling further out still works. This is
 * only where the view LANDS.
 */
// 2, was 2.1 (Shane 2026-08-24, confirmed in septuplicate — "Choo Choo Two
// Two"). A nudge wider than the old hemisphere frame: every basin's storms on
// screen at once, and the card's stepper carries you into each one.
export const CYCLONE_OPEN_ZOOM = 2;

// ── Lazy-loaded heavy services (split into separate chunks) ──
// These are only fetched when the cyclone layer is activated.
const getCycloneService = () => import('../../services/weather/CycloneTrackingService');

const log = createLogger('useCycloneLayer');

// ── Category → Color mapping ──────────────────────────────

/** Category → color palette { core, mid, outer, glow } */
function categoryPalette(cat: number) {
    switch (cat) {
        case 5:
            return { core: '#1a0005', mid: '#9b0000', outer: '#ff2200', glow: '#ff4400', accent: '#ffd700' };
        case 4:
            return { core: '#1a0000', mid: '#b91c1c', outer: '#ef4444', glow: '#ff3333', accent: '#ff8c00' };
        case 3:
            return { core: '#1a0800', mid: '#c2410c', outer: '#f97316', glow: '#ff6600', accent: '#fbbf24' };
        case 2:
            return { core: '#1a1000', mid: '#b45309', outer: '#f59e0b', glow: '#ffaa00', accent: '#fde68a' };
        case 1:
            return { core: '#1a1500', mid: '#a16207', outer: '#eab308', glow: '#ffcc00', accent: '#fef08a' };
        default:
            return { core: '#0a1520', mid: '#0e7490', outer: '#06b6d4', glow: '#22d3ee', accent: '#a5f3fc' };
    }
}

function categoryColor(cat: number): string {
    return categoryPalette(cat).outer;
}

/** Color a track point by its wind speed */
function windColor(windKts: number | null): string {
    if (windKts == null) return '#94a3b8';
    if (windKts >= 137) return '#9333ea'; // Cat 5
    if (windKts >= 113) return '#dc2626'; // Cat 4
    if (windKts >= 96) return '#ea580c'; // Cat 3
    if (windKts >= 83) return '#d97706'; // Cat 2
    if (windKts >= 64) return '#eab308'; // Cat 1
    if (windKts >= 34) return '#06b6d4'; // TS
    return '#94a3b8'; // TD
}

// ── Regional storm classification ─────────────────────────
// ATCF uses single-letter basin codes:
//   L = Atlantic, E = Eastern Pacific, C = Central Pacific
//   W = Western Pacific
//   P = South Pacific / Australian region
//   S = South Indian Ocean
//   A = Arabian Sea, B = Bay of Bengal (North Indian)

function stormClassification(basin: string, windKts: number): string {
    const b = basin.toUpperCase();

    // Atlantic & Eastern/Central Pacific → Hurricane
    if (['L', 'AL', 'E', 'EP', 'C', 'CP'].includes(b)) {
        if (windKts >= 96) return 'Major Hurricane';
        if (windKts >= 64) return 'Hurricane';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // Western Pacific → Typhoon
    if (['W', 'WP'].includes(b)) {
        if (windKts >= 130) return 'Super Typhoon';
        if (windKts >= 64) return 'Typhoon';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // Australian & South Pacific
    if (['P', 'AU', 'SP'].includes(b)) {
        if (windKts >= 86) return 'Severe Tropical Cyclone';
        if (windKts >= 64) return 'Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // South Indian Ocean
    if (['S', 'SI'].includes(b)) {
        if (windKts >= 86) return 'Severe Tropical Cyclone';
        if (windKts >= 64) return 'Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // North Indian (Arabian Sea / Bay of Bengal) → Cyclonic Storm
    if (['A', 'B', 'IO', 'NI', 'BB', 'AS'].includes(b)) {
        if (windKts >= 64) return 'Very Severe Cyclonic Storm';
        if (windKts >= 48) return 'Severe Cyclonic Storm';
        if (windKts >= 34) return 'Cyclonic Storm';
        return 'Depression';
    }

    // Fallback — use generic terms
    if (windKts >= 86) return 'Severe Tropical Cyclone';
    if (windKts >= 34) return 'Tropical Storm';
    return 'Tropical Depression';
}

// ── Resolve truncated ATCF names (top-level for reuse) ────

const NUMBER_NAMES: Record<number, string> = {
    1: 'One',
    2: 'Two',
    3: 'Three',
    4: 'Four',
    5: 'Five',
    6: 'Six',
    7: 'Seven',
    8: 'Eight',
    9: 'Nine',
    10: 'Ten',
    11: 'Eleven',
    12: 'Twelve',
    13: 'Thirteen',
    14: 'Fourteen',
    15: 'Fifteen',
    16: 'Sixteen',
    17: 'Seventeen',
    18: 'Eighteen',
    19: 'Nineteen',
    20: 'Twenty',
    21: 'Twenty-One',
    22: 'Twenty-Two',
    23: 'Twenty-Three',
    24: 'Twenty-Four',
    25: 'Twenty-Five',
    26: 'Twenty-Six',
    27: 'Twenty-Seven',
    28: 'Twenty-Eight',
    29: 'Twenty-Nine',
    30: 'Thirty',
    31: 'Thirty-One',
    32: 'Thirty-Two',
    33: 'Thirty-Three',
    34: 'Thirty-Four',
    35: 'Thirty-Five',
};

/** Category → the words a forecaster uses. Swept with the badge in July
 *  because nothing else read it; back with the badge (2026-08-21). */
const categoryLabels: Record<string, string> = {
    TD: 'Tropical Depression',
    TS: 'Tropical Storm',
    '1': 'Category 1 Cyclone',
    '2': 'Category 2 Cyclone',
    '3': 'Category 3 Cyclone',
    '4': 'Category 4 Cyclone',
    '5': 'Category 5 Cyclone',
};

function resolveStormName(cyclone: ActiveCyclone): string {
    const raw = cyclone.name.toUpperCase().replace(/[^A-Z]/g, '');
    let bestMatch = '';
    let bestLen = 0;
    for (const [, fullName] of Object.entries(NUMBER_NAMES)) {
        const stripped = fullName.replace(/-/g, '').toUpperCase();
        if (stripped.startsWith(raw) || raw.startsWith(stripped)) {
            const overlap = Math.min(stripped.length, raw.length);
            if (overlap > bestLen) {
                bestLen = overlap;
                bestMatch = fullName;
            }
        }
    }
    if (bestMatch) return bestMatch;
    return cyclone.name.charAt(0).toUpperCase() + cyclone.name.slice(1).toLowerCase();
}

function createStormMarkerEl(cyclone: ActiveCyclone, zoom: number): HTMLElement {
    const _color = categoryColor(cyclone.category);
    const { windKts, pressureMb } = cyclone.currentPosition;
    const classification = stormClassification(cyclone.basin, windKts ?? cyclone.maxWindKts);

    const catStr =
        cyclone.category > 0
            ? `Cat ${cyclone.categoryLabel} · ${windKts ?? '?'} kts${pressureMb ? ` · ${pressureMb} hPa` : ''}`
            : `${cyclone.categoryLabel} · ${windKts ?? '?'} kts`;

    // Semantic zoom: scale marker elements
    const isMacro = zoom < 5;
    const showInfoBadge = true; // Always show info badge

    // Heatmap eye sizing scales continuously with zoom
    const catScale = Math.min(cyclone.category, 5) || 1;
    const zoomFactor = Math.max(0.5, Math.min(3, Math.pow(2, (zoom - 5) / 3)));
    const baseEye = isMacro ? 28 : 48;
    const eyeSize = Math.round((baseEye + catScale * 4) * zoomFactor);

    const pal = categoryPalette(cyclone.category);

    const el = document.createElement('div');
    el.className = 'cyclone-marker';
    el.style.cssText = `
        display: flex; flex-direction: column; align-items: center;
        pointer-events: none; z-index: 500;
        filter: drop-shadow(0 4px 20px ${pal.glow}80);
        transition: transform 0.3s ease;
    `;

    // ── Name banner ──
    const nameBanner = document.createElement('div');
    nameBanner.style.cssText = `
        font-weight: 800; color: #fff;
        -webkit-text-stroke: 0.5px rgba(0,0,0,0.8);
        text-shadow: 0 0 3px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,1), 0 0 8px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,1), -1px -1px 2px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,0.6);
        letter-spacing: 0.5px; margin-bottom: 6px; text-align: center;
        background: rgba(0,0,0,0.65); padding: 4px 14px; border-radius: 8px;
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        border: 1px solid rgba(0,0,0,0.5); line-height: 1.3;
    `;
    const classLabel = document.createElement('div');
    classLabel.style.cssText = `font-size: ${isMacro ? 8 : 10}px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.08em;`;
    classLabel.textContent = classification;
    nameBanner.appendChild(classLabel);
    const nameLabel = document.createElement('div');
    nameLabel.style.cssText = `font-size: ${isMacro ? 12 : 15}px;`;
    nameLabel.textContent = resolveStormName(cyclone);
    nameBanner.appendChild(nameLabel);
    el.appendChild(nameBanner);

    // ── Eye container ──
    const eyeContainer = document.createElement('div');
    eyeContainer.style.cssText = `
        position: relative; width: ${eyeSize}px; height: ${eyeSize}px;
        display: flex; align-items: center; justify-content: center;
    `;

    // ── Glow rings ──
    const numRings = isMacro ? 1 : Math.min(catScale, 3);
    for (let i = 0; i < numRings; i++) {
        const scale = 1.3 + i * 0.4;
        const opacity = 0.35 - i * 0.1;
        const delay = i * 0.6;
        const ring = document.createElement('div');
        const opHex = Math.round(opacity * 255)
            .toString(16)
            .padStart(2, '0');
        ring.style.cssText = `
            position: absolute; inset: -${4 + i * 6}px;
            border-radius: 40% 60% 55% 45% / 55% 45% 50% 50%;
            background: radial-gradient(ellipse 70% 80%, ${pal.outer}00 30%, ${pal.glow}${opHex} 65%, transparent 100%);
            animation: cyclone-morph ${3 + i * 0.7}s ease-in-out ${delay}s infinite alternate,
                       cyclone-pulse ${2 + i * 0.5}s ease-in-out ${delay}s infinite;
            transform: scale(${scale});
        `;
        eyeContainer.appendChild(ring);
    }

    // ── Spinning SVG eye ──
    const spinWrapper = document.createElement('div');
    spinWrapper.style.cssText = `
        position: relative; z-index: 2;
        width: ${Math.round(eyeSize * 0.9)}px; height: ${Math.round(eyeSize * 0.9)}px;
        display: flex; align-items: center; justify-content: center;
        animation: cyclone-eye-spin ${Math.max(2, 8 - catScale * 1.2)}s linear infinite;
    `;

    // Build SVG string (developer-authored paths, only numeric/color interpolation)
    const svgSize = Math.round(eyeSize * 0.85);
    let svgStr: string;
    if (cyclone.category >= 1) {
        let arms = `
            <path d="M54 42 C58 28, 68 10, 82 8 C90 6, 96 14, 94 24 C92 32, 84 36, 74 34 C68 33, 62 36, 58 42 Z"/>
            <path d="M46 58 C42 72, 32 90, 18 92 C10 94, 4 86, 6 76 C8 68, 16 64, 26 66 C32 67, 38 64, 42 58 Z"/>`;
        if (catScale >= 2) {
            arms += `
            <path d="M58 54 C72 58, 90 68, 92 82 C94 90, 86 96, 76 94 C68 92, 64 84, 66 74 C67 68, 64 62, 58 58 Z"/>
            <path d="M42 46 C28 42, 10 32, 8 18 C6 10, 14 4, 24 6 C32 8, 36 16, 34 26 C33 32, 36 38, 42 42 Z"/>`;
        }
        if (catScale >= 4) {
            arms += `
            <path d="M44 42 C36 32, 22 18, 12 22 C6 24, 4 34, 10 40 C16 44, 26 42, 34 38 C38 36, 42 38, 46 42 Z"/>
            <path d="M56 58 C64 68, 78 82, 88 78 C94 76, 96 66, 90 60 C84 56, 74 58, 66 62 C62 64, 58 62, 54 58 Z"/>`;
        }
        svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${svgSize}" height="${svgSize}">
            <g fill="${pal.mid}" stroke="#000" stroke-width="1.5">${arms}</g>
            <circle cx="50" cy="50" r="16" fill="#fff" stroke="#000" stroke-width="1.5"/>
            <circle cx="50" cy="50" r="14.5" fill="#fff" stroke="${pal.mid}" stroke-width="1.5"/>
            <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
                  font-size="18" font-weight="900" fill="${pal.mid}"
                  font-family="system-ui, -apple-system, sans-serif">${cyclone.categoryLabel}</text>
        </svg>`;
    } else {
        svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${svgSize}" height="${svgSize}">
            <g fill="${pal.mid}" stroke="#000" stroke-width="1.5">
                <path d="M52 38 C56 24, 66 6, 80 4 C88 2, 92 10, 88 18 C82 26, 68 30, 58 34 C54 36, 52 38, 52 40 Z"/>
                <path d="M48 62 C44 76, 34 94, 20 96 C12 98, 8 90, 12 82 C18 74, 32 70, 42 66 C46 64, 48 62, 48 60 Z"/>
            </g>
            <circle cx="50" cy="50" r="18" fill="#fff" stroke="#000" stroke-width="1.5"/>
            <circle cx="50" cy="50" r="16.5" fill="#fff" stroke="${pal.mid}" stroke-width="1.5"/>
            <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
                  font-size="16" font-weight="900" fill="${pal.mid}"
                  font-family="system-ui, -apple-system, sans-serif">${cyclone.categoryLabel}</text>
        </svg>`;
    }

    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgStr, 'image/svg+xml');
    const svgEl = svgDoc.documentElement;
    if (svgEl && svgEl.nodeName === 'svg') {
        spinWrapper.appendChild(document.importNode(svgEl, true));
    }
    eyeContainer.appendChild(spinWrapper);
    el.appendChild(eyeContainer);

    // ── Info badge ──
    if (showInfoBadge) {
        const infoBadge = document.createElement('div');
        infoBadge.style.cssText = `
            font-size: 11px; font-weight: 600; color: #fff;
            text-shadow: 0 1px 4px rgba(0,0,0,1); margin-top: 5px;
            white-space: nowrap; background: rgba(0,0,0,0.35);
            padding: 3px 10px; border-radius: 8px;
            backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
        `;
        infoBadge.textContent = catStr;
        el.appendChild(infoBadge);
    }

    return el;
}

// ── Inject pulse animation CSS (once) ─────────────────────

let cssInjected = false;
function injectCycloneCSS() {
    if (cssInjected) return;
    cssInjected = true;
    const style = document.createElement('style');
    style.textContent = `
        @keyframes cyclone-pulse {
            0%, 100% { transform: scale(1); opacity: 0.6; }
            50% { transform: scale(1.5); opacity: 0.15; }
        }
        @keyframes cyclone-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        @keyframes cyclone-eye-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(-360deg); }
        }
        @keyframes cyclone-morph {
            0%   { border-radius: 40% 60% 55% 45% / 55% 45% 50% 50%; }
            25%  { border-radius: 55% 45% 40% 60% / 45% 55% 60% 40%; }
            50%  { border-radius: 45% 55% 60% 40% / 60% 40% 45% 55%; }
            75%  { border-radius: 60% 40% 45% 55% / 40% 60% 55% 45%; }
            100% { border-radius: 50% 50% 55% 45% / 45% 55% 50% 50%; }
        }
        /* Unrolls LEFT TO RIGHT (Shane 2026-08-22), not top-to-bottom.
           Animating max-width rather than transform:scaleX keeps the text
           inside at its true size — a scaleX card arrives with its type
           stretched and snaps straight, which reads as a glitch. The card's
           own overflow:hidden does the clipping. */
        @keyframes storm-badge-unroll {
            from { max-width: 0; opacity: 0.4; }
            to   { max-width: 320px; opacity: 1; }
        }
        @keyframes cyclone-blob {
            0%   { border-radius: 45% 55% 50% 50% / 50% 45% 55% 50%; transform: rotate(0deg); }
            33%  { border-radius: 55% 45% 45% 55% / 45% 55% 50% 50%; }
            66%  { border-radius: 50% 50% 55% 45% / 55% 45% 45% 55%; }
            100% { border-radius: 45% 55% 50% 50% / 50% 50% 55% 45%; transform: rotate(120deg); }
        }
    `;
    document.head.appendChild(style);
}

// ── SVG Track Line Overlay ────────────────────────────────

/**
 * Creates and manages an SVG overlay that draws storm track lines.
 * Positioned above wind particles (z-index 450).
 *
 * Semantic zoom:
 *   - All zooms: intensity-colored track segments
 *   - zoom < 5: thin line (1.5px)
 *   - zoom 5-8: medium line (3px)
 *   - zoom > 8: thick line (3px) + data point dots
 */
function createTrackOverlay(map: mapboxgl.Map): {
    update: (cyclones: ActiveCyclone[]) => void;
    remove: () => void;
} {
    const container = map.getContainer();

    const div = document.createElement('div');
    div.style.cssText = `
        position: absolute;
        inset: 0;
        z-index: 450;
        pointer-events: none;
        overflow: visible;
    `;
    container.appendChild(div);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'width: 100%; height: 100%; overflow: visible;';
    div.appendChild(svg);

    let storedCyclones: ActiveCyclone[] = [];

    const redraw = () => {
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        const rect = container.getBoundingClientRect();
        svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

        const zoom = map.getZoom();
        const isMacro = zoom < 5;
        const lineWidth = isMacro ? 1.5 : 3;

        for (const c of storedCyclones) {
            if (c.track.length < 2) continue;

            // Project all track points to screen pixels — through the same
            // longitude sanitizer as the GL geometry. map.project() of a raw
            // sign-flipped pair puts consecutive screen points a whole world
            // apart, and the SVG tube then spans the viewport.
            const sanePast = sanitizeTrackLongitudes(c.track.map((p) => [p.lon, p.lat] as [number, number]));
            const pastPx = projectTrackContinuously(map, sanePast);
            const projected = pastPx.map((px, i) => ({
                px,
                // Index pairing is safe: the sanitizer only ever truncates the
                // tail, so its output is a strict prefix of the input.
                point: c.track[i],
            }));
            if (projected.length < 2) continue;

            // Smooth the past track with Catmull-Rom spline (same as forecast)
            const rawTrackPts = projected.map((p) => [p.px.x, p.px.y] as [number, number]);
            const smoothTrackPts = catmullRomSpline(rawTrackPts, 8);

            if (smoothTrackPts.length >= 2) {
                // Build cubic bezier path for smooth curve
                const tension = 0.5;
                let pathData = `M ${smoothTrackPts[0][0].toFixed(1)} ${smoothTrackPts[0][1].toFixed(1)}`;
                for (let i = 0; i < smoothTrackPts.length - 1; i++) {
                    const p0 = smoothTrackPts[i - 1] || smoothTrackPts[i];
                    const p1 = smoothTrackPts[i];
                    const p2 = smoothTrackPts[i + 1];
                    const p3 = smoothTrackPts[i + 2] || p2;

                    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
                    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
                    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
                    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;

                    pathData += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
                }

                // Use the most recent track point colour for the line
                const _trackColor = windColor(c.currentPosition.windKts);

                // Black outline for contrast over satellite
                const outlinePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                outlinePath.setAttribute('d', pathData);
                outlinePath.setAttribute('fill', 'none');
                outlinePath.setAttribute('stroke', '#000');
                outlinePath.setAttribute('stroke-width', String(lineWidth + 4));
                outlinePath.setAttribute('stroke-opacity', '0.7');
                outlinePath.setAttribute('stroke-linecap', 'round');
                outlinePath.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(outlinePath);

                // Main track path — solid white
                const trackPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                trackPath.setAttribute('d', pathData);
                trackPath.setAttribute('fill', 'none');
                trackPath.setAttribute('stroke', '#fff');
                trackPath.setAttribute('stroke-width', String(lineWidth));
                trackPath.setAttribute('stroke-opacity', '1');
                trackPath.setAttribute('stroke-linecap', 'round');
                trackPath.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(trackPath);
            }

            // Show track labels at zoom >= 5
            if (!isMacro) {
                drawTrackDots(svg, projected, zoom);
            }

            // ── "New Wave" Neon Tube + Forecast dots ──
            if (c.forecastTrack && c.forecastTrack.length > 0) {
                const forecastAll = [c.currentPosition, ...c.forecastTrack];
                // Same sanitizer as the GL sleeve — THIS screen-space cone is
                // the shape that read as "the entire planet as its possible
                // track": one Date-Line sign flip projected the next cone
                // vertex a full world away, and the expanding error margins
                // were drawn around that.
                const saneFc = sanitizeTrackLongitudes(forecastAll.map((p) => [p.lon, p.lat] as [number, number]));
                const fcPx = projectTrackContinuously(map, saneFc);
                const fcProjected = fcPx.map((px, i) => ({
                    px,
                    point: forecastAll[i],
                }));

                // THE FOURTH RENDERER (round four, 2026-08-24 late). This
                // glow-tube spline had its OWN raw projection of the same
                // forecast — `map.project([p.lon, p.lat])` on the unsanitized
                // points, six lines below the site three rounds of fixes kept
                // patching. Every screenshot's travelling world-line was THIS
                // path. It now derives from fcPx — the continuous projection
                // of the sanitized forecast — and the tripwire test pins
                // map.project() to exactly one owner in this file, so a fifth
                // private projection cannot be added without failing it.
                //
                // Interpolate via catmull-rom for a genuinely smooth curve —
                // raw API gives ~5-7 forecast points; we need ~50+.
                const smoothScreenPts = catmullRomSpline(
                    fcPx.map((p) => [p.x, p.y] as [number, number]),
                    12,
                );
                const screenPts = smoothScreenPts.map(([x, y]) => ({ x, y }));

                if (screenPts.length >= 2) {
                    // ── Cubic Bezier Spline: smooth "Glow Sleeve" path ──
                    const tension = 0.5;
                    let pathData = `M ${screenPts[0].x.toFixed(1)} ${screenPts[0].y.toFixed(1)}`;
                    for (let i = 0; i < screenPts.length - 1; i++) {
                        const p0 = screenPts[i - 1] || screenPts[i];
                        const p1 = screenPts[i];
                        const p2 = screenPts[i + 1];
                        const p3 = screenPts[i + 2] || p2;

                        const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension;
                        const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension;
                        const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension;
                        const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension;

                        pathData += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
                    }

                    // ── CSS: Cone styling (inject once) ──
                    if (!document.getElementById('thalassaSleeveStyle')) {
                        const style = document.createElement('style');
                        style.id = 'thalassaSleeveStyle';
                        style.textContent = `
                            .thalassa-cone {
                                pointer-events: none;
                            }
                            .thalassa-spine {
                                filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.6));
                                pointer-events: none;
                            }
                        `;
                        document.head.appendChild(style);
                    }

                    // ── LAYER 1: FILLED CONE POLYGON (NHC-style expanding cone) ──
                    // Build left and right edges that expand from eye to forecast end,
                    // then close them into a filled polygon.
                    const minEdge = isMacro ? 3 : 5;
                    const maxEdge = isMacro ? 20 : 40;

                    const leftEdge: { x: number; y: number }[] = [];
                    const rightEdge: { x: number; y: number }[] = [];

                    for (let j = 0; j < screenPts.length; j++) {
                        const fraction = screenPts.length > 1 ? j / (screenPts.length - 1) : 0;
                        const offset = minEdge + (maxEdge - minEdge) * fraction;

                        // Compute tangent direction
                        let tdx: number, tdy: number;
                        if (j === 0) {
                            tdx = screenPts[1].x - screenPts[0].x;
                            tdy = screenPts[1].y - screenPts[0].y;
                        } else if (j === screenPts.length - 1) {
                            tdx = screenPts[j].x - screenPts[j - 1].x;
                            tdy = screenPts[j].y - screenPts[j - 1].y;
                        } else {
                            tdx = screenPts[j + 1].x - screenPts[j - 1].x;
                            tdy = screenPts[j + 1].y - screenPts[j - 1].y;
                        }
                        const tLen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
                        const pnx = -tdy / tLen;
                        const pny = tdx / tLen;

                        leftEdge.push({
                            x: screenPts[j].x + pnx * offset,
                            y: screenPts[j].y + pny * offset,
                        });
                        rightEdge.push({
                            x: screenPts[j].x - pnx * offset,
                            y: screenPts[j].y - pny * offset,
                        });
                    }

                    // Build closed polygon: left edge forward → right edge reversed → close
                    const allConePts = [...leftEdge, ...rightEdge.reverse()];
                    if (allConePts.length >= 4) {
                        let conePathData = `M ${allConePts[0].x.toFixed(1)} ${allConePts[0].y.toFixed(1)}`;
                        for (let j = 1; j < allConePts.length; j++) {
                            conePathData += ` L ${allConePts[j].x.toFixed(1)} ${allConePts[j].y.toFixed(1)}`;
                        }
                        conePathData += ' Z';

                        // Filled cone polygon
                        const coneFill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        coneFill.setAttribute('d', conePathData);
                        coneFill.setAttribute('fill', 'rgba(255, 255, 255, 0.15)');
                        coneFill.setAttribute('stroke', 'rgba(255, 255, 255, 0.6)');
                        coneFill.setAttribute('stroke-width', '1.5');
                        coneFill.setAttribute('stroke-linejoin', 'round');
                        coneFill.classList.add('thalassa-cone');
                        svg.appendChild(coneFill);
                    }

                    // ── LAYER 2: SMOOTH CURVED CENTERLINE ──
                    const centerLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    centerLine.setAttribute('d', pathData);
                    centerLine.setAttribute('fill', 'none');
                    centerLine.setAttribute('stroke', 'white');
                    centerLine.setAttribute('stroke-width', '2');
                    centerLine.setAttribute('stroke-opacity', '0.9');
                    centerLine.setAttribute('stroke-linecap', 'round');
                    centerLine.setAttribute('stroke-linejoin', 'round');
                    centerLine.classList.add('thalassa-spine');
                    svg.appendChild(centerLine);
                }

                // Draw forecast dots/labels
                if (!isMacro) {
                    drawForecastDots(svg, fcProjected.slice(1), zoom);
                }
            }
        }
    };

    map.on('move', redraw);
    map.on('resize', redraw);

    return {
        update(cyclones: ActiveCyclone[]) {
            storedCyclones = cyclones;
            redraw();
        },
        remove() {
            map.off('move', redraw);
            map.off('resize', redraw);
            if (div.parentNode) div.parentNode.removeChild(div);
        },
    };
}

/** Draw forecast-style labels along the track */
function drawTrackDots(svg: SVGSVGElement, projected: { px: mapboxgl.Point; point: CyclonePosition }[], zoom: number) {
    const now = Date.now();
    const showLabels = zoom >= 7; // Show text labels at zoom 7+
    const labelEvery = zoom >= 9 ? 2 : 4; // Every 2nd at high zoom, every 4th otherwise

    for (let i = 0; i < projected.length; i++) {
        // Show every other dot (half as many)
        if (i % 2 !== 0 && i < projected.length - 1) continue;

        const { px, point } = projected[i];
        const dotColor = windColor(point.windKts);
        const cat = point.windKts ? windToSS(point.windKts) : 0;

        // Outer glow
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        glow.setAttribute('cx', String(px.x));
        glow.setAttribute('cy', String(px.y));
        glow.setAttribute('r', '12');
        glow.setAttribute('fill', dotColor);
        glow.setAttribute('opacity', '0.3');
        svg.appendChild(glow);

        // Inner dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', cat >= 1 ? '10' : '6');
        dot.setAttribute('fill', dotColor);
        dot.setAttribute('stroke', 'rgba(0,0,0,0.7)');
        dot.setAttribute('stroke-width', '2');
        svg.appendChild(dot);

        // Category number inside larger dots
        if (cat >= 1) {
            const catText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            catText.setAttribute('x', String(px.x));
            catText.setAttribute('y', String(px.y + 5));
            catText.setAttribute('fill', '#fff');
            catText.setAttribute('font-size', '14');
            catText.setAttribute('font-weight', '800');
            catText.setAttribute('font-family', 'system-ui, sans-serif');
            catText.setAttribute('text-anchor', 'middle');
            catText.textContent = String(cat);
            svg.appendChild(catText);
        }

        // At lower zoom, show only dots (no labels)
        if (!showLabels || i % labelEvery !== 0) continue;
        if (!point.time) continue;

        const d = new Date(point.time);
        const ageHrs = (now - d.getTime()) / 3600000;
        const isNow = Math.abs(ageHrs) < 3; // Within 3 hours = "now"

        // Format relative time label
        let timeLabel = '';
        if (isNow) {
            timeLabel = 'Now';
        } else {
            const dayDiff = Math.round(ageHrs / 24);
            const hourStr =
                d.getUTCHours() >= 12
                    ? `${d.getUTCHours() === 12 ? 12 : d.getUTCHours() - 12} PM`
                    : `${d.getUTCHours() === 0 ? 12 : d.getUTCHours()} AM`;

            if (dayDiff === 0) timeLabel = `Today ${hourStr}`;
            else if (dayDiff === 1) timeLabel = `Yesterday ${hourStr}`;
            else if (dayDiff === -1) timeLabel = `Tomorrow ${hourStr}`;
            else if (dayDiff > 1) timeLabel = `${dayDiff}d ago ${hourStr}`;
            else timeLabel = `In ${Math.abs(dayDiff)}d ${hourStr}`;
        }

        // Wind + pressure line
        const windStr = point.windKts ? `${point.windKts}kt` : '';
        const presStr = point.pressureMb ? `${point.pressureMb}hPa` : '';
        const infoStr = [windStr, presStr].filter(Boolean).join(' · ');

        // Alternate label position left/right to prevent overlap
        const labelRight = i % 2 === 0;
        const xOff = labelRight ? 14 : -14;

        // Pure SVG label (no foreignObject — works on iOS WebView)
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        // Connector line from dot to label
        const connector = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        connector.setAttribute('x1', String(px.x));
        connector.setAttribute('y1', String(px.y));
        connector.setAttribute('x2', String(px.x + xOff));
        connector.setAttribute('y2', String(px.y));
        connector.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        connector.setAttribute('stroke-width', '1');
        g.appendChild(connector);

        // Background rect
        const pillW = 88;
        const pillH = infoStr ? 24 : 14;
        const rx = px.x + xOff + (labelRight ? 0 : -pillW);
        const ry = px.y - pillH / 2;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', String(rx));
        bg.setAttribute('y', String(ry));
        bg.setAttribute('width', String(pillW));
        bg.setAttribute('height', String(pillH));
        bg.setAttribute('rx', '3');
        bg.setAttribute('fill', 'rgba(0,0,0,0.8)');
        g.appendChild(bg);

        // Color bar on left edge
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar.setAttribute('x', String(rx));
        bar.setAttribute('y', String(ry));
        bar.setAttribute('width', '2');
        bar.setAttribute('height', String(pillH));
        bar.setAttribute('rx', '1');
        bar.setAttribute('fill', dotColor);
        g.appendChild(bar);

        // Time label text
        const timeTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        timeTxt.setAttribute('x', String(rx + 6));
        timeTxt.setAttribute('y', String(ry + (infoStr ? 10 : 10)));
        timeTxt.setAttribute('fill', isNow ? dotColor : '#e2e8f0');
        timeTxt.setAttribute('font-size', '9');
        timeTxt.setAttribute('font-weight', '700');
        timeTxt.setAttribute('font-family', 'system-ui, sans-serif');
        timeTxt.textContent = timeLabel;
        g.appendChild(timeTxt);

        // Info text (wind + pressure)
        if (infoStr) {
            const infoTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            infoTxt.setAttribute('x', String(rx + 6));
            infoTxt.setAttribute('y', String(ry + 20));
            infoTxt.setAttribute('fill', '#94a3b8');
            infoTxt.setAttribute('font-size', '8');
            infoTxt.setAttribute('font-weight', '500');
            infoTxt.setAttribute('font-family', 'system-ui, sans-serif');
            infoTxt.textContent = infoStr;
            g.appendChild(infoTxt);
        }

        svg.appendChild(g);
    }
}

/** Draw forecast position labels (future predicted track) */
function drawForecastDots(
    svg: SVGSVGElement,
    projected: { px: mapboxgl.Point; point: CyclonePosition }[],
    zoom: number,
) {
    // Show compact time labels at z6+ (one zoom in from the default z5 view)
    // Full labels (wind/pressure pills) at z7+
    const showTimeLabels = zoom >= 6;
    const showFullLabels = zoom >= 7;

    for (let i = 0; i < projected.length; i++) {
        const { px, point } = projected[i];
        const dotColor = windColor(point.windKts);
        const cat = point.windKts ? windToSS(point.windKts) : 0;

        // White glow ring (distinguishes forecast from historical)
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        glow.setAttribute('cx', String(px.x));
        glow.setAttribute('cy', String(px.y));
        glow.setAttribute('r', '7');
        glow.setAttribute('fill', 'none');
        glow.setAttribute('stroke', 'rgba(255,255,255,0.4)');
        glow.setAttribute('stroke-width', '1.5');
        svg.appendChild(glow);

        // Inner dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '5');
        dot.setAttribute('fill', dotColor);
        dot.setAttribute('stroke', '#000');
        dot.setAttribute('stroke-width', '1');
        svg.appendChild(dot);

        // Category number inside dot for Cat 1+
        if (cat >= 1) {
            const catText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            catText.setAttribute('x', String(px.x));
            catText.setAttribute('y', String(px.y + 3));
            catText.setAttribute('fill', '#fff');
            catText.setAttribute('font-size', '7');
            catText.setAttribute('font-weight', '900');
            catText.setAttribute('font-family', 'system-ui, sans-serif');
            catText.setAttribute('text-anchor', 'middle');
            catText.textContent = String(cat);
            svg.appendChild(catText);
        }

        if (!point.time) continue;

        // Format forecast time in device local timezone
        const d = new Date(point.time);
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const localH = d.getHours();
        const localM = d.getMinutes();
        const ampm = localH >= 12 ? 'PM' : 'AM';
        const h12 = localH === 0 ? 12 : localH > 12 ? localH - 12 : localH;
        const minStr = localM > 0 ? `:${String(localM).padStart(2, '0')}` : '';
        // Detect timezone abbreviation (e.g. AEST, EST, PST)
        const tzAbbr = d.toLocaleTimeString('en-AU', { timeZoneName: 'short' }).split(' ').pop() || '';

        // ── Compact time label at z6 (just "Cat · 3:15 PM AEST" beside the dot) ──
        if (showTimeLabels && !showFullLabels) {
            const catPrefix = cat >= 1 ? `${cat}. ` : '';
            const compactLabel = `${catPrefix}${h12}${minStr} ${ampm}`;
            const labelRight = i % 2 === 0;
            const xOff = labelRight ? 12 : -12;

            const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            txt.setAttribute('x', String(px.x + xOff));
            txt.setAttribute('y', String(px.y + 3));
            txt.setAttribute('fill', 'rgba(255,255,255,0.85)');
            txt.setAttribute('font-size', '9');
            txt.setAttribute('font-weight', '700');
            txt.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
            txt.setAttribute('text-anchor', labelRight ? 'start' : 'end');
            txt.textContent = compactLabel;
            svg.appendChild(txt);
            continue;
        }

        if (!showFullLabels) continue;

        // Full label format for z7+
        const timeLabel = `${dayNames[d.getDay()]} ${h12}${minStr} ${ampm} ${tzAbbr}`;

        const windStr = point.windKts ? `${point.windKts}kt` : '';
        const presStr = point.pressureMb ? `${point.pressureMb}hPa` : '';
        const infoStr = [windStr, presStr].filter(Boolean).join(' · ');

        // Alternate label position
        const labelRight = i % 2 === 0;
        const xOff = labelRight ? 14 : -14;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

        // Connector
        const connector = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        connector.setAttribute('x1', String(px.x));
        connector.setAttribute('y1', String(px.y));
        connector.setAttribute('x2', String(px.x + xOff));
        connector.setAttribute('y2', String(px.y));
        connector.setAttribute('stroke', 'rgba(255,255,255,0.3)');
        connector.setAttribute('stroke-width', '1');
        connector.setAttribute('stroke-dasharray', '2,2');
        g.appendChild(connector);

        // Background (wider to fit timezone abbreviation)
        const pillW = 110;
        const pillH = 30;
        const rx = px.x + xOff + (labelRight ? 0 : -pillW);
        const ry = px.y - pillH / 2;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', String(rx));
        bg.setAttribute('y', String(ry));
        bg.setAttribute('width', String(pillW));
        bg.setAttribute('height', String(pillH));
        bg.setAttribute('rx', '3');
        bg.setAttribute('fill', 'rgba(0,0,0,0.85)');
        bg.setAttribute('stroke', 'rgba(255,255,255,0.15)');
        bg.setAttribute('stroke-width', '0.5');
        g.appendChild(bg);

        // Color bar
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar.setAttribute('x', String(rx));
        bar.setAttribute('y', String(ry));
        bar.setAttribute('width', '2');
        bar.setAttribute('height', String(pillH));
        bar.setAttribute('rx', '1');
        bar.setAttribute('fill', dotColor);
        g.appendChild(bar);

        // "FCST" header
        const fcstTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        fcstTxt.setAttribute('x', String(rx + 6));
        fcstTxt.setAttribute('y', String(ry + 9));
        fcstTxt.setAttribute('fill', '#fbbf24');
        fcstTxt.setAttribute('font-size', '7');
        fcstTxt.setAttribute('font-weight', '700');
        fcstTxt.setAttribute('font-family', 'system-ui, sans-serif');
        fcstTxt.setAttribute('letter-spacing', '0.08em');
        fcstTxt.textContent = `FCST · ${timeLabel}`;
        g.appendChild(fcstTxt);

        // Wind + pressure
        if (infoStr) {
            const infoTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            infoTxt.setAttribute('x', String(rx + 6));
            infoTxt.setAttribute('y', String(ry + 20));
            infoTxt.setAttribute('fill', dotColor);
            infoTxt.setAttribute('font-size', '9');
            infoTxt.setAttribute('font-weight', '700');
            infoTxt.setAttribute('font-family', 'system-ui, sans-serif');
            infoTxt.textContent = infoStr;
            g.appendChild(infoTxt);
        }

        svg.appendChild(g);
    }
}

/** Quick Saffir-Simpson category from wind speed */
function windToSS(kts: number): number {
    if (kts >= 137) return 5;
    if (kts >= 113) return 4;
    if (kts >= 96) return 3;
    if (kts >= 83) return 2;
    if (kts >= 64) return 1;
    return 0;
}

// ── Probability Sleeve Geometry Engine ────────────────────

/** Catmull-Rom spline interpolation — returns smooth points between control points */
function catmullRomSpline(points: [number, number][], segments: number = 8, _alpha: number = 0.5): [number, number][] {
    if (points.length < 2) return points;
    if (points.length === 2) {
        // Linear interpolation for 2 points
        const result: [number, number][] = [];
        for (let s = 0; s <= segments; s++) {
            const t = s / segments;
            result.push([
                points[0][0] + (points[1][0] - points[0][0]) * t,
                points[0][1] + (points[1][1] - points[0][1]) * t,
            ]);
        }
        return result;
    }

    const result: [number, number][] = [];

    // Pad start and end with ghost points for full curve
    const padded: [number, number][] = [
        [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]],
        ...points,
        [
            2 * points[points.length - 1][0] - points[points.length - 2][0],
            2 * points[points.length - 1][1] - points[points.length - 2][1],
        ],
    ];

    for (let i = 1; i < padded.length - 2; i++) {
        const p0 = padded[i - 1];
        const p1 = padded[i];
        const p2 = padded[i + 1];
        const p3 = padded[i + 2];

        for (let s = 0; s < segments; s++) {
            const t = s / segments;
            const t2 = t * t;
            const t3 = t2 * t;

            // Centripetal Catmull-Rom coefficients
            const x =
                0.5 *
                (2 * p1[0] +
                    (-p0[0] + p2[0]) * t +
                    (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                    (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
            const y =
                0.5 *
                (2 * p1[1] +
                    (-p0[1] + p2[1]) * t +
                    (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                    (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);

            result.push([x, y]);
        }
    }

    // Add final point
    result.push(points[points.length - 1]);
    return result;
}

/**
 * Make a storm track's longitudes CONTINUOUS, and refuse the impossible.
 *
 * THE ENTIRE-PLANET CONE (Shane 2026-08-24: "a certain storm that has the
 * entire planet as its possible track"). Track feeds hand back longitudes in
 * [-180, 180], so a South Pacific storm crossing the Date Line steps from
 * +179.5 to -179.8 — a 0.7° move spelled as -359.3°. Nothing in this pipeline
 * unwrapped that: the Catmull-Rom spline interpolated THROUGH the wrong
 * 359.3°, planting ten synthetic points across Africa and the Atlantic, and
 * buildSleevePolygon then inflated its error margins around that world-tour
 * centreline. One sign flip, one planet-wide "possible track".
 *
 * Unwrap: each point is shifted by whole turns until it sits within 180° of
 * its predecessor — the same continuous-axis treatment the wind pipeline uses
 * (windLongitude.ts). Mapbox renders longitudes beyond ±180 correctly on the
 * adjacent world copy, so the unwrapped spelling is safe to hand straight to
 * a GeoJSON source.
 *
 * Truncate: after unwrapping, a step of more than MAX_PLAUSIBLE_STEP_DEG is
 * not a fast storm — the fastest recorded cyclones move ~1°/hour, and
 * forecast points arrive at 6-24 h spacing — it is a corrupt fix (a null
 * island 0/0, a broken advisory row). The track is CUT at the last sane
 * point rather than repaired: drawing invented geometry on a safety display
 * is worse than drawing a shorter, honest one.
 */
const MAX_PLAUSIBLE_STEP_DEG = 30;

export function sanitizeTrackLongitudes(points: [number, number][]): [number, number][] {
    if (points.length === 0) return points;
    const out: [number, number][] = [];
    for (const [lon, lat] of points) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) break;
        if (out.length === 0) {
            out.push([lon, lat]);
            continue;
        }
        const prev = out[out.length - 1];
        let next = lon;
        while (next - prev[0] > 180) next -= 360;
        while (next - prev[0] < -180) next += 360;
        // Still implausible once the spelling is fixed → corrupt fix; cut here.
        if (Math.abs(next - prev[0]) > MAX_PLAUSIBLE_STEP_DEG || Math.abs(lat - prev[1]) > MAX_PLAUSIBLE_STEP_DEG) {
            break;
        }
        out.push([next, lat]);
    }
    return out;
}

/**
 * Project a CONTINUOUS track to screen pixels without letting Mapbox split it.
 *
 * THE THIRD ROUND of the entire-planet bug, and the honest post-mortem of the
 * second: map.project() wraps each longitude into [-180, 180] independently,
 * so ANY spelling of a genuinely antimeridian-crossing track straddles the
 * wrap boundary somewhere, and one uniform re-spell (the previous fix) merely
 * moves WHERE it straddles — with the camera at -116 for ISELLE, the shift
 * for LALA computed to zero and the split survived, which is exactly what
 * Shane's screenshot showed. The previous fix's dev verification was
 * measured while the overlay was not rendering, and is struck from the
 * record.
 *
 * So: project ONE anchor point through Mapbox (wrapped into range, so it
 * lands on the camera-consistent world copy, same as the markers), then place
 * every other point by MERCATOR DELTA from that anchor — x from the
 * continuous longitude difference over the world's pixel width
 * (512 · 2^zoom, Mapbox's mercator worldSize), y from project() at a wrapped
 * longitude, safe because mercator y depends only on latitude. A continuous
 * input cannot split, whatever the camera, because only one point ever
 * touches project()'s x-wrap.
 */
export function projectTrackContinuously(
    map: Pick<mapboxgl.Map, 'project' | 'getZoom'>,
    points: readonly [number, number][],
): mapboxgl.Point[] {
    if (points.length === 0) return [];
    const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
    const anchorLon = points[0][0];
    const anchor = map.project([wrap(anchorLon), points[0][1]]);
    const worldPx = 512 * Math.pow(2, map.getZoom());
    return points.map(
        ([lon, lat]) =>
            new mapboxgl.Point(anchor.x + ((lon - anchorLon) / 360) * worldPx, map.project([wrap(lon), lat]).y),
    );
}

/**
 * Build the probability sleeve polygon using standard maritime forecast error margins.
 * Error radii (nautical miles):
 *   0h → 0nm, 12h → 30nm, 24h → 50nm, 48h → 90nm, 72h → 130nm, 120h → 200nm
 *
 * @param smoothTrack  Smoothed [lon, lat] centerline points
 * @param totalHours   Total forecast window in hours
 * @param scale        Width multiplier (1.0 = standard, 1.6 = outer glow)
 * @returns            Closed polygon coordinates [lon, lat][]
 */
function buildSleevePolygon(
    smoothTrack: [number, number][],
    totalHours: number = 120,
    scale: number = 1.0,
): [number, number][] {
    const n = smoothTrack.length;
    if (n < 2) return [];

    // Maritime forecast error margins: [hours, radius_nm]
    const ERROR_TABLE: [number, number][] = [
        [0, 0],
        [12, 30],
        [24, 50],
        [48, 90],
        [72, 130],
        [120, 200],
    ];

    // Interpolate radius in nautical miles for a given forecast hour
    const radiusNm = (tHours: number): number => {
        if (tHours <= 0) return 0;
        for (let i = 1; i < ERROR_TABLE.length; i++) {
            const [t0, r0] = ERROR_TABLE[i - 1];
            const [t1, r1] = ERROR_TABLE[i];
            if (tHours <= t1) {
                const frac = (tHours - t0) / (t1 - t0);
                return r0 + (r1 - r0) * frac;
            }
        }
        // Beyond 120h — extrapolate linearly
        const [tLast, rLast] = ERROR_TABLE[ERROR_TABLE.length - 1];
        const [tPrev, rPrev] = ERROR_TABLE[ERROR_TABLE.length - 2];
        return rLast + ((rLast - rPrev) / (tLast - tPrev)) * (tHours - tLast);
    };

    const leftEdge: [number, number][] = [];
    const rightEdge: [number, number][] = [];

    for (let i = 0; i < n; i++) {
        const fraction = i / (n - 1);
        const tHours = fraction * totalHours;
        // Convert nm to degrees: 1nm = 1/60 degree latitude
        const radiusDeg = (radiusNm(tHours) / 60) * scale;

        // Calculate perpendicular normal at this point
        let dx: number, dy: number;
        if (i === 0) {
            dx = smoothTrack[1][0] - smoothTrack[0][0];
            dy = smoothTrack[1][1] - smoothTrack[0][1];
        } else if (i === n - 1) {
            dx = smoothTrack[n - 1][0] - smoothTrack[n - 2][0];
            dy = smoothTrack[n - 1][1] - smoothTrack[n - 2][1];
        } else {
            dx = smoothTrack[i + 1][0] - smoothTrack[i - 1][0];
            dy = smoothTrack[i + 1][1] - smoothTrack[i - 1][1];
        }

        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;

        const [lon, lat] = smoothTrack[i];
        // Adjust for latitude (degrees of longitude shrink at higher latitudes)
        const latCos = Math.cos((lat * Math.PI) / 180);
        const lonRadius = radiusDeg / (latCos || 1);

        leftEdge.push([lon + nx * lonRadius, lat + ny * radiusDeg]);
        rightEdge.push([lon - nx * lonRadius, lat - ny * radiusDeg]);
    }

    return [...leftEdge, ...rightEdge.reverse(), leftEdge[0]];
}

/** IDs for the Mapbox GL probability sleeve layers */
const SLEEVE_SOURCE = 'cyclone-sleeve-src';
const SLEEVE_GLOW = 'cyclone-sleeve-glow';
const SLEEVE_CORE = 'cyclone-sleeve-core';
const SLEEVE_EDGE = 'cyclone-sleeve-edge';
const SLEEVE_CENTER = 'cyclone-sleeve-center';

/**
 * Add or update the Probability Sleeve on the map for the forecast track.
 * Creates a multi-layer glow effect using Mapbox GL fill + line layers.
 */
function addProbabilitySleeve(map: mapboxgl.Map, cyclone: ActiveCyclone): void {
    const forecast = cyclone.forecastTrack;
    if (!forecast || forecast.length < 2) return;

    // Build the track centerline from current position through forecast —
    // continuous longitudes, corrupt fixes cut (see sanitizeTrackLongitudes).
    const allPoints: [number, number][] = sanitizeTrackLongitudes([
        [cyclone.currentPosition.lon, cyclone.currentPosition.lat],
        ...forecast.map((p) => [p.lon, p.lat] as [number, number]),
    ]);
    if (allPoints.length < 2) return;

    // Calculate total forecast hours from timestamps
    let totalHours = 120;
    if (forecast.length >= 2 && forecast[0].time && forecast[forecast.length - 1].time) {
        const t0 = new Date(forecast[0].time).getTime();
        const tN = new Date(forecast[forecast.length - 1].time).getTime();
        if (tN > t0) totalHours = (tN - t0) / 3600000;
    }

    // Smooth the track with Catmull-Rom spline
    const smoothTrack = catmullRomSpline(allPoints, 10);

    // Build the probability envelope polygon (maritime error margins)
    const sleeveCoords = buildSleevePolygon(smoothTrack, totalHours, 1.0);
    // Build wider glow polygon (1.6× scale)
    const glowCoords = buildSleevePolygon(smoothTrack, totalHours, 1.6);

    // GeoJSON FeatureCollection
    const geojson: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            // Outer glow polygon
            {
                type: 'Feature',
                properties: { layer: 'glow' },
                geometry: { type: 'Polygon', coordinates: [glowCoords] },
            },
            // Core sleeve polygon
            {
                type: 'Feature',
                properties: { layer: 'core' },
                geometry: { type: 'Polygon', coordinates: [sleeveCoords] },
            },
            // Centerline
            {
                type: 'Feature',
                properties: { layer: 'center' },
                geometry: { type: 'LineString', coordinates: smoothTrack },
            },
        ],
    };

    // Update existing source or create new
    const existing = map.getSource(SLEEVE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (existing) {
        existing.setData(geojson);
        return;
    }

    // Add source
    map.addSource(SLEEVE_SOURCE, { type: 'geojson', data: geojson, lineMetrics: true });

    // Layer 1: Outer glow — wide transparent fill extending beyond core
    map.addLayer({
        id: SLEEVE_GLOW,
        type: 'fill',
        source: SLEEVE_SOURCE,
        filter: ['==', ['get', 'layer'], 'glow'],
        paint: {
            'fill-color': '#ffffff',
            'fill-opacity': 0.05,
        },
    });

    // Layer 2: Core cone fill — NHC-style translucent white
    map.addLayer({
        id: SLEEVE_CORE,
        type: 'fill',
        source: SLEEVE_SOURCE,
        filter: ['==', ['get', 'layer'], 'core'],
        paint: {
            'fill-color': '#ffffff',
            'fill-opacity': 0.18,
        },
    });

    // Layer 3: Cone edge outline — solid white boundary
    map.addLayer({
        id: SLEEVE_EDGE,
        type: 'line',
        source: SLEEVE_SOURCE,
        filter: ['==', ['get', 'layer'], 'core'],
        paint: {
            'line-color': '#ffffff',
            'line-width': 1.5,
            'line-opacity': 0.6,
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' },
    });

    // Layer 4: Centerline — smooth solid track through forecast positions
    map.addLayer({
        id: SLEEVE_CENTER,
        type: 'line',
        source: SLEEVE_SOURCE,
        filter: ['==', ['get', 'layer'], 'center'],
        paint: {
            'line-width': 2,
            'line-opacity': 0.9,
            'line-color': '#ffffff',
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' },
    });

    log.info(
        `[CYCLONE] 🌀 Probability sleeve rendered for ${cyclone.name} (${smoothTrack.length} smooth points, ${totalHours.toFixed(0)}h window)`,
    );
}

// ── Hook ──────────────────────────────────────────────────

export function useCycloneLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    userLat: number,
    userLon: number,
    onClosestStorm?: (storm: ActiveCyclone | null) => void,
    skipAutoFlyRef?: React.MutableRefObject<boolean>,
    selectedStorm?: ActiveCyclone | null,
    /** Fires when the user taps a storm marker on the map. Used by the
     *  host (MapHub) to fly to that storm + highlight it — previously
     *  markers were purely decorative and tap did nothing, so in a
     *  multi-storm basin the user had no way to focus a specific storm
     *  short of opening the StormPicker modal. */
    onSelectStorm?: (storm: ActiveCyclone) => void,
) {
    // (categoryLabels, categoryColor moved to module scope below)
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const dataAgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasFlown = useRef(false);
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const trackOverlayRef = useRef<ReturnType<typeof createTrackOverlay> | null>(null);
    const cyclonesRef = useRef<ActiveCyclone[]>([]);
    const userLatRef = useRef(userLat);
    const userLonRef = useRef(userLon);
    const onClosestStormRef = useRef(onClosestStorm);
    const selectedStormRef = useRef(selectedStorm ?? null);
    const onSelectStormRef = useRef(onSelectStorm);

    /** Locked storm center — map snaps back here after any pan */
    const stormCenterRef = useRef<[number, number] | null>(null); // [lng, lat]
    /** Previous maxZoom to restore when exiting the layer */
    const prevMaxZoomRef = useRef<number | null>(null);
    /** Flag: we initiated this move, don't snap back */
    const selfMoveRef = useRef(false);
    /** Max zoom for the cyclone view — satellite IR is ~4 km, blurry past z8 */
    const CYCLONE_MAX_ZOOM = 8;
    /** The zoom this view intends to be at, for anything that needs to know
     *  the target while the opening flight is still in the air. */
    const openZoomRef = useRef(CYCLONE_OPEN_ZOOM);

    userLatRef.current = userLat;
    userLonRef.current = userLon;
    onClosestStormRef.current = onClosestStorm;
    selectedStormRef.current = selectedStorm ?? null;
    onSelectStormRef.current = onSelectStorm;

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!visible) {
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            trackOverlayRef.current?.remove();
            trackOverlayRef.current = null;
            cyclonesRef.current = [];
            hasFlown.current = false;
            removeCloudOverlay(map);

            // Release center lock + restore zoom limits
            stormCenterRef.current = null;
            map.setMinZoom(0);
            if (prevMaxZoomRef.current !== null) {
                map.setMaxZoom(prevMaxZoomRef.current);
                prevMaxZoomRef.current = null;
            }

            // ── Clean up all GeoJSON layers added by cyclone view ──
            // Country borders
            const BORDER_ID = 'storm-black-borders';
            if (map.getLayer(BORDER_ID)) map.removeLayer(BORDER_ID);
            if (map.getSource(BORDER_ID)) map.removeSource(BORDER_ID);

            // Probability sleeve
            const sleeveLayers = [
                'cyclone-sleeve-glow',
                'cyclone-sleeve-core',
                'cyclone-sleeve-edge',
                'cyclone-sleeve-center',
            ];
            for (const id of sleeveLayers) {
                if (map.getLayer(id)) map.removeLayer(id);
            }
            if (map.getSource('cyclone-sleeve-src')) map.removeSource('cyclone-sleeve-src');

            // Per-storm past track lines (dynamic IDs: past-track-{sid}-outline, past-track-{sid}-line)
            // getStyle() throws if style isn't loaded; cleanup shouldn't crash the app.
            if (map.isStyleLoaded()) {
                for (const layerId of map.getStyle()?.layers?.map((l) => l.id) ?? []) {
                    if (layerId.startsWith('past-track-')) {
                        map.removeLayer(layerId);
                    }
                }
                for (const srcId of Object.keys(map.getStyle()?.sources ?? {})) {
                    if (srcId.startsWith('past-track-')) {
                        map.removeSource(srcId);
                    }
                }
            }

            // HUD overlay
            const hudEl = map.getContainer().querySelector('#cyclone-hud-badges');
            if (hudEl) hudEl.remove();

            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (dataAgeTimer.current) {
                clearInterval(dataAgeTimer.current);
                dataAgeTimer.current = null;
            }
            return;
        }

        injectCycloneCSS();

        // ── Synoptic view: CYCLONE_OPEN_ZOOM, user dead centre ──
        // minZoom stays 1 — the opening frame changed, not the floor.
        prevMaxZoomRef.current = map.getMaxZoom();
        map.setMinZoom(1);
        map.setMaxZoom(CYCLONE_MAX_ZOOM);
        openZoomRef.current = CYCLONE_OPEN_ZOOM;

        const uLat = userLatRef.current;
        const uLon = userLonRef.current;
        if (isFinite(uLat) && isFinite(uLon) && (uLat !== 0 || uLon !== 0)) {
            map.flyTo({ center: [uLon, uLat], zoom: CYCLONE_OPEN_ZOOM, duration: 800 });
        } else {
            map.easeTo({ center: [145, -28], zoom: CYCLONE_OPEN_ZOOM, duration: 400 });
        }

        const onMoveEnd = () => {
            // Don't snap back if WE initiated the move
            if (selfMoveRef.current) {
                selfMoveRef.current = false;
                return;
            }
            const locked = stormCenterRef.current;
            if (!locked) return;
            const center = map.getCenter();
            const dLng = Math.abs(center.lng - locked[0]);
            const dLat = Math.abs(center.lat - locked[1]);
            // Threshold: ~0.01° at z5 is sub-pixel. Anything more = user panned.
            if (dLng > 0.01 || dLat > 0.01) {
                selfMoveRef.current = true;
                map.easeTo({ center: locked, duration: 300 });
            }
        };
        map.on('moveend', onMoveEnd);

        // ── Create track overlay (SVG neon tube) on first use ──
        const ensureTrackOverlay = () => {
            if (!trackOverlayRef.current) {
                trackOverlayRef.current = createTrackOverlay(map);
            }
            return trackOverlayRef.current;
        };

        // ── TCVITALS-ONLY SYNC ──
        // ALWAYS position storm icons at the GFS model's internal eye position.
        // This is the ONLY source of truth for the "red dot" location.
        let unsubWind: (() => void) | null = null;
        const gfsTrackRef: { current: Map<string, GfsTrackerPosition[]> | null } = { current: null };

        // Cached service modules — populated in loadCyclones(), used by sync helpers
        let _cs: Awaited<ReturnType<typeof getCycloneService>> | null = null;

        // Fetch GFS tracker positions on mount — AWAIT before creating markers
        const tcvitalsPromise = getCycloneService()
            .then(({ fetchGfsTrackerPositions }) => fetchGfsTrackerPositions())
            .then((trackMap) => {
                gfsTrackRef.current = trackMap;
                log.info(`[CYCLONE] 🎯 TCVitals loaded: ${trackMap.size} storm(s)`);
                for (const [sid, positions] of trackMap) {
                    const p = positions[0];
                    log.info(`[CYCLONE] 🎯 ${sid}: ${p.lat.toFixed(1)}, ${p.lon.toFixed(1)} (vmax=${p.vmax}kt)`);
                }
                return trackMap;
            })
            .catch((e) => {
                log.warn('[CYCLONE] TCVitals fetch failed', e);
                return new Map<string, GfsTrackerPosition[]>();
            });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unsubWind = WindStore.subscribe((_state: any) => {
            // Pressure-based positioning is the source of truth.
            // No wind-based re-scanning needed — pressure minimum is stable.
        });

        // categoryLabels and categoryColor are defined at module scope

        // ── Rebuild markers — HUD badge + geo-anchored storm eye markers ──
        const HUD_CONTAINER_ID = 'cyclone-hud-badges';
        const rebuildMarkers = () => {
            // DOES NOT TOUCH THE HUD ANY MORE (Shane 2026-08-23: "when i first
            // open it up the info box is there but it disappears. when i go
            // back in, it stays").
            //
            // This function used to BUILD the storm badge as well as the
            // markers, so removing it here was correct. The badge half was
            // stripped on 2026-04-15 (see the note at the tail of this
            // function) and, when the card was restored on 2026-08-21, it came
            // back in a SEPARATE effect — but this removal was left behind. So
            // rebuildMarkers deleted a card it no longer creates, and the
            // deletion was PERMANENT: the card effect's deps are
            // [selectedStorm?.sid, visible, mapReady], and the 30-minute
            // refresh hands React a fresh ActiveCyclone with an UNCHANGED sid,
            // so nothing ever re-runs it.
            //
            // Two routes reach here after the card has mounted, and this
            // removal killed it on both:
            //   · onZoomEnd (below) calls rebuildMarkers whenever the rounded
            //     zoom changes. The view opens at the chart's boot zoom, gets
            //     clamped to CYCLONE_MAX_ZOOM and then flown to the synoptic
            //     frame — several integer steps, landing a second or two
            //     AFTER the card. Re-open and the camera is already there, so
            //     nothing fires. That is the first-open/second-open asymmetry.
            //   · the storm picker: handleSelectStorm sets skipAutoFlyRef, so
            //     the `if (!skipAutoFlyRef?.current)` guard below suppresses
            //     the setState, the sid never changes, and the rebuild that
            //     follows wipes the card the pick just mounted.
            //
            // (An earlier draft of this comment blamed the async fetches
            // landing late. That was wrong: onClosestStorm and rebuildMarkers
            // are adjacent synchronous statements, so React cannot flush the
            // card between them — and both fetches are module-cached on the
            // same TTL, which would make a warm second open worse, not better.)
            //
            // The card effect owns #cyclone-hud-badges outright: it replaces
            // any existing one before appending and removes it on cleanup.
            // The other three removers are the !visible teardown, the main
            // effect's cleanup, and the card effect's own — all owners.

            // Clean up any old geo-anchored markers
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];

            const cyclones = cyclonesRef.current;
            if (!cyclones || cyclones.length === 0) return;

            const zoom = map.getZoom();

            // ── Create geo-anchored spinning storm markers for ALL cyclones ──
            for (const cyclone of cyclones) {
                // Use GFS tracker position if available, else ATCF position
                let eyeLat = cyclone.currentPosition.lat;
                let eyeLon = cyclone.currentPosition.lon;

                if (gfsTrackRef.current && gfsTrackRef.current.size > 0 && _cs) {
                    const gfsPos = _cs.interpolateGfsTracker(
                        gfsTrackRef.current,
                        cyclone.sid,
                        0, // T+0 (current)
                        cyclone.name,
                        eyeLat,
                        eyeLon,
                    );
                    if (gfsPos) {
                        eyeLat = gfsPos.lat;
                        eyeLon = gfsPos.lon;
                    }
                }

                const markerEl = createStormMarkerEl(cyclone, zoom);

                // Tap-to-select: in a multi-storm basin the user needs a
                // way to focus a specific storm directly from the chart.
                // Previously markers were decorative only — if the picker
                // modal was dismissed, there was no way back to a storm
                // without re-opening the menu. Now tapping any marker
                // flies to it + highlights it via the host's select
                // handler (same path as the picker modal).
                markerEl.style.cursor = 'pointer';
                markerEl.setAttribute('role', 'button');
                markerEl.setAttribute(
                    'aria-label',
                    `Select ${cyclone.name || 'storm'} category ${cyclone.categoryLabel ?? cyclone.category}`,
                );
                const onMarkerClick = (ev: Event) => {
                    // Stop Mapbox from interpreting the tap as a map click
                    // (which would deselect things / drop the "closest
                    // storm" auto-selection we just overrode).
                    ev.stopPropagation();
                    ev.preventDefault();
                    onSelectStormRef.current?.(cyclone);
                };
                markerEl.addEventListener('click', onMarkerClick);
                // Mobile: also listen for touchend so the click doesn't
                // have to wait for the 300ms click-delay some iOS WebViews
                // still impose when a pointer-events: none overlay is in
                // play underneath. { passive: false } so preventDefault
                // actually suppresses the synthetic click.
                markerEl.addEventListener(
                    'touchend',
                    (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        onSelectStormRef.current?.(cyclone);
                    },
                    { passive: false },
                );

                const marker = new mapboxgl.Marker({ element: markerEl, anchor: 'center' })
                    .setLngLat([eyeLon, eyeLat])
                    .addTo(map);
                markersRef.current.push(marker);
            }

            // HUD badge removed — the storm marker + forecast track provide
            // all the info the user needs. Less clutter on the chart.
        };

        let lastZoomInt = Math.round(map.getZoom());

        const onZoomEnd = () => {
            const zi = Math.round(map.getZoom());
            if (zi !== lastZoomInt) {
                lastZoomInt = zi;
                rebuildMarkers();
            }
        };
        map.on('zoomend', onZoomEnd);

        // Fetch and render
        let cancelled = false;

        const loadCyclones = async () => {
            // CRITICAL: wait for tcvitals before creating markers
            await tcvitalsPromise;

            // Cached for sync access in rebuildMarkers/cleanup. The satellite
            // service used to be loaded alongside it; the storm view now draws
            // the shared world cloud overlay instead, so that import is gone.
            _cs = await getCycloneService();

            log.info('[CYCLONE] 🌀 Fetching active cyclones (for discovery only)...');
            try {
                const cyclones = await _cs.fetchActiveCyclones();
                if (cancelled) return;

                log.info(`[CYCLONE] Got ${cyclones.length} active cyclone(s)`);

                if (cyclones.length === 0) {
                    onClosestStormRef.current?.(null);
                    return;
                }

                cyclonesRef.current = cyclones;
                lastZoomInt = Math.round(map.getZoom());

                // ── Update track overlay (SVG cone + centerline + dots) ──
                ensureTrackOverlay().update(cyclones);

                // ── Native Mapbox GL past track lines (render on canvas, always visible) ──
                for (const c of cyclones) {
                    const srcId = `past-track-${c.sid}`;
                    const outlineId = `${srcId}-outline`;
                    const lineId = `${srcId}-line`;

                    // Clean up any existing layers from previous load
                    if (map.getLayer(lineId)) map.removeLayer(lineId);
                    if (map.getLayer(outlineId)) map.removeLayer(outlineId);
                    if (map.getSource(srcId)) map.removeSource(srcId);

                    // Build coordinate array from track history + current position
                    const trackCoords: [number, number][] = sanitizeTrackLongitudes(
                        c.track.map((p) => [p.lon, p.lat] as [number, number]),
                    );

                    log.info(`[CYCLONE] 🛤️ ${c.name} past track: ${trackCoords.length} points`);

                    if (trackCoords.length < 2) continue;

                    // Smooth via Catmull-Rom spline on geographic coords
                    const smoothCoords = catmullRomSpline(trackCoords, 6);

                    const geojson: GeoJSON.FeatureCollection = {
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: {},
                                geometry: {
                                    type: 'LineString',
                                    coordinates: smoothCoords,
                                },
                            },
                        ],
                    };

                    map.addSource(srcId, { type: 'geojson', data: geojson });

                    // Black outline
                    map.addLayer({
                        id: outlineId,
                        type: 'line',
                        source: srcId,
                        paint: {
                            'line-color': '#000',
                            'line-width': 5,
                            'line-opacity': 0.6,
                        },
                        layout: {
                            'line-cap': 'round',
                            'line-join': 'round',
                        },
                    });

                    // White inner line
                    map.addLayer({
                        id: lineId,
                        type: 'line',
                        source: srcId,
                        paint: {
                            'line-color': '#fff',
                            'line-width': 2.5,
                            'line-opacity': 0.95,
                        },
                        layout: {
                            'line-cap': 'round',
                            'line-join': 'round',
                        },
                    });
                }

                // ── DOT POSITIONED AT ATCF SATELLITE-ANALYZED POSITION ──
                // The ATCF position is determined by JTWC/NHC from actual satellite imagery
                // analysis (Dvorak technique). This IS the most accurate eye position available.
                // No GRIB scanning needed — the marker was already placed at the correct
                // lat/lon from the tcvitals T+0 or API position above.
                log.info(`[CYCLONE] 🔴 Using ATCF satellite-analyzed positions for ${cyclones.length} storm(s)`);

                // Find & report closest storm — but ONLY update if user hasn't manually selected
                const closest = _cs!.findClosestCyclone(cyclones, userLatRef.current, userLonRef.current);
                if (!skipAutoFlyRef?.current) {
                    // No manual selection — use geo-closest
                    onClosestStormRef.current?.(closest);
                }

                // ── Render Mapbox GL probability polygon (geographic cone) ──
                // ONE storm, the one the punter is looking at. This was a loop
                // over every storm writing into the SAME source, so each call
                // overwrote the last and the sleeve always showed whichever
                // storm the array happened to end with — NARRA's cone under
                // LALA's card, measured live on 2026-08-24. Selection-aware
                // now, and the selection effect below re-draws it on a step.
                const sleeveStorm = selectedStormRef.current
                    ? (cyclones.find((c) => c.sid === selectedStormRef.current?.sid) ?? closest)
                    : closest;
                if (sleeveStorm) addProbabilitySleeve(map, sleeveStorm);

                rebuildMarkers();

                // The card's numbers come from the catalogue we just loaded,
                // not from a prop: React never re-runs the card effect,
                // because the sid has not changed. In place, no camera move.
                const sel = selectedStormRef.current;
                const freshSel = sel ? cyclones.find((c) => c.sid === sel.sid) : undefined;
                if (freshSel) {
                    refreshStormCardInPlace(map.getContainer(), freshSel);
                    // The card's badge and its stepper are separate nodes, and
                    // only this pass can add a stepper that was impossible at
                    // mount time because the storm list had not arrived yet.
                    ensureStormSwitcher(map.getContainer(), cyclonesRef.current, freshSel, (next) =>
                        onSelectStormRef.current?.(next),
                    );
                }

                // ── World cloud overlay (Shane 2026-08-24) ──
                // WAS a per-basin satellite IR product: RealEarth Himawari for
                // the Australian region, IEM GOES-East/West for the Americas
                // and Pacific, picked from the selected storm's basin because
                // Himawari at 140.7°E cannot see the central Pacific.
                //
                // All of that machinery existed to make satellite IMAGERY act
                // like an overlay, and it is gone: the storm view now shows the
                // same world cloud layer the Sky menu serves, which is global
                // by construction (so no basin selection), carries real alpha
                // (so no luminance ramp), and looks identical to the cloud the
                // punter already knows from the chart.
                //
                // Anchoring is unchanged — above the imagery, below the chart —
                // and now comes from the one shared helper rather than being
                // reimplemented per subsystem, which is precisely how the
                // squall page and this page drifted apart in the first place.
                const satLayers = map.getStyle()?.layers ?? [];
                mountCloudOverlay(map, cloudOverlayBeforeId(satLayers));
                log.info('[CYCLONE] ☁️ World cloud overlay activated for storm view');

                // Fly to focused storm on first load & lock center
                const focusTarget = selectedStormRef.current ?? closest;
                if (focusTarget && !hasFlown.current) {
                    hasFlown.current = true;
                    // Resolve eye position from GFS tracker if available
                    let flyLat = focusTarget.currentPosition.lat;
                    let flyLon = focusTarget.currentPosition.lon;
                    if (gfsTrackRef.current && gfsTrackRef.current.size > 0 && _cs) {
                        const gfsPos = _cs.interpolateGfsTracker(
                            gfsTrackRef.current,
                            focusTarget.sid,
                            0,
                            focusTarget.name,
                            focusTarget.currentPosition.lat,
                            focusTarget.currentPosition.lon,
                        );
                        if (gfsPos) {
                            flyLat = gfsPos.lat;
                            flyLon = gfsPos.lon;
                        }
                    }

                    // Lock the storm center — moveend handler snaps back to this
                    stormCenterRef.current = [flyLon, flyLat];

                    if (skipAutoFlyRef?.current) {
                        skipAutoFlyRef.current = false;
                        log.info(`[CYCLONE] ✈️ Skipping auto-fly (user selected a storm manually)`);
                    } else {
                        selfMoveRef.current = true;
                        log.info(
                            `[CYCLONE] ✈️ Flying to ${focusTarget.name} at ${flyLat.toFixed(1)}, ${flyLon.toFixed(1)} (center-locked)`,
                        );
                        map.flyTo({
                            center: [flyLon, flyLat],
                            zoom: CYCLONE_OPEN_ZOOM,
                            duration: 2000,
                            essential: true,
                        });
                    }
                }
            } catch (e) {
                log.error('[CYCLONE] ❌ Error loading cyclones:', e);
            }
        };

        loadCyclones();
        refreshTimer.current = setInterval(loadCyclones, 30 * 60 * 1000);

        // ── Live data age ticker — updates card timestamps every 60s ──
        const tickDataAge = () => {
            const container = map.getContainer();
            // Update all data age spans
            container.querySelectorAll('.cyclone-data-age').forEach((el) => {
                const advTime = (el as HTMLElement).dataset.advisoryTime;
                if (!advTime) return;
                const ageMin = Math.round((Date.now() - new Date(advTime).getTime()) / 60000);
                let ageStr: string;
                if (ageMin < 60) ageStr = `${ageMin} min ago`;
                else if (ageMin < 1440) ageStr = `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
                else ageStr = `${Math.floor(ageMin / 1440)}d ago`;
                el.textContent = ageStr;
            });
            // Update next advisory countdown
            container.querySelectorAll('.cyclone-next-adv').forEach((el) => {
                const now = new Date();
                const utcH = now.getUTCHours();
                const advisorySlots = [0, 6, 12, 18];
                let nextAdv = advisorySlots.find((h) => h > utcH) ?? advisorySlots[0] + 24;
                if (nextAdv < utcH) nextAdv += 24;
                const nextAdvDate = new Date(now);
                nextAdvDate.setUTCHours(nextAdv % 24, 0, 0, 0);
                if (nextAdv >= 24) nextAdvDate.setUTCDate(nextAdvDate.getUTCDate() + 1);
                const nextAdvMin = Math.round((nextAdvDate.getTime() - now.getTime()) / 60000);
                const h = Math.floor(nextAdvMin / 60);
                const m = nextAdvMin % 60;
                el.textContent = `~${h}h ${m}m`;
            });
        };
        dataAgeTimer.current = setInterval(tickDataAge, 60 * 1000);

        return () => {
            unsubWind?.();
            cancelled = true;
            map.off('zoomend', onZoomEnd);
            map.off('moveend', onMoveEnd);
            // Release center lock + restore zoom
            stormCenterRef.current = null;
            map.setMinZoom(0);
            if (prevMaxZoomRef.current !== null) {
                map.setMaxZoom(prevMaxZoomRef.current);
                prevMaxZoomRef.current = null;
            }
            // Clean up HUD
            const hudEl = map.getContainer().querySelector(`#${HUD_CONTAINER_ID}`);
            if (hudEl) hudEl.remove();
            removeCloudOverlay(map);
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            if (dataAgeTimer.current) {
                clearInterval(dataAgeTimer.current);
                dataAgeTimer.current = null;
            }
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            cyclonesRef.current = [];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // ── Rebuild HUD + re-lock center when selected storm changes ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !selectedStorm) return;

        // ── The storm details card (restored 2026-08-21) ──
        // This effect's own comment has said "Rebuild HUD" since April; the
        // HUD half was stripped out and the comment left behind. The cleanup
        // that looks for #cyclone-hud-badges (above) was left behind too, and
        // so was the 60 s tickDataAge timer — all of it waiting for a card
        // that stopped being created.
        const HUD_ID = 'cyclone-hud-badges';
        const existing = map.getContainer().querySelector(`#${HUD_ID}`);
        if (existing) existing.remove();

        const hud = document.createElement('div');
        hud.id = HUD_ID;
        // TOP ALIGNS WITH THE MOB FAB (Shane 2026-08-23) — and that is not a
        // constant, so it cannot live here as one.
        //
        // MOB sits inside .radial-helm-menu (absolute top:192px) at
        // .radial-helm-mob { top: calc(env(safe-area-inset-top)/2 - 95px) },
        // i.e. 97px + half the notch inset, and it moves to a different
        // anchor entirely in short landscape. A hard-coded 108/116 here was
        // right on exactly one device and drifted on every other, which is
        // how it landed in the pill row in the first place.
        //
        // So the offset moves to index.css beside .radial-helm-mob, derived
        // from the same numbers and carrying the same landscape override.
        // Keeping the two adjacent is the point: they are now one decision.
        //
        // z-index 760, NOT 600: the FAB rail is z-700 and the route banner
        // z-720, so at 600 the storm card could be covered by furniture —
        // "make sure that it is on top of all other layers".
        hud.className = 'storm-hud-badges';
        hud.style.cssText = `
            position: absolute;
            left: 16px;
            z-index: 760;
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;
        `;
        // Idempotent, and NOT redundant: the keyframes are injected by the
        // [visible, mapReady] effect, which is a different effect from this
        // one. In practice it runs first, but "in practice" is not a
        // guarantee — and if this ever ran first the card would silently
        // appear with no unroll, because CSS ignores an unknown animation
        // name rather than erroring.
        injectCycloneCSS();
        hud.appendChild(createStormBadgeStatic(selectedStorm));
        // The sleeve follows the selection: stepping storms must swap the GL
        // cone with the card, or the punter reads one storm's numbers over
        // another storm's probability envelope.
        addProbabilitySleeve(map, selectedStorm);
        // STEP BETWEEN STORMS WITHOUT THE MENU (Shane 2026-08-23: "we need a
        // way to select a different storm without having to go back through
        // the menu").
        //
        // Tapping a marker already selects (onSelectStorm), but the cyclone
        // view LOCKS the camera on the selected storm — so in a live Pacific
        // the other three are off-screen and there is nothing left to tap.
        // The only route back was the StormPicker modal, which is the menu he
        // is describing. A stepper on the card needs no camera and no modal.
        const switcher = createStormSwitcher(cyclonesRef.current, selectedStorm, (next) =>
            onSelectStormRef.current?.(next),
        );
        if (switcher) hud.appendChild(switcher);
        map.getContainer().appendChild(hud);

        // Update the center lock to the newly selected storm
        const newCenter: [number, number] = [selectedStorm.currentPosition.lon, selectedStorm.currentPosition.lat];
        stormCenterRef.current = newCenter;
        selfMoveRef.current = true;
        // Recentre on the picked storm and OTHERWISE LEAVE THE ZOOM ALONE —
        // but map.getZoom() mid-flight is a transient, not the user's choice.
        // The opening sequence flies from the chart's boot zoom (10) down to
        // CYCLONE_OPEN_ZOOM, and this effect fires the moment a storm is
        // selected, which on a first open is while that flight is still in
        // the air. Reading the camera then clamps to CYCLONE_MAX_ZOOM and
        // parks the view at z8 — so "opens at 2.1" would have held only when
        // no storm was selected, i.e. almost never.
        const settledZoom =
            typeof map.isMoving === 'function' && map.isMoving()
                ? openZoomRef.current
                : Math.min(map.getZoom(), CYCLONE_MAX_ZOOM);
        map.flyTo({ center: newCenter, zoom: settledZoom, duration: 1200 });

        return () => {
            const card = map.getContainer().querySelector(`#${HUD_ID}`);
            if (card) card.remove();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedStorm?.sid, visible, mapReady]);
}

// ═══════════════════════════════════════════════════════════════════
// STORM DETAILS BADGE — restored 2026-08-21
//
// This card was removed on 2026-04-15 (b418d518) for one stated reason:
// "Strip the HUD legend/badge overlay from cyclone view (less clutter)".
// No API died, nothing was deprecated, nothing cost money — it was purely
// an aesthetic call, and its builders then sat as dead code until the July
// sweeps deleted them (4d0e720b, 391 deletions). Shane asked for it back
// (2026-08-21: "we also had a box with all of the details of the storm").
//
// Restored verbatim from 51e3b46d^ — the last revision holding the fully
// evolved implementation. Every dependency it needs (resolveStormName,
// categoryColor, stormClassification, categoryLabels) survived the sweeps,
// and the 60-second tickDataAge() timer BELOW has been running this whole
// time, scanning for .cyclone-data-age and .cyclone-next-adv elements that
// stopped existing four months ago; it starts doing useful work again the
// moment this card mounts.
//
// NOTE this lives on the CYCLONE layer and appears only for a NAMED storm
// in the catalogue — it never showed for ordinary squall cells.
// ═══════════════════════════════════════════════════════════════════

// ── Shared helpers for building badge data from an ActiveCyclone ──

/** Extract last N advisory rows from track for the table display */
function extractAdvisories(cyclone: ActiveCyclone, count = 5): StormBadgeData['advisories'] {
    // Combine track + current position, sort by time descending
    const allPositions = [...cyclone.track];
    // Ensure current position is included
    const currentTime = new Date(cyclone.currentPosition.time).getTime();
    const hasCurrentInTrack = allPositions.some(
        (p) => Math.abs(new Date(p.time).getTime() - currentTime) < 30 * 60 * 1000,
    );
    if (!hasCurrentInTrack) allPositions.push(cyclone.currentPosition);

    // Sort descending (most recent first)
    allPositions.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

    // Take last N, filter out entries without valid times
    const recent = allPositions.filter((p) => p.time && !isNaN(new Date(p.time).getTime())).slice(0, count);

    return recent.map((p, i) => {
        const d = new Date(p.time);
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dateStr = `${d.getUTCDate()} ${monthNames[d.getUTCMonth()]}`;
        const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        return {
            date: dateStr,
            time: timeStr,
            windKts: p.windKts,
            pressureMb: p.pressureMb,
            isLatest: i === 0,
        };
    });
}

/** Determine pressure trend from last 2 advisory positions */
function computePressureTrend(cyclone: ActiveCyclone): 'deepening' | 'steady' | 'filling' {
    const positions = [...cyclone.track]
        .filter((p) => p.pressureMb != null && p.pressureMb > 0)
        .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    if (positions.length < 2) return 'steady';
    const prev = positions[positions.length - 2].pressureMb!;
    const curr = positions[positions.length - 1].pressureMb!;
    const delta = curr - prev;
    if (delta <= -2) return 'deepening'; // Pressure dropping ≥ 2 hPa
    if (delta >= 2) return 'filling'; // Pressure rising ≥ 2 hPa
    return 'steady';
}

/** Approximate intensification probability from pressure trend + current wind speed */
function computeDevProbability(cyclone: ActiveCyclone): 'LOW' | 'MODERATE' | 'HIGH' {
    const trend = computePressureTrend(cyclone);
    const windKts = cyclone.maxWindKts;
    // Deepening + already strong = HIGH risk of further intensification
    if (trend === 'deepening') return windKts >= 50 ? 'HIGH' : 'MODERATE';
    // Steady but already hurricane-force = MODERATE
    if (trend === 'steady') return windKts >= 64 ? 'MODERATE' : 'LOW';
    // Filling (pressure rising) = LOW
    return 'LOW';
}

/** Build common StormBadgeData from an ActiveCyclone */
function buildBadgeData(cyclone: ActiveCyclone, onClose?: () => void): StormBadgeData {
    const accentColor = categoryColor(cyclone.category);
    const catLabel = categoryLabels[cyclone.categoryLabel] ?? `Cat ${cyclone.categoryLabel}`;
    const stormName = resolveStormName(cyclone);
    const classification = stormClassification(cyclone.basin, cyclone.maxWindKts);

    const lat = cyclone.currentPosition.lat;
    const lon = cyclone.currentPosition.lon;
    const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

    const posTime = cyclone.lastAdvisoryTime || cyclone.currentPosition.time;
    let dataAgeStr = '—';
    let dataTimeStr = '—';
    if (posTime) {
        const posDate = new Date(posTime);
        const ageMin = Math.round((Date.now() - posDate.getTime()) / 60000);
        if (ageMin < 60) dataAgeStr = `${ageMin} min ago`;
        else if (ageMin < 1440) dataAgeStr = `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
        else dataAgeStr = `${Math.floor(ageMin / 1440)}d ago`;
        dataTimeStr = posDate.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    }

    const now = new Date();
    const utcH = now.getUTCHours();
    const advisorySlots = [0, 6, 12, 18];
    let nextAdv = advisorySlots.find((h) => h > utcH) ?? advisorySlots[0] + 24;
    if (nextAdv < utcH) nextAdv += 24;
    const nextAdvDate = new Date(now);
    nextAdvDate.setUTCHours(nextAdv % 24, 0, 0, 0);
    if (nextAdv >= 24) nextAdvDate.setUTCDate(nextAdvDate.getUTCDate() + 1);
    const nextAdvMin = Math.round((nextAdvDate.getTime() - now.getTime()) / 60000);
    const nextAdvStr = nextAdvMin < 60 ? `~${nextAdvMin} min` : `~${Math.floor(nextAdvMin / 60)}h ${nextAdvMin % 60}m`;

    const basinLabels: Record<string, string> = {
        WP: 'W. Pacific',
        EP: 'E. Pacific',
        AL: 'Atlantic',
        IO: 'Indian Ocean',
        SI: 'S. Indian',
        SP: 'S. Pacific',
        SH: 'S. Hemisphere',
    };
    const basinStr = basinLabels[cyclone.basin] ?? cyclone.basin;

    return {
        accentColor,
        catLabel,
        stormName,
        classification,
        basinStr,
        sid: cyclone.sid,
        latStr,
        lonStr,
        dataTimeStr,
        dataAgeStr,
        posTime: posTime || '',
        nextAdvStr,
        advisories: extractAdvisories(cyclone),
        pressureTrend: computePressureTrend(cyclone),
        devProbability: computeDevProbability(cyclone),
        onClose,
    };
}

/**
 * The prev/next storm stepper that sits under the details card.
 *
 * Returns null for a single storm — a stepper that cannot step is furniture.
 *
 * Ordered by NAME, not by the load order of `cyclonesRef`: that array is
 * rebuilt by the 30-minute refresh and its order is whatever the feed
 * returned, so stepping "next" twice could land you back where you started.
 * Alphabetical is arbitrary but STABLE, which is the property that matters
 * when the control is a pair of arrows.
 */
/** Which storms this bar was built for, and which one it thinks is current. */
function stormSwitcherSignature(storms: readonly ActiveCyclone[], current: ActiveCyclone): string {
    return `${storms.map((c) => c.sid).join(',')}|${current.sid}`;
}

/**
 * Put the stepper back when it could not exist at mount time.
 *
 * THE FIRST-RUN BUG (Shane 2026-08-24: "the switch between storms button is
 * not showing on the first run, sometimes"). createStormSwitcher returns null
 * below 2 storms, and the card is built the moment a storm is SELECTED —
 * which on a cold open beats the cyclone list finishing its load. Whether you
 * got a stepper came down to which of those won the race, hence "sometimes":
 * warm cache, list already there, bar appears; cold fetch, one storm known,
 * no bar, and nothing afterwards ever reconsidered.
 *
 * Nothing did because the two halves are separate DOM nodes:
 * refreshStormCardInPlace only rebuilds the BADGE wrapper (hud's first child)
 * and returns early when the badge signature is unchanged, while the stepper
 * is a sibling appended after it. A storm list arriving late moved neither.
 *
 * So this runs on every cyclone refresh and is idempotent: it rebuilds only
 * when the storm set or the selection actually changed, and removes the bar
 * again if the fleet drops back to a single storm.
 */
export function ensureStormSwitcher(
    container: HTMLElement,
    all: readonly ActiveCyclone[],
    current: ActiveCyclone,
    onPick: (storm: ActiveCyclone) => void,
): void {
    const hud = container.querySelector('#cyclone-hud-badges');
    if (!hud) return;
    const existing = hud.querySelector('[data-storm-switcher]') as HTMLElement | null;
    const sorted = [...all].sort((a, b) => resolveStormName(a).localeCompare(resolveStormName(b)));
    if (sorted.length < 2) {
        // Down to one storm — a stepper with nowhere to step is a dead control.
        existing?.remove();
        return;
    }
    if (existing && existing.dataset.stormSwitcher === stormSwitcherSignature(sorted, current)) return;
    const fresh = createStormSwitcher(all, current, onPick);
    if (!fresh) return;
    if (existing) existing.replaceWith(fresh);
    else hud.appendChild(fresh);
}

export function createStormSwitcher(
    all: readonly ActiveCyclone[],
    current: ActiveCyclone,
    onPick: (storm: ActiveCyclone) => void,
): HTMLDivElement | null {
    const storms = [...all].sort((a, b) => resolveStormName(a).localeCompare(resolveStormName(b)));
    if (storms.length < 2) return null;
    const idx = Math.max(
        0,
        storms.findIndex((c) => c.sid === current.sid),
    );

    const bar = document.createElement('div');
    bar.dataset.stormSwitcher = stormSwitcherSignature(storms, current);
    bar.style.cssText = `
        display:flex;align-items:center;justify-content:space-between;gap:6px;
        background:rgba(10,15,30,0.92);backdrop-filter:blur(20px);
        -webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:4px;pointer-events:auto;
        font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,0.6);
    `;

    const step = (delta: number): void => {
        // Wrap both ways so the last storm steps forward to the first.
        const next = storms[(idx + delta + storms.length) % storms.length];
        if (next && next.sid !== current.sid) onPick(next);
    };

    const arrow = (label: string, dir: -1 | 1, aria: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', aria);
        // 44px minimum: this is a helm control on a moving boat.
        b.style.cssText = `
            min-width:44px;min-height:36px;border:0;border-radius:9px;
            background:rgba(255,255,255,0.06);color:#fff;font-size:15px;
            line-height:1;cursor:pointer;flex-shrink:0;
        `;
        b.textContent = label;
        b.addEventListener('click', (e) => {
            // The card behind this bar toggles expand on click; without this
            // an arrow tap would also open the advisory table.
            e.stopPropagation();
            step(dir);
        });
        return b;
    };

    bar.appendChild(arrow('‹', -1, 'Previous storm'));

    const label = document.createElement('div');
    label.style.cssText = `
        flex:1;min-width:0;text-align:center;color:rgba(255,255,255,0.75);
        font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    `;
    label.textContent = `${idx + 1} / ${storms.length} · ${resolveStormName(current)}`;
    bar.appendChild(label);

    bar.appendChild(arrow('›', 1, 'Next storm'));
    return bar;
}

// ── Static badge builder (accessible outside the main effect closure) ──
export function createStormBadgeStatic(cyclone: ActiveCyclone, opts?: StormBadgeOpts): HTMLDivElement {
    const wrapper = document.createElement('div');
    buildStormBadgeDOM(wrapper, buildBadgeData(cyclone), opts);
    return wrapper;
}

/** How the card was left: expanded or collapsed, and whether it should
 *  re-play its entry animation. A refresh keeps both. */
interface StormBadgeOpts {
    expanded?: boolean;
    animate?: boolean;
}

/** Everything on the card that can change between advisories. Cheap, and it
 *  is what decides whether a refresh is worth doing at all. */
export function badgeSignature(c: ActiveCyclone): string {
    return [
        c.category,
        c.categoryLabel,
        c.maxWindKts,
        c.minPressureMb,
        c.currentPosition?.lat,
        c.currentPosition?.lon,
        c.lastAdvisoryTime ?? c.currentPosition?.time,
        c.track?.length ?? 0,
    ].join('|');
}

/**
 * REFRESH THE CARD IN PLACE, WITHOUT MOVING THE CAMERA (Shane 2026-08-23:
 * "fix the storm card numbers").
 *
 * The card is built by an effect keyed on [selectedStorm?.sid, visible,
 * mapReady], and the 30-minute reload hands React a new object with the SAME
 * sid — so the effect never re-ran and the pressure, category, wind and
 * position on screen were whatever they were when you opened the view. Only
 * the 60 s age tick moved, which made it look live while it was not. On a
 * card that exists to tell you what a cyclone is doing, that is the worst
 * kind of stale: confidently wrong.
 *
 * Widening the effect's deps was the obvious fix and is the wrong one — it
 * ends in a 1.2 s flyTo, so the camera would lurch every half hour.
 *
 * The fresh data is already local: loadCyclones writes cyclonesRef, so the
 * selected storm's new numbers are in hand without any prop round trip. This
 * swaps the card's contents for the same storm, keeps it expanded if the user
 * had it open, and skips the unroll so it does not flash.
 */
export function refreshStormCardInPlace(container: HTMLElement, fresh: ActiveCyclone): void {
    const hud = container.querySelector('#cyclone-hud-badges');
    const wrapper = hud?.firstElementChild as HTMLElement | null;
    if (!wrapper) return;
    if (wrapper.dataset.sig === badgeSignature(fresh)) return; // nothing moved
    // The body is display:block only while the user has it open.
    const wasExpanded = (wrapper.querySelector('[data-storm-body]') as HTMLElement | null)?.style.display === 'block';
    wrapper.replaceChildren();
    buildStormBadgeDOM(wrapper, buildBadgeData(fresh), { expanded: wasExpanded, animate: false });
    wrapper.dataset.sig = badgeSignature(fresh);
}

// ── Shared storm badge DOM builder (no innerHTML) ──
interface StormBadgeData {
    accentColor: string;
    catLabel: string;
    stormName: string;
    classification: string;
    basinStr: string;
    sid: string;
    latStr: string;
    lonStr: string;
    dataTimeStr: string;
    dataAgeStr: string;
    posTime: string;
    nextAdvStr: string;
    /** Last N track positions for the advisory table */
    advisories: { date: string; time: string; windKts: number | null; pressureMb: number | null; isLatest: boolean }[];
    /** Pressure trend: 'deepening' | 'steady' | 'filling' */
    pressureTrend: 'deepening' | 'steady' | 'filling';
    /** Intensification probability label */
    devProbability: 'LOW' | 'MODERATE' | 'HIGH';
    /** Callback to dismiss the HUD badge */
    onClose?: () => void;
}

function buildStormBadgeDOM(wrapper: HTMLElement, d: StormBadgeData, opts?: StormBadgeOpts): void {
    const card = document.createElement('div');
    card.style.cssText = `
        background:rgba(10,15,30,0.92);backdrop-filter:blur(20px);
        -webkit-backdrop-filter:blur(20px);border:1px solid ${d.accentColor}33;
        border-top:3px solid ${d.accentColor};border-radius:14px;
        padding:0;color:#fff;
        font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display',sans-serif;
        min-width:200px;max-width:320px;z-index:760;
        box-shadow:0 8px 32px rgba(0,0,0,0.7),0 0 16px ${d.accentColor}15;
        overflow:hidden;pointer-events:auto;cursor:pointer;
        ${opts?.animate === false ? '' : 'animation:storm-badge-unroll 260ms cubic-bezier(0.22,1,0.36,1);'}
    `;

    // ── Header: Storm name + classification + close button ──
    const header = document.createElement('div');
    header.style.cssText = `
        display:flex;align-items:flex-start;justify-content:space-between;
        padding:12px 14px 8px;
    `;

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'flex:1;min-width:0;';

    const titleEl = document.createElement('div');
    titleEl.style.cssText = `
        font-size:15px;font-weight:800;color:#fff;line-height:1.2;
        text-transform:capitalize;
    `;
    titleEl.textContent = d.stormName;
    headerLeft.appendChild(titleEl);

    const subtitleEl = document.createElement('div');
    subtitleEl.style.cssText = `font-size:10px;color:${d.accentColor};font-weight:600;margin-top:2px;text-transform:uppercase;letter-spacing:0.5px;`;
    subtitleEl.textContent = d.classification;
    headerLeft.appendChild(subtitleEl);

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.3);margin-top:2px;';
    metaEl.textContent = `${d.basinStr} · ${d.sid} · ${d.latStr} ${d.lonStr}`;
    headerLeft.appendChild(metaEl);

    header.appendChild(headerLeft);

    // Chevron toggle (replaces close button)
    const chevron = document.createElement('div');
    chevron.style.cssText = `
        width:24px;height:24px;display:flex;align-items:center;justify-content:center;
        flex-shrink:0;margin-left:8px;transition:transform 0.2s ease;
        color:rgba(255,255,255,0.4);
    `;
    chevron.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
    if (opts?.expanded === true) chevron.style.transform = 'rotate(180deg)';
    header.appendChild(chevron);

    card.appendChild(header);

    // ── Collapsible body — hidden by default ──
    const body = document.createElement('div');
    // Tagged so an in-place refresh can read back whether the user had it
    // open, and restore that rather than snapping it shut every 30 minutes.
    body.setAttribute('data-storm-body', '');
    let expanded = opts?.expanded === true;
    body.style.cssText = expanded ? 'display:block;' : 'display:none;';
    card.addEventListener('click', (e) => {
        e.stopPropagation();
        expanded = !expanded;
        body.style.display = expanded ? 'block' : 'none';
        chevron.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';
        card.style.minWidth = expanded ? '280px' : '200px';
    });

    // ── Advisory History Table ──
    if (d.advisories.length > 0) {
        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'padding:0 14px 10px;';

        // Column headers
        const headerRow = document.createElement('div');
        headerRow.style.cssText = `
            display:grid;grid-template-columns:1fr 1fr 1fr 1fr;
            gap:0;padding:4px 8px;margin-bottom:2px;
        `;
        const cols = [
            { label: 'DATE', sub: 'UTC' },
            { label: 'TIME', sub: '' },
            { label: 'WIND', sub: 'kts' },
            { label: 'PRESSURE', sub: 'hPa' },
        ];
        for (const col of cols) {
            const hd = document.createElement('div');
            hd.style.cssText = `
                font-size:9px;font-weight:700;color:rgba(255,255,255,0.35);
                text-transform:uppercase;letter-spacing:0.8px;
                text-align:${col === cols[0] ? 'left' : 'center'};
            `;
            hd.textContent = col.label;
            if (col.sub) {
                const sub = document.createElement('div');
                sub.style.cssText = 'font-size:8px;font-weight:500;color:rgba(255,255,255,0.2);letter-spacing:0;';
                sub.textContent = col.sub;
                hd.appendChild(sub);
            }
            headerRow.appendChild(hd);
        }
        tableWrap.appendChild(headerRow);

        // Data rows (most recent first)
        for (const adv of d.advisories) {
            const row = document.createElement('div');
            row.style.cssText = `
                display:grid;grid-template-columns:1fr 1fr 1fr 1fr;
                gap:0;padding:5px 8px;border-radius:6px;
                margin-bottom:1px;
                ${adv.isLatest ? `background:${d.accentColor}18;` : ''}
            `;

            // Date
            const dateCell = document.createElement('div');
            dateCell.style.cssText = `font-size:11px;font-weight:${adv.isLatest ? '700' : '500'};color:${adv.isLatest ? '#fff' : 'rgba(255,255,255,0.7)'};text-align:left;`;
            dateCell.textContent = adv.date;
            row.appendChild(dateCell);

            // Time
            const timeCell = document.createElement('div');
            timeCell.style.cssText = `font-size:11px;font-weight:${adv.isLatest ? '700' : '500'};color:${adv.isLatest ? '#fff' : 'rgba(255,255,255,0.6)'};text-align:center;`;
            timeCell.textContent = adv.time;
            row.appendChild(timeCell);

            // Wind
            const windCell = document.createElement('div');
            windCell.style.cssText = `font-size:11px;font-weight:700;color:${adv.isLatest ? d.accentColor : 'rgba(255,255,255,0.8)'};text-align:center;`;
            windCell.textContent = adv.windKts != null ? String(adv.windKts) : '—';
            row.appendChild(windCell);

            // Pressure
            const presCell = document.createElement('div');
            presCell.style.cssText = `font-size:11px;font-weight:${adv.isLatest ? '700' : '500'};color:${adv.isLatest ? '#fff' : 'rgba(255,255,255,0.6)'};text-align:center;`;
            presCell.textContent = adv.pressureMb != null ? String(adv.pressureMb) : '—';
            row.appendChild(presCell);

            tableWrap.appendChild(row);
        }

        body.appendChild(tableWrap);
    }

    // ── Footer: Pressure trend + Data age + Next advisory ──
    const footer = document.createElement('div');
    footer.style.cssText = `
        padding:8px 14px 10px;
        border-top:1px solid rgba(255,255,255,0.06);
        display:flex;flex-direction:column;gap:4px;
        background:rgba(0,0,0,0.15);
    `;

    // Pressure trend pill
    const trendRow = document.createElement('div');
    trendRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:2px;';
    const trendArrow = d.pressureTrend === 'deepening' ? '↓' : d.pressureTrend === 'filling' ? '↑' : '→';
    const trendColor =
        d.pressureTrend === 'deepening' ? '#ef4444' : d.pressureTrend === 'filling' ? '#22c55e' : '#94a3b8';
    const trendLabel =
        d.pressureTrend === 'deepening' ? 'Deepening' : d.pressureTrend === 'filling' ? 'Weakening' : 'Steady';

    const trendPill = document.createElement('span');
    trendPill.style.cssText = `
        display:inline-flex;align-items:center;gap:3px;
        font-size:9px;font-weight:700;color:${trendColor};
        background:${trendColor}15;border:1px solid ${trendColor}30;
        padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;
    `;
    trendPill.textContent = `${trendArrow} ${trendLabel}`;
    trendRow.appendChild(trendPill);

    // Development probability pill
    const probColor = d.devProbability === 'HIGH' ? '#ef4444' : d.devProbability === 'MODERATE' ? '#f59e0b' : '#22c55e';
    const probBgColor =
        d.devProbability === 'HIGH' ? '#ef444420' : d.devProbability === 'MODERATE' ? '#f59e0b20' : '#22c55e20';
    const probPill = document.createElement('span');
    probPill.style.cssText = `
        display:inline-flex;align-items:center;gap:3px;
        font-size:9px;font-weight:700;color:${probColor};
        background:${probBgColor};border:1px solid ${probColor}30;
        padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.3px;
    `;
    probPill.textContent = `${d.devProbability} intensification risk`;
    trendRow.appendChild(probPill);

    footer.appendChild(trendRow);

    // Data age row
    const ageRow = document.createElement('div');
    ageRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const ageIcon = document.createElement('span');
    ageIcon.style.cssText = 'font-size:10px;width:14px;text-align:center;';
    ageIcon.textContent = '🕐';
    const ageTime = document.createElement('span');
    ageTime.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.3);';
    ageTime.textContent = d.dataTimeStr;
    const ageVal = document.createElement('span');
    ageVal.style.cssText = 'font-size:9px;font-weight:700;color:#FFA500;margin-left:auto;';
    ageVal.className = 'cyclone-data-age';
    ageVal.dataset.advisoryTime = d.posTime;
    ageVal.textContent = d.dataAgeStr;
    ageRow.appendChild(ageIcon);
    ageRow.appendChild(ageTime);
    ageRow.appendChild(ageVal);
    footer.appendChild(ageRow);

    // Next advisory row
    const advRow = document.createElement('div');
    advRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const advIcon = document.createElement('span');
    advIcon.style.cssText = 'font-size:10px;width:14px;text-align:center;';
    advIcon.textContent = '📡';
    const advLabel = document.createElement('span');
    advLabel.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.3);';
    advLabel.textContent = 'Next advisory';
    const advVal = document.createElement('span');
    advVal.style.cssText = 'font-size:9px;font-weight:700;color:rgba(255,255,255,0.5);margin-left:auto;';
    advVal.className = 'cyclone-next-adv';
    advVal.textContent = d.nextAdvStr;
    advRow.appendChild(advIcon);
    advRow.appendChild(advLabel);
    advRow.appendChild(advVal);
    footer.appendChild(advRow);

    body.appendChild(footer);

    card.appendChild(body);
    wrapper.appendChild(card);
}
