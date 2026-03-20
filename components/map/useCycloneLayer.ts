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

function categoryColor(cat: number): string {
    switch (cat) {
        case 5:
            return '#9333ea';
        case 4:
            return '#dc2626';
        case 3:
            return '#ea580c';
        case 2:
            return '#d97706';
        case 1:
            return '#eab308';
        default:
            return '#06b6d4';
    }
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
    const eyeSize = isMacro ? 32 : isRegional ? 44 : 52;
    const innerSize = isMacro ? 24 : isRegional ? 34 : 40;
    const fontSize = isMacro ? 13 : isRegional ? 16 : 18;
    const showPulse = !isMacro;
    const showInfoBadge = !isMacro;

    const el = document.createElement('div');
    el.className = 'cyclone-marker';
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 500;
        filter: drop-shadow(0 2px 12px rgba(0,0,0,0.8));
        transition: transform 0.3s ease;
    `;

    el.innerHTML = `
        <div style="
            font-weight: 800;
            color: #fff;
            text-shadow: 0 1px 6px rgba(0,0,0,1), 0 0 12px rgba(0,0,0,0.8);
            letter-spacing: 0.5px;
            margin-bottom: 4px;
            text-align: center;
            background: rgba(0,0,0,0.55);
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
            ${
                showPulse
                    ? `<div style="
                position: absolute;
                inset: 0;
                border-radius: 50%;
                background: ${color}33;
                animation: cyclone-pulse 2s ease-in-out infinite;
            "></div>`
                    : ''
            }
            <div style="
                width: ${innerSize}px;
                height: ${innerSize}px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: ${isMacro ? 2 : 3}px solid ${color};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: ${fontSize}px;
                font-weight: 900;
                color: #fff;
                text-shadow: 0 0 8px ${color};
                z-index: 1;
            ">${cyclone.categoryLabel}</div>
        </div>
        ${
            showInfoBadge
                ? `<div style="
            font-size: 11px;
            font-weight: 600;
            color: #fff;
            text-shadow: 0 1px 4px rgba(0,0,0,1);
            margin-top: 4px;
            white-space: nowrap;
            background: rgba(0,0,0,0.6);
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
            50% { transform: scale(1.4); opacity: 0.2; }
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

/** Draw time-marker dots along the track at zoom > 8 */
function drawTrackDots(svg: SVGSVGElement, projected: { px: mapboxgl.Point; point: CyclonePosition }[]) {
    for (const { px, point } of projected) {
        const dotColor = windColor(point.windKts);

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
        dot.setAttribute('r', '3');
        dot.setAttribute('fill', dotColor);
        dot.setAttribute('stroke', 'rgba(0,0,0,0.6)');
        dot.setAttribute('stroke-width', '1');
        svg.appendChild(dot);

        // Time label at high zoom
        if (point.time) {
            const d = new Date(point.time);
            const label = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}Z`;
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', String(px.x + 8));
            text.setAttribute('y', String(px.y + 3));
            text.setAttribute('fill', '#e2e8f0');
            text.setAttribute('font-size', '9');
            text.setAttribute('font-weight', '600');
            text.setAttribute('font-family', 'system-ui, sans-serif');
            text.textContent = label;
            svg.appendChild(text);
        }
    }
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
