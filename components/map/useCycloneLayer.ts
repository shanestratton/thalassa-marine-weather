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

    // Australian & South Pacific → Tropical Cyclone (BOM scale)
    // BOM: Cat 1-2 = Tropical Cyclone, Cat 3-5 = Severe Tropical Cyclone
    if (['P', 'AU', 'SP'].includes(b)) {
        if (windKts >= 86) return 'Severe Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Cyclone';
        return 'Tropical Depression';
    }

    // South Indian Ocean → same BOM-style classification
    if (['S', 'SI'].includes(b)) {
        if (windKts >= 86) return 'Severe Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Cyclone';
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
            text-shadow: 0 1px 6px rgba(0,0,0,1), 0 0 12px rgba(0,0,0,0.8);
            letter-spacing: 0.5px;
            margin-bottom: 6px;
            text-align: center;
            background: rgba(0,0,0,0.35);
            padding: 3px 12px;
            border-radius: 8px;
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            line-height: 1.3;
        ">
            <div style="font-size: ${isMacro ? 8 : 10}px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.08em;">${classification}</div>
            <div style="font-size: ${isMacro ? 12 : 15}px;">${cyclone.name}</div>
        </div>
        <div style="
            position: relative;
            width: ${eyeSize}px;
            height: ${eyeSize}px;
            display: flex;
            align-items: center;
            justify-content: center;
        ">
            ${glowRings.join('')}
            <div style="
                position: absolute; inset: -2px;
                border-radius: 45% 55% 50% 50% / 50% 45% 55% 50%;
                background: radial-gradient(ellipse 60% 75%,
                    ${pal.core} 0%,
                    ${pal.mid} 25%,
                    ${pal.outer} 50%,
                    ${pal.accent} 70%,
                    transparent 100%);
                animation: cyclone-blob ${6 - catScale * 0.5}s ease-in-out infinite alternate,
                           cyclone-spin ${8 - catScale * 0.8}s linear infinite;
                opacity: 0.9;
            "></div>
            <div style="
                position: relative; z-index: 2;
                font-size: ${fontSize}px;
                font-weight: 900;
                color: #fff;
                text-shadow:
                    0 0 6px ${pal.core},
                    0 0 14px ${pal.outer},
                    0 0 28px ${pal.glow};
                letter-spacing: 1px;
            ">${cyclone.categoryLabel}</div>
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

            // Draw intensity-colored segments between consecutive points
            for (let i = 0; i < projected.length - 1; i++) {
                const from = projected[i];
                const to = projected[i + 1];
                const segColor = windColor(from.point.windKts);

                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', String(from.px.x));
                line.setAttribute('y1', String(from.px.y));
                line.setAttribute('x2', String(to.px.x));
                line.setAttribute('y2', String(to.px.y));
                line.setAttribute('stroke', segColor);
                line.setAttribute('stroke-width', String(lineWidth));
                line.setAttribute('stroke-dasharray', isMacro ? '6,4' : '10,6');
                line.setAttribute('stroke-opacity', '0.85');
                line.setAttribute('stroke-linecap', 'round');
                svg.appendChild(line);
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
                const rawScreenPts = forecastAll.map(p => {
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

                        const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
                        const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
                        const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
                        const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

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
    const labelEvery = zoom >= 9 ? 1 : 2; // Every point at high zoom, every 2nd otherwise

    for (let i = 0; i < projected.length; i++) {
        const { px, point } = projected[i];
        const dotColor = windColor(point.windKts);
        const cat = point.windKts ? windToSS(point.windKts) : 0;

        // Outer glow
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        glow.setAttribute('cx', String(px.x));
        glow.setAttribute('cy', String(px.y));
        glow.setAttribute('r', '6');
        glow.setAttribute('fill', dotColor);
        glow.setAttribute('opacity', '0.3');
        svg.appendChild(glow);

        // Inner dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', cat >= 1 ? '5' : '3');
        dot.setAttribute('fill', dotColor);
        dot.setAttribute('stroke', 'rgba(0,0,0,0.7)');
        dot.setAttribute('stroke-width', '1.5');
        svg.appendChild(dot);

        // Category number inside larger dots
        if (cat >= 1) {
            const catText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            catText.setAttribute('x', String(px.x));
            catText.setAttribute('y', String(px.y + 3));
            catText.setAttribute('fill', '#fff');
            catText.setAttribute('font-size', '7');
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
function catmullRomSpline(
    points: [number, number][],
    segments: number = 8,
    _alpha: number = 0.5,
): [number, number][] {
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
function addProbabilitySleeve(
    map: mapboxgl.Map,
    cyclone: ActiveCyclone,
): void {
    const forecast = cyclone.forecastTrack;
    if (!forecast || forecast.length < 2) return;

    // Build the track centerline from current position through forecast
    const allPoints: [number, number][] = [
        [cyclone.currentPosition.lon, cyclone.currentPosition.lat],
        ...forecast.map(p => [p.lon, p.lat] as [number, number]),
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

    log.info(`[CYCLONE] 🌀 Probability sleeve rendered for ${cyclone.name} (${smoothTrack.length} smooth points, ${totalHours.toFixed(0)}h window)`);
}

// ── Hook ──────────────────────────────────────────────────

export function useCycloneLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    userLat: number,
    userLon: number,
    onClosestStorm?: (storm: ActiveCyclone | null) => void,
) {
    const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const hasFlown = useRef(false);
    const markersRef = useRef<mapboxgl.Marker[]>([]);
    const trackOverlayRef = useRef<ReturnType<typeof createTrackOverlay> | null>(null);
    const cyclonesRef = useRef<ActiveCyclone[]>([]);
    const userLatRef = useRef(userLat);
    const userLonRef = useRef(userLon);
    const onClosestStormRef = useRef(onClosestStorm);

    userLatRef.current = userLat;
    userLonRef.current = userLon;
    onClosestStormRef.current = onClosestStorm;

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
        const tcvitalsPromise = fetchGfsTrackerPositions().then((trackMap) => {
            gfsTrackRef.current = trackMap;
            log.info(`[CYCLONE] 🎯 TCVitals loaded: ${trackMap.size} storm(s)`);
            for (const [sid, positions] of trackMap) {
                const p = positions[0];
                log.info(`[CYCLONE] 🎯 ${sid}: ${p.lat.toFixed(1)}, ${p.lon.toFixed(1)} (vmax=${p.vmax}kt)`);
            }
            return trackMap;
        }).catch((e) => {
            log.warn('[CYCLONE] TCVitals fetch failed', e);
            return new Map<string, GfsTrackerPosition[]>();
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unsubWind = WindStore.subscribe((_state: any) => {
            // Pressure-based positioning is the source of truth.
            // No wind-based re-scanning needed — pressure minimum is stable.
        });

        // ── Storm category labels ──
        const categoryLabels: Record<string, string> = {
            'TD': 'Tropical Depression',
            'TS': 'Tropical Storm',
            '1': 'Category 1 Cyclone',
            '2': 'Category 2 Cyclone',
            '3': 'Category 3 Cyclone',
            '4': 'Category 4 Cyclone',
            '5': 'Category 5 Cyclone',
        };

        // ── Category-based badge color ──
        const categoryColor = (cat: number): string => {
            if (cat >= 5) return '#ff0040';    // Cat 5: hot red
            if (cat >= 4) return '#ff4400';    // Cat 4: red-orange
            if (cat >= 3) return '#ff8800';    // Cat 3: orange
            if (cat >= 2) return '#ffcc00';    // Cat 2: gold
            if (cat >= 1) return '#00e5ff';    // Cat 1: cyan
            return '#00bcd4';                  // TS/TD: teal
        };

        // ── Resolve truncated ATCF names ──
        // ATCF format caps storm names at 10 chars (e.g. TWENTYEIGH → TWENTY-EIGHT)
        // Extract the number from the SID (e.g. "28P") and map to the full name
        const numberNames: Record<number, string> = {
            1:'One',2:'Two',3:'Three',4:'Four',5:'Five',6:'Six',7:'Seven',8:'Eight',
            9:'Nine',10:'Ten',11:'Eleven',12:'Twelve',13:'Thirteen',14:'Fourteen',
            15:'Fifteen',16:'Sixteen',17:'Seventeen',18:'Eighteen',19:'Nineteen',
            20:'Twenty',21:'Twenty-One',22:'Twenty-Two',23:'Twenty-Three',
            24:'Twenty-Four',25:'Twenty-Five',26:'Twenty-Six',27:'Twenty-Seven',
            28:'Twenty-Eight',29:'Twenty-Nine',30:'Thirty',31:'Thirty-One',
            32:'Thirty-Two',33:'Thirty-Three',34:'Thirty-Four',35:'Thirty-Five',
        };

        const resolveStormName = (cyclone: ActiveCyclone): string => {
            const raw = cyclone.name.toUpperCase().replace(/[^A-Z]/g, '');
            // Find the LONGEST matching number name to avoid "TWENTY" matching before "TWENTYEIGHT"
            let bestMatch = '';
            let bestLen = 0;
            for (const [, fullName] of Object.entries(numberNames)) {
                const stripped = fullName.replace(/-/g, '').toUpperCase();
                // ATCF truncates at 10 chars: "TWENTYEIGHT" → "TWENTYEIGH"
                if (stripped.startsWith(raw) || raw.startsWith(stripped)) {
                    // Use the match length (overlap) to pick the best
                    const overlap = Math.min(stripped.length, raw.length);
                    if (overlap > bestLen) {
                        bestLen = overlap;
                        bestMatch = fullName;
                    }
                }
            }
            if (bestMatch) return bestMatch;
            // Proper named storm — title case
            return cyclone.name.charAt(0).toUpperCase() + cyclone.name.slice(1).toLowerCase();
        };

        // ── Create storm info badge element ──
        const createStormBadge = (cyclone: ActiveCyclone): HTMLDivElement => {
            const wrapper = document.createElement('div');
            const accentColor = categoryColor(cyclone.category);
            const catLabel = categoryLabels[cyclone.categoryLabel] ?? `Cat ${cyclone.categoryLabel}`;
            const stormName = resolveStormName(cyclone);

            // Pressure display
            const pressure = cyclone.minPressureMb
                ? `${cyclone.minPressureMb} hPa`
                : '—';
            // Wind display
            const wind = cyclone.maxWindKts > 0
                ? `${cyclone.maxWindKts} kts`
                : '—';

            wrapper.innerHTML = `
                <div style="
                    background: rgba(10, 15, 30, 0.82);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    border: 1px solid ${accentColor}44;
                    border-radius: 10px;
                    padding: 8px 12px;
                    color: #ffffff;
                    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif;
                    min-width: 160px;
                    pointer-events: none;
                    z-index: 600;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.5), 0 0 12px ${accentColor}33;
                ">
                    <div style="
                        font-size: 13px;
                        font-weight: 700;
                        letter-spacing: 0.3px;
                        color: ${accentColor};
                        margin-bottom: 2px;
                        text-shadow: 0 0 8px ${accentColor}66;
                    ">${catLabel}</div>
                    <div style="
                        font-size: 16px;
                        font-weight: 800;
                        color: #ffffff;
                        margin-bottom: 6px;
                        text-transform: capitalize;
                    ">${stormName}</div>
                    <div style="
                        display: flex;
                        gap: 12px;
                        font-size: 11px;
                        color: rgba(255,255,255,0.8);
                    ">
                        <div style="display: flex; align-items: center; gap: 3px;">
                            <span style="color: ${accentColor}; font-size: 13px;">⬇</span>
                            <span>${pressure}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 3px;">
                            <span style="color: ${accentColor}; font-size: 13px;">💨</span>
                            <span>${wind}</span>
                        </div>
                    </div>
                </div>
            `;
            return wrapper;
        };

        // ── Rebuild markers — storm info badge at each cyclone position ──
        const rebuildMarkers = () => {
            // Remove old markers
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];

            const cyclones = cyclonesRef.current;
            if (!cyclones.length) return;

            for (const c of cyclones) {
                // Resolve position: prefer GFS tracker, fall back to ATCF
                let lat = c.currentPosition.lat;
                let lon = c.currentPosition.lon;
                if (gfsTrackRef.current && gfsTrackRef.current.size > 0) {
                    const gfsPos = interpolateGfsTracker(
                        gfsTrackRef.current, c.sid, 0,
                        c.name, c.currentPosition.lat, c.currentPosition.lon,
                    );
                    if (gfsPos) { lat = gfsPos.lat; lon = gfsPos.lon; }
                }

                const el = createStormBadge(c);
                const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, -40] })
                    .setLngLat([lon, lat])
                    .addTo(map);
                markersRef.current.push(marker);
            }
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

                // ── Render Mapbox GL probability polygon (geographic cone) ──
                for (const c of cyclones) {
                    addProbabilitySleeve(map, c);
                }

                // ── DOT POSITIONED AT ATCF SATELLITE-ANALYZED POSITION ──
                // The ATCF position is determined by JTWC/NHC from actual satellite imagery
                // analysis (Dvorak technique). This IS the most accurate eye position available.
                // No GRIB scanning needed — the marker was already placed at the correct
                // lat/lon from the tcvitals T+0 or API position above.
                log.info(
                    `[CYCLONE] 🔴 Using ATCF satellite-analyzed positions for ${cyclones.length} storm(s)`,
                );

                // ── Render storm info badges ──
                rebuildMarkers();

                // Find & report closest storm
                const closest = findClosestCyclone(cyclones, userLatRef.current, userLonRef.current);
                onClosestStormRef.current?.(closest);

                // ── Activate Himawari-9 IR satellite overlay for storm view ──
                const IR_ID = 'himawari-ir-satellite';
                if (!map.getSource(IR_ID)) {
                    try {
                        const supabaseUrl =
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (globalThis as any).__SUPABASE_URL__ ||
                            'https://pcisdplnodrphauixcau.supabase.co';
                        const irUrl = `${supabaseUrl}/functions/v1/satellite-tile?z={z}&y={y}&x={x}`;

                        map.addSource(IR_ID, {
                            type: 'raster',
                            tiles: [irUrl],
                            tileSize: 256,
                            maxzoom: 6,
                            attribution: 'NASA GIBS Himawari-9 IR',
                        });
                        // Add IR layer above Esri satellite but below borders/labels
                        const styleLayers = map.getStyle()?.layers ?? [];
                        const firstSymbolId = styleLayers.find((l) => l.type === 'symbol')?.id;
                        map.addLayer(
                            {
                                id: IR_ID,
                                type: 'raster',
                                source: IR_ID,
                                paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 300 },
                            },
                            firstSymbolId,
                        );

                        // ── Black country borders above satellite (50m Natural Earth) ──
                        const BORDER_ID = 'storm-black-borders';
                        if (!map.getSource(BORDER_ID)) {
                            fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json')
                                .then(r => r.json())
                                .then(topology => {
                                    if (map.getSource(BORDER_ID)) return;
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const topo = topology as any;
                                    const { scale, translate } = topo.transform;
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const arcs: number[][][] = topo.arcs.map((arc: number[][]) => {
                                        let x = 0, y = 0;
                                        return arc.map(([dx, dy]: number[]) => {
                                            x += dx; y += dy;
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
                                .catch(err => log.warn('[CYCLONE] Failed to load borders:', err));
                        }

                        log.info('[CYCLONE] 🛰️ Activated Himawari-9 IR satellite + black borders for storm view');
                    } catch (err) {
                        log.warn('[CYCLONE] Failed to add IR satellite layer:', err);
                    }
                }

                // Fly to closest storm on first load
                if (closest && !hasFlown.current) {
                    hasFlown.current = true;
                    // Fly to tcvitals position if available
                    let flyLat = closest.currentPosition.lat;
                    let flyLon = closest.currentPosition.lon;
                    if (gfsTrackRef.current && gfsTrackRef.current.size > 0) {
                        const gfsPos = interpolateGfsTracker(
                            gfsTrackRef.current, closest.sid, 0,
                            closest.name, closest.currentPosition.lat, closest.currentPosition.lon,
                        );
                        if (gfsPos) { flyLat = gfsPos.lat; flyLon = gfsPos.lon; }
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
}

