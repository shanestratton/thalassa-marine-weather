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
import {
    fetchActiveCyclones,
    findClosestCyclone,
    fetchGfsTrackerPositions,
    interpolateGfsTracker,
    type ActiveCyclone,
    type CyclonePosition,
    type GfsTrackerPosition,
} from '../../services/weather/CycloneTrackingService';
import { WindStore } from '../../stores/WindStore';
import {
    addSatelliteLayer,
    removeSatelliteLayer,
    bestProductForBasin,
} from '../../services/weather/SatelliteImageryService';

import { createLogger } from '../../utils/createLogger';

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

// ── Storm category labels (module scope) ──
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

// ── Create DOM marker for a cyclone ───────────────────────

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
    const fontSize = Math.round((isMacro ? 12 : 18) * Math.min(zoomFactor, 1.5));

    const pal = categoryPalette(cyclone.category);

    const el = document.createElement('div');
    el.className = 'cyclone-marker';
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 500;
        filter: drop-shadow(0 4px 20px ${pal.glow}80);
        transition: transform 0.3s ease;
    `;

    // Build glow rings — organic blob shapes, more for higher categories
    const glowRings = [];
    const numRings = isMacro ? 1 : Math.min(catScale, 3);
    for (let i = 0; i < numRings; i++) {
        const scale = 1.3 + i * 0.4;
        const opacity = 0.35 - i * 0.1;
        const delay = i * 0.6;
        glowRings.push(`<div style="
            position: absolute; inset: -${4 + i * 6}px;
            border-radius: 40% 60% 55% 45% / 55% 45% 50% 50%;
            background: radial-gradient(ellipse 70% 80%, ${pal.outer}00 30%, ${pal.glow}${Math.round(opacity * 255)
                .toString(16)
                .padStart(2, '0')} 65%, transparent 100%);
            animation: cyclone-morph ${3 + i * 0.7}s ease-in-out ${delay}s infinite alternate,
                       cyclone-pulse ${2 + i * 0.5}s ease-in-out ${delay}s infinite;
            transform: scale(${scale});
        "></div>`);
    }

    el.innerHTML = `
        <div style="
            font-weight: 800;
            color: #fff;
            -webkit-text-stroke: 0.5px rgba(0,0,0,0.8);
            text-shadow: 0 0 3px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,1), 0 0 8px rgba(0,0,0,0.9), 1px 1px 2px rgba(0,0,0,1), -1px -1px 2px rgba(0,0,0,1), 0 0 16px rgba(0,0,0,0.6);
            letter-spacing: 0.5px;
            margin-bottom: 6px;
            text-align: center;
            background: rgba(0,0,0,0.65);
            padding: 4px 14px;
            border-radius: 8px;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            border: 1px solid rgba(0,0,0,0.5);
            line-height: 1.3;
        ">
            <div style="font-size: ${isMacro ? 8 : 10}px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.08em;">${classification}</div>
            <div style="font-size: ${isMacro ? 12 : 15}px;">${resolveStormName(cyclone)}</div>
        </div>
        <div style="
            position: relative;
            width: ${eyeSize}px;
            height: ${eyeSize}px;
            display: flex;
            align-items: center;
            justify-content: center;
        ">

            <div style="
                position: relative; z-index: 2;
                width: ${Math.round(eyeSize * 0.9)}px;
                height: ${Math.round(eyeSize * 0.9)}px;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: cyclone-eye-spin ${Math.max(2, 8 - catScale * 1.2)}s linear infinite;
            ">
                ${
                    cyclone.category >= 1
                        ? `
                <svg viewBox="0 0 100 100" width="${Math.round(eyeSize * 0.85)}" height="${Math.round(eyeSize * 0.85)}">
                    <!-- Filled blade arms — count increases with category -->
                    <g fill="${pal.mid}" stroke="#000" stroke-width="1.5">
                        <!-- Arm 1: top-right -->
                        <path d="M54 42 C58 28, 68 10, 82 8 C90 6, 96 14, 94 24 C92 32, 84 36, 74 34 C68 33, 62 36, 58 42 Z"/>
                        <!-- Arm 2: bottom-left -->
                        <path d="M46 58 C42 72, 32 90, 18 92 C10 94, 4 86, 6 76 C8 68, 16 64, 26 66 C32 67, 38 64, 42 58 Z"/>
                        ${
                            catScale >= 2
                                ? `
                        <!-- Arm 3: right-bottom -->
                        <path d="M58 54 C72 58, 90 68, 92 82 C94 90, 86 96, 76 94 C68 92, 64 84, 66 74 C67 68, 64 62, 58 58 Z"/>
                        <!-- Arm 4: left-top -->
                        <path d="M42 46 C28 42, 10 32, 8 18 C6 10, 14 4, 24 6 C32 8, 36 16, 34 26 C33 32, 36 38, 42 42 Z"/>
                        `
                                : ''
                        }
                        ${
                            catScale >= 4
                                ? `
                        <!-- Arm 5: top-left extra -->
                        <path d="M44 42 C36 32, 22 18, 12 22 C6 24, 4 34, 10 40 C16 44, 26 42, 34 38 C38 36, 42 38, 46 42 Z"/>
                        <!-- Arm 6: bottom-right extra -->
                        <path d="M56 58 C64 68, 78 82, 88 78 C94 76, 96 66, 90 60 C84 56, 74 58, 66 62 C62 64, 58 62, 54 58 Z"/>
                        `
                                : ''
                        }
                    </g>
                    <!-- White eye circle -->
                    <circle cx="50" cy="50" r="16" fill="#fff" stroke="#000" stroke-width="1.5"/>
                    <circle cx="50" cy="50" r="14.5" fill="#fff" stroke="${pal.mid}" stroke-width="1.5"/>
                    <!-- Category number -->
                    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
                          font-size="18" font-weight="900" fill="${pal.mid}"
                          font-family="system-ui, -apple-system, sans-serif">${cyclone.categoryLabel}</text>
                </svg>
                `
                        : `
                <svg viewBox="0 0 100 100" width="${Math.round(eyeSize * 0.85)}" height="${Math.round(eyeSize * 0.85)}">
                    <!-- Tropical Storm: 2 elegant swept tails -->
                    <g fill="${pal.mid}" stroke="#000" stroke-width="1.5">
                        <!-- Upper tail sweeping right -->
                        <path d="M52 38 C56 24, 66 6, 80 4 C88 2, 92 10, 88 18 C82 26, 68 30, 58 34 C54 36, 52 38, 52 40 Z"/>
                        <!-- Lower tail sweeping left -->
                        <path d="M48 62 C44 76, 34 94, 20 96 C12 98, 8 90, 12 82 C18 74, 32 70, 42 66 C46 64, 48 62, 48 60 Z"/>
                    </g>
                    <!-- White eye circle -->
                    <circle cx="50" cy="50" r="18" fill="#fff" stroke="#000" stroke-width="1.5"/>
                    <circle cx="50" cy="50" r="16.5" fill="#fff" stroke="${pal.mid}" stroke-width="1.5"/>
                    <!-- TS label -->
                    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
                          font-size="16" font-weight="900" fill="${pal.mid}"
                          font-family="system-ui, -apple-system, sans-serif">${cyclone.categoryLabel}</text>
                </svg>
                `
                }
            </div>
        </div>
        ${
            showInfoBadge
                ? `<div style="
            font-size: 11px;
            font-weight: 600;
            color: #fff;
            text-shadow: 0 1px 4px rgba(0,0,0,1);
            margin-top: 5px;
            white-space: nowrap;
            background: rgba(0,0,0,0.35);
            padding: 3px 10px;
            border-radius: 8px;
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
        ">${catStr}</div>`
                : ''
        }
    `;

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

            // Project all track points to screen pixels
            const projected = c.track.map((p) => ({
                px: map.project([p.lon, p.lat]),
                point: p,
            }));

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
                const trackColor = windColor(c.currentPosition.windKts);

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
                const fcProjected = forecastAll.map((p) => ({
                    px: map.project([p.lon, p.lat]),
                    point: p,
                }));

                // Project forecast points to screen space
                const rawScreenPts = forecastAll.map((p) => {
                    const px = map.project([p.lon, p.lat]);
                    return [px.x, px.y] as [number, number];
                });

                // Interpolate via catmull-rom for a genuinely smooth curve
                // Raw API gives ~5-7 forecast points — we need ~50+ for smooth rendering
                const smoothScreenPts = catmullRomSpline(rawScreenPts, 12);
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
    const showLabels = zoom >= 7;

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

        if (!showLabels || !point.time) continue;

        // Format forecast time
        const d = new Date(point.time);
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const h = d.getUTCHours();
        const hourStr = h >= 12 ? `${h === 12 ? 12 : h - 12} PM` : `${h === 0 ? 12 : h} AM`;
        const timeLabel = `${dayNames[d.getUTCDay()]} ${hourStr}`;

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

        // Background
        const pillW = 88;
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

    // Build the track centerline from current position through forecast
    const allPoints: [number, number][] = [
        [cyclone.currentPosition.lon, cyclone.currentPosition.lat],
        ...forecast.map((p) => [p.lon, p.lat] as [number, number]),
    ];

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
) {
    // (categoryLabels, categoryColor moved to module scope below)
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasFlown = useRef(false);
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const trackOverlayRef = useRef<ReturnType<typeof createTrackOverlay> | null>(null);
    const cyclonesRef = useRef<ActiveCyclone[]>([]);
    const userLatRef = useRef(userLat);
    const userLonRef = useRef(userLon);
    const onClosestStormRef = useRef(onClosestStorm);
    const selectedStormRef = useRef(selectedStorm ?? null);

    userLatRef.current = userLat;
    userLonRef.current = userLon;
    onClosestStormRef.current = onClosestStorm;
    selectedStormRef.current = selectedStorm ?? null;

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
            removeSatelliteLayer(map);

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

            // HUD overlay
            const hudEl = map.getContainer().querySelector('#cyclone-hud-badges');
            if (hudEl) hudEl.remove();

            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            return;
        }

        injectCycloneCSS();

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

        // Fetch GFS tracker positions on mount — AWAIT before creating markers
        const tcvitalsPromise = fetchGfsTrackerPositions()
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

        // ── Create storm info badge element ──
        const createStormBadge = (cyclone: ActiveCyclone): HTMLDivElement => {
            const wrapper = document.createElement('div');
            const accentColor = categoryColor(cyclone.category);
            const catLabel = categoryLabels[cyclone.categoryLabel] ?? `Cat ${cyclone.categoryLabel}`;
            const stormName = resolveStormName(cyclone);

            // Pressure display
            const pressure = cyclone.minPressureMb ? `${cyclone.minPressureMb} hPa` : '—';
            // Sustained wind
            const sustained = cyclone.maxWindKts > 0 ? `${cyclone.maxWindKts} kts` : '—';
            // Estimated gusts (typically 1.2–1.25× sustained)
            const gustKts = cyclone.maxWindKts > 0 ? Math.round(cyclone.maxWindKts * 1.25) : null;
            const gusts = gustKts ? `~${gustKts} kts` : '—';

            // Position
            const lat = cyclone.currentPosition.lat;
            const lon = cyclone.currentPosition.lon;
            const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
            const lonStr = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

            // Data age
            const posTime = cyclone.currentPosition.time;
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

            // Next advisory (ATCF updates at 00/06/12/18Z, ~3h processing)
            const now = new Date();
            const utcH = now.getUTCHours();
            const advisorySlots = [0, 6, 12, 18];
            // Find the next advisory slot after current hour (+3h for processing)
            let nextAdv = advisorySlots.find((h) => h > utcH) ?? advisorySlots[0] + 24;
            if (nextAdv < utcH) nextAdv += 24;
            const nextAdvDate = new Date(now);
            nextAdvDate.setUTCHours(nextAdv % 24, 0, 0, 0);
            if (nextAdv >= 24) nextAdvDate.setUTCDate(nextAdvDate.getUTCDate() + 1);
            const nextAdvMin = Math.round((nextAdvDate.getTime() - now.getTime()) / 60000);
            const nextAdvStr =
                nextAdvMin < 60 ? `~${nextAdvMin} min` : `~${Math.floor(nextAdvMin / 60)}h ${nextAdvMin % 60}m`;

            // Basin label
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

            const row = (icon: string, label: string, value: string, valueColor = 'rgba(255,255,255,0.9)') =>
                `<div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;width:14px;text-align:center;">${icon}</span>
                    <span style="font-size:10px;color:rgba(255,255,255,0.45);min-width:60px;">${label}</span>
                    <span style="font-size:11px;font-weight:700;color:${valueColor};margin-left:auto;">${value}</span>
                </div>`;

            wrapper.innerHTML = `
                <div style="
                    background: rgba(10, 15, 30, 0.88);
                    backdrop-filter: blur(16px);
                    -webkit-backdrop-filter: blur(16px);
                    border: 1px solid ${accentColor}44;
                    border-left: 3px solid ${accentColor};
                    border-radius: 12px;
                    padding: 10px 14px;
                    color: #ffffff;
                    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
                    min-width: 200px;
                    max-width: 240px;
                    pointer-events: none;
                    z-index: 600;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.6), 0 0 12px ${accentColor}22;
                ">
                    <div style="
                        font-size: 10px;
                        font-weight: 700;
                        letter-spacing: 1px;
                        color: ${accentColor};
                        text-transform: uppercase;
                        margin-bottom: 1px;
                        text-shadow: 0 0 8px ${accentColor}44;
                    ">${catLabel}</div>
                    <div style="
                        font-size: 18px;
                        font-weight: 800;
                        color: #ffffff;
                        margin-bottom: 2px;
                        text-transform: capitalize;
                        line-height: 1.2;
                    ">${stormName}</div>
                    <div style="
                        font-size: 9px;
                        color: rgba(255,255,255,0.35);
                        margin-bottom: 8px;
                    ">${basinStr} · ${cyclone.sid}</div>

                    <div style="display:flex;flex-direction:column;gap:4px;">
                        ${row('⬇', 'Pressure', pressure, accentColor)}
                        ${row('💨', 'Sustained', sustained, '#ffffff')}
                        ${row('🌪️', 'Gusts (est)', gusts, gustKts && gustKts >= 64 ? '#ef4444' : '#ffffff')}
                        ${row('📍', 'Position', `${latStr}  ${lonStr}`, 'rgba(255,255,255,0.7)')}
                    </div>

                    <div style="
                        margin-top: 8px;
                        padding-top: 6px;
                        border-top: 1px solid rgba(255,255,255,0.06);
                        display: flex;
                        flex-direction: column;
                        gap: 3px;
                    ">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="font-size:11px;width:14px;text-align:center;">🕐</span>
                            <span style="font-size:9px;color:rgba(255,255,255,0.35);">${dataTimeStr}</span>
                            <span style="font-size:9px;font-weight:700;color:#FFA500;margin-left:auto;">${dataAgeStr}</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span style="font-size:11px;width:14px;text-align:center;">📡</span>
                            <span style="font-size:9px;color:rgba(255,255,255,0.35);">Next advisory</span>
                            <span style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.55);margin-left:auto;">${nextAdvStr}</span>
                        </div>
                    </div>
                </div>
            `;
            return wrapper;
        };

        // ── Rebuild markers — HUD badge + geo-anchored storm eye markers ──
        const HUD_CONTAINER_ID = 'cyclone-hud-badges';
        let focusedStorm: ActiveCyclone | null = null;
        const rebuildMarkers = () => {
            // Remove old HUD
            const old = map.getContainer().querySelector(`#${HUD_CONTAINER_ID}`);
            if (old) old.remove();

            // Also clean up any old geo-anchored markers
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

                if (gfsTrackRef.current && gfsTrackRef.current.size > 0) {
                    const gfsPos = interpolateGfsTracker(
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
                const marker = new mapboxgl.Marker({ element: markerEl, anchor: 'center' })
                    .setLngLat([eyeLon, eyeLat])
                    .addTo(map);
                markersRef.current.push(marker);
            }

            // ── HUD badge for focused storm ──
            if (!focusedStorm) return;

            // Create fixed-position HUD container in top-left of map
            const hud = document.createElement('div');
            hud.id = HUD_CONTAINER_ID;
            hud.style.cssText = `
                position: absolute;
                top: 56px;
                left: 16px;
                z-index: 600;
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
            `;

            const badge = createStormBadge(focusedStorm);
            hud.appendChild(badge);

            map.getContainer().appendChild(hud);
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
            log.info('[CYCLONE] 🌀 Fetching active cyclones (for discovery only)...');
            try {
                const cyclones = await fetchActiveCyclones();
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
                    const trackCoords: [number, number][] = c.track.map((p) => [p.lon, p.lat] as [number, number]);

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

                // ── Render Mapbox GL probability polygon (geographic cone) ──
                for (const c of cyclones) {
                    addProbabilitySleeve(map, c);
                }

                // ── DOT POSITIONED AT ATCF SATELLITE-ANALYZED POSITION ──
                // The ATCF position is determined by JTWC/NHC from actual satellite imagery
                // analysis (Dvorak technique). This IS the most accurate eye position available.
                // No GRIB scanning needed — the marker was already placed at the correct
                // lat/lon from the tcvitals T+0 or API position above.
                log.info(`[CYCLONE] 🔴 Using ATCF satellite-analyzed positions for ${cyclones.length} storm(s)`);

                // Find & report closest storm — but ONLY update if user hasn't manually selected
                const closest = findClosestCyclone(cyclones, userLatRef.current, userLonRef.current);
                if (!skipAutoFlyRef?.current) {
                    // No manual selection — use geo-closest
                    onClosestStormRef.current?.(closest);
                }

                // ── Render storm info badge for focused storm ──
                // Use user-selected storm if available, otherwise closest
                focusedStorm = selectedStormRef.current ?? closest;
                rebuildMarkers();

                // ── Satellite IR overlay — all 4 NOAA/SSEC geostationary satellites ──
                // Uses RealEarth SSEC/CIMSS XYZ tile API (free, CORS-enabled, no API key)
                // Auto-selects the best satellite for the storm's basin:
                //   Global IR composite | GOES-East (Americas) | GOES-West (Pacific) | Meteosat (Europe/Africa/IO)
                const satProduct = closest ? bestProductForBasin(closest.basin) : 'global-ir';
                addSatelliteLayer(map, satProduct);
                log.info(`[CYCLONE] 🛰️ Satellite IR overlay activated: ${satProduct}`);

                // ── Black country borders above satellite (50m Natural Earth) ──
                const BORDER_ID = 'storm-black-borders';
                if (!map.getSource(BORDER_ID)) {
                    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json')
                        .then((r) => r.json())
                        .then((topology) => {
                            if (map.getSource(BORDER_ID)) return;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const topo = topology as any;
                            const { scale, translate } = topo.transform;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const arcs: number[][][] = topo.arcs.map((arc: number[][]) => {
                                let x = 0,
                                    y = 0;
                                return arc.map(([dx, dy]: number[]) => {
                                    x += dx;
                                    y += dy;
                                    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
                                });
                            });

                            // Resolve arc references to coordinates
                            const resolveRing = (indices: number[]): number[][] => {
                                const coords: number[][] = [];
                                for (const idx of indices) {
                                    const arc = idx >= 0 ? arcs[idx] : arcs[~idx].slice().reverse();
                                    coords.push(...(coords.length > 0 ? arc.slice(1) : arc));
                                }
                                return coords;
                            };

                            // Convert each country geometry to GeoJSON polygons
                            const obj = topo.objects.countries;
                            const features: GeoJSON.Feature[] = [];
                            for (const geom of obj.geometries) {
                                if (geom.type === 'Polygon') {
                                    features.push({
                                        type: 'Feature',
                                        properties: {},
                                        geometry: {
                                            type: 'Polygon',
                                            coordinates: geom.arcs.map(resolveRing),
                                        },
                                    });
                                } else if (geom.type === 'MultiPolygon') {
                                    features.push({
                                        type: 'Feature',
                                        properties: {},
                                        geometry: {
                                            type: 'MultiPolygon',
                                            coordinates: geom.arcs.map(
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                (polygon: any) => polygon.map(resolveRing),
                                            ),
                                        },
                                    });
                                }
                            }

                            map.addSource(BORDER_ID, {
                                type: 'geojson',
                                data: { type: 'FeatureCollection', features },
                            });
                            map.addLayer({
                                id: BORDER_ID,
                                type: 'line',
                                source: BORDER_ID,
                                paint: {
                                    'line-color': '#000000',
                                    'line-width': 1.5,
                                    'line-opacity': 0.8,
                                },
                                layout: {
                                    'line-join': 'round',
                                    'line-cap': 'round',
                                },
                            });
                            log.info('[CYCLONE] 🗺️ Added 50m black country borders');
                        })
                        .catch((err) => log.warn('[CYCLONE] Failed to load borders:', err));
                }

                log.info('[CYCLONE] 🛰️ Activated Himawari-9 IR + black borders for storm view');

                // Fly to closest storm on first load (unless user manually selected a storm)
                if (closest && !hasFlown.current) {
                    hasFlown.current = true;
                    // If handleSelectStorm already initiated a flyTo, skip the auto-fly
                    if (skipAutoFlyRef?.current) {
                        skipAutoFlyRef.current = false;
                        log.info(`[CYCLONE] ✈️ Skipping auto-fly (user selected a storm manually)`);
                    } else {
                        // Fly to tcvitals position if available
                        let flyLat = closest.currentPosition.lat;
                        let flyLon = closest.currentPosition.lon;
                        if (gfsTrackRef.current && gfsTrackRef.current.size > 0) {
                            const gfsPos = interpolateGfsTracker(
                                gfsTrackRef.current,
                                closest.sid,
                                0,
                                closest.name,
                                closest.currentPosition.lat,
                                closest.currentPosition.lon,
                            );
                            if (gfsPos) {
                                flyLat = gfsPos.lat;
                                flyLon = gfsPos.lon;
                            }
                        }
                        log.info(
                            `[CYCLONE] ✈️ Flying to ${closest.name} at ${flyLat.toFixed(1)}, ${flyLon.toFixed(1)}`,
                        );
                        map.flyTo({
                            center: [flyLon, flyLat],
                            zoom: 5,
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

        return () => {
            unsubWind?.();
            cancelled = true;
            map.off('zoomend', onZoomEnd);
            // Clean up HUD
            const hudEl = map.getContainer().querySelector(`#${HUD_CONTAINER_ID}`);
            if (hudEl) hudEl.remove();
            removeSatelliteLayer(map);
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            cyclonesRef.current = [];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);

    // ── Rebuild HUD when selected storm changes ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !visible || !selectedStorm) return;

        const HUD_CONTAINER_ID = 'cyclone-hud-badges';
        const old = map.getContainer().querySelector(`#${HUD_CONTAINER_ID}`);
        if (old) old.remove();

        const hud = document.createElement('div');
        hud.id = HUD_CONTAINER_ID;
        hud.style.cssText = `
            position: absolute;
            top: 56px;
            left: 16px;
            z-index: 600;
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;
        `;

        const badge = createStormBadgeStatic(selectedStorm);
        hud.appendChild(badge);
        map.getContainer().appendChild(hud);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedStorm?.sid, visible, mapReady]);
}

// ── Static badge builder (accessible outside the main effect closure) ──
function createStormBadgeStatic(cyclone: ActiveCyclone): HTMLDivElement {
    const wrapper = document.createElement('div');
    const accentColor = categoryColor(cyclone.category);
    const catLabel = categoryLabels[cyclone.categoryLabel] ?? `Cat ${cyclone.categoryLabel}`;
    const stormName = resolveStormName(cyclone);

    const pressure = cyclone.minPressureMb ? `${cyclone.minPressureMb} hPa` : '—';
    const sustained = cyclone.maxWindKts > 0 ? `${cyclone.maxWindKts} kts` : '—';
    const gustKts = cyclone.maxWindKts > 0 ? Math.round(cyclone.maxWindKts * 1.25) : null;
    const gusts = gustKts ? `~${gustKts} kts` : '—';

    const lat = cyclone.currentPosition.lat;
    const lon = cyclone.currentPosition.lon;
    const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

    const posTime = cyclone.currentPosition.time;
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

    const row = (icon: string, label: string, value: string, valueColor = 'rgba(255,255,255,0.9)') =>
        `<div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;width:14px;text-align:center;">${icon}</span>
            <span style="font-size:10px;color:rgba(255,255,255,0.45);min-width:60px;">${label}</span>
            <span style="font-size:11px;font-weight:700;color:${valueColor};margin-left:auto;">${value}</span>
        </div>`;

    wrapper.innerHTML = `
        <div style="
            background: rgba(10, 15, 30, 0.88);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid ${accentColor}44;
            border-left: 3px solid ${accentColor};
            border-radius: 12px;
            padding: 10px 14px;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
            min-width: 200px;
            max-width: 240px;
            pointer-events: none;
            z-index: 600;
            box-shadow: 0 4px 24px rgba(0,0,0,0.6), 0 0 12px ${accentColor}22;
        ">
            <div style="
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 1px;
                color: ${accentColor};
                text-transform: uppercase;
                margin-bottom: 1px;
                text-shadow: 0 0 8px ${accentColor}44;
            ">${catLabel}</div>
            <div style="
                font-size: 18px;
                font-weight: 800;
                color: #ffffff;
                margin-bottom: 2px;
                text-transform: capitalize;
                line-height: 1.2;
            ">${stormName}</div>
            <div style="
                font-size: 9px;
                color: rgba(255,255,255,0.35);
                margin-bottom: 8px;
            ">${basinStr} · ${cyclone.sid}</div>

            <div style="display:flex;flex-direction:column;gap:4px;">
                ${row('⬇', 'Pressure', pressure, accentColor)}
                ${row('💨', 'Sustained', sustained, '#ffffff')}
                ${row('🌪️', 'Gusts (est)', gusts, gustKts && gustKts >= 64 ? '#ef4444' : '#ffffff')}
                ${row('📍', 'Position', `${latStr}  ${lonStr}`, 'rgba(255,255,255,0.7)')}
            </div>

            <div style="
                margin-top: 8px;
                padding-top: 6px;
                border-top: 1px solid rgba(255,255,255,0.06);
                display: flex;
                flex-direction: column;
                gap: 3px;
            ">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;width:14px;text-align:center;">🕐</span>
                    <span style="font-size:9px;color:rgba(255,255,255,0.35);">${dataTimeStr}</span>
                    <span style="font-size:9px;font-weight:700;color:#FFA500;margin-left:auto;">${dataAgeStr}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;width:14px;text-align:center;">📡</span>
                    <span style="font-size:9px;color:rgba(255,255,255,0.35);">Next advisory</span>
                    <span style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.55);margin-left:auto;">${nextAdvStr}</span>
                </div>
            </div>
        </div>
    `;
    return wrapper;
}
