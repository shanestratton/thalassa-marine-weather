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
    type ActiveCyclone,
    type CyclonePosition,
} from '../../services/weather/CycloneTrackingService';

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

    // Australian & South Pacific → Tropical Cyclone
    if (['P', 'AU', 'SP'].includes(b)) {
        if (windKts >= 64) return 'Severe Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Cyclone';
        return 'Tropical Depression';
    }

    // South Indian Ocean → Tropical Cyclone (same terminology)
    if (['S', 'SI'].includes(b)) {
        if (windKts >= 64) return 'Severe Tropical Cyclone';
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
    if (windKts >= 64) return 'Severe Tropical Cyclone';
    if (windKts >= 34) return 'Tropical Storm';
    return 'Tropical Depression';
}

// ── Create DOM marker for a cyclone ───────────────────────

function createStormMarkerEl(cyclone: ActiveCyclone, zoom: number): HTMLElement {
    const color = categoryColor(cyclone.category);
    const { windKts, pressureMb } = cyclone.currentPosition;
    const classification = stormClassification(cyclone.basin, windKts ?? cyclone.maxWindKts);

    const catStr =
        cyclone.category > 0
            ? `Cat ${cyclone.categoryLabel} · ${windKts ?? '?'} kts${pressureMb ? ` · ${pressureMb} hPa` : ''}`
            : `${cyclone.categoryLabel} · ${windKts ?? '?'} kts`;

    // Semantic zoom: scale marker elements
    const isMacro = zoom < 5;
    const isRegional = zoom >= 5 && zoom <= 8;
    const showInfoBadge = !isMacro;

    // Heatmap eye sizing scales with category + zoom
    const catScale = Math.min(cyclone.category, 5) || 1;
    const baseEye = isMacro ? 36 : isRegional ? 56 : 68;
    const eyeSize = baseEye + catScale * 4;
    const fontSize = isMacro ? 14 : isRegional ? 20 : 24;

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
        overflow: hidden;
    `;
    container.appendChild(div);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'width: 100%; height: 100%;';
    div.appendChild(svg);

    let storedCyclones: ActiveCyclone[] = [];

    const redraw = () => {
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        const rect = container.getBoundingClientRect();
        svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

        const zoom = map.getZoom();
        const isMacro = zoom < 5;
        const isMicro = zoom > 8;
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

            // At high zoom, add dots at each track data point
            if (isMicro) {
                drawTrackDots(svg, projected);
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

/** Draw forecast-style labels along the track at zoom > 8 */
function drawTrackDots(svg: SVGSVGElement, projected: { px: mapboxgl.Point; point: CyclonePosition }[]) {
    const now = Date.now();

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

        // Show labels only every 2nd point to prevent clutter (or every point at very high zoom)
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

/** Quick Saffir-Simpson category from wind speed */
function windToSS(kts: number): number {
    if (kts >= 137) return 5;
    if (kts >= 113) return 4;
    if (kts >= 96) return 3;
    if (kts >= 83) return 2;
    if (kts >= 64) return 1;
    return 0;
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

        if (!trackOverlayRef.current) {
            trackOverlayRef.current = createTrackOverlay(map);
        }

        // ── Semantic zoom: rebuild markers when zoom crosses a threshold ──
        const rebuildMarkers = () => {
            const cyclones = cyclonesRef.current;
            if (cyclones.length === 0) return;
            const currentZoom = map.getZoom();

            for (const m of markersRef.current) m.remove();
            markersRef.current = [];

            for (const c of cyclones) {
                const el = createStormMarkerEl(c, currentZoom);
                const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([c.currentPosition.lon, c.currentPosition.lat])
                    .addTo(map);
                markersRef.current.push(marker);
            }
        };

        // Track which zoom band we're in to avoid unnecessary rebuilds
        let lastZoomBand = -1;
        const getZoomBand = (z: number) => (z < 5 ? 0 : z <= 8 ? 1 : 2);

        const onZoomEnd = () => {
            const band = getZoomBand(map.getZoom());
            if (band !== lastZoomBand) {
                lastZoomBand = band;
                rebuildMarkers();
            }
        };
        map.on('zoomend', onZoomEnd);

        // Fetch and render
        let cancelled = false;

        const loadCyclones = async () => {
            console.info('[CYCLONE] 🌀 Fetching active cyclones...');
            try {
                const cyclones = await fetchActiveCyclones();
                if (cancelled) return;

                console.info(`[CYCLONE] Got ${cyclones.length} active cyclone(s)`);

                if (cyclones.length === 0) {
                    onClosestStormRef.current?.(null);
                    return;
                }

                cyclonesRef.current = cyclones;
                lastZoomBand = getZoomBand(map.getZoom());

                // Update track SVG overlay
                trackOverlayRef.current?.update(cyclones);

                // Create DOM markers
                for (const m of markersRef.current) m.remove();
                markersRef.current = [];

                const currentZoom = map.getZoom();
                for (const c of cyclones) {
                    const el = createStormMarkerEl(c, currentZoom);
                    const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                        .setLngLat([c.currentPosition.lon, c.currentPosition.lat])
                        .addTo(map);
                    markersRef.current.push(marker);
                }

                // Find & report closest storm
                const closest = findClosestCyclone(cyclones, userLatRef.current, userLonRef.current);
                onClosestStormRef.current?.(closest);

                // Fly to closest storm on first load
                if (closest && !hasFlown.current) {
                    hasFlown.current = true;
                    const { lat, lon } = closest.currentPosition;
                    console.info(
                        `[CYCLONE] ✈️ Flying to ${closest.name} (Cat ${closest.categoryLabel}) at ${lat.toFixed(1)}, ${lon.toFixed(1)}`,
                    );
                    map.flyTo({
                        center: [lon, lat],
                        zoom: 5,
                        duration: 2000,
                        essential: true,
                    });
                }
            } catch (e) {
                console.error('[CYCLONE] ❌ Error loading cyclones:', e);
            }
        };

        loadCyclones();
        refreshTimer.current = setInterval(loadCyclones, 30 * 60 * 1000);

        return () => {
            cancelled = true;
            map.off('zoomend', onZoomEnd);
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            trackOverlayRef.current?.remove();
            trackOverlayRef.current = null;
            cyclonesRef.current = [];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);
}
