/**
 * useCycloneLayer — Renders active tropical cyclones on the Mapbox map.
 *
 * ALL elements render as DOM overlays ABOVE the wind particle layer:
 *   - Storm markers: mapboxgl.Marker (DOM, z-index 500)
 *   - Track lines: SVG overlay (DOM, z-index 450)
 *
 * The wind particle layer is a Leaflet overlay at z-index 400,
 * so everything here sits cleanly above it.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import {
    fetchActiveCyclones,
    findClosestCyclone,
    type ActiveCyclone,
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

// ── Create DOM marker for a cyclone ───────────────────────

// ── Regional storm classification ─────────────────────────

function stormClassification(basin: string, windKts: number): string {
    const b = basin.toUpperCase();

    // Atlantic & Eastern/Central Pacific → Hurricane
    if (['AL', 'EP', 'CP'].includes(b)) {
        if (windKts >= 96) return 'Major Hurricane';
        if (windKts >= 64) return 'Hurricane';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // Western Pacific → Typhoon
    if (b === 'WP') {
        if (windKts >= 130) return 'Super Typhoon';
        if (windKts >= 64) return 'Typhoon';
        if (windKts >= 34) return 'Tropical Storm';
        return 'Tropical Depression';
    }

    // Australian & South Pacific & South Indian → Tropical Cyclone
    if (['AU', 'SP', 'SI'].includes(b)) {
        if (windKts >= 64) return 'Severe Tropical Cyclone';
        if (windKts >= 34) return 'Tropical Cyclone';
        return 'Tropical Depression';
    }

    // North Indian → Cyclonic Storm
    if (['IO', 'NI', 'BB', 'AS'].includes(b)) {
        if (windKts >= 64) return 'Very Severe Cyclonic Storm';
        if (windKts >= 48) return 'Severe Cyclonic Storm';
        if (windKts >= 34) return 'Cyclonic Storm';
        return 'Depression';
    }

    // Fallback
    if (windKts >= 64) return 'Tropical Cyclone';
    if (windKts >= 34) return 'Tropical Storm';
    return 'Tropical Depression';
}

function createStormMarkerEl(cyclone: ActiveCyclone): HTMLElement {
    const color = categoryColor(cyclone.category);
    const { windKts, pressureMb } = cyclone.currentPosition;
    const classification = stormClassification(cyclone.basin, windKts ?? cyclone.maxWindKts);

    const catStr =
        cyclone.category > 0
            ? `Cat ${cyclone.categoryLabel} · ${windKts ?? '?'} kts${pressureMb ? ` · ${pressureMb} hPa` : ''}`
            : `${cyclone.categoryLabel} · ${windKts ?? '?'} kts`;

    const el = document.createElement('div');
    el.className = 'cyclone-marker';
    el.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 500;
        filter: drop-shadow(0 2px 12px rgba(0,0,0,0.8));
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
            <div style="font-size: 10px; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.08em;">${classification}</div>
            <div style="font-size: 15px;">${cyclone.name}</div>
        </div>
        <div style="
            position: relative;
            width: 52px;
            height: 52px;
            display: flex;
            align-items: center;
            justify-content: center;
        ">
            <div style="
                position: absolute;
                inset: 0;
                border-radius: 50%;
                background: ${color}33;
                animation: cyclone-pulse 2s ease-in-out infinite;
            "></div>
            <div style="
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: 3px solid ${color};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                font-weight: 900;
                color: #fff;
                text-shadow: 0 0 8px ${color};
                z-index: 1;
            ">${cyclone.categoryLabel}</div>
        </div>
        <div style="
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
        ">${catStr}</div>
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
 * Creates and manages an SVG overlay div positioned above the wind particles
 * (z-index 450) that draws storm track lines.
 */
function createTrackOverlay(map: mapboxgl.Map): {
    update: (cyclones: ActiveCyclone[]) => void;
    remove: () => void;
} {
    const container = map.getContainer();

    // Create SVG overlay div
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
        // Clear SVG
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        const rect = container.getBoundingClientRect();
        svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

        for (const c of storedCyclones) {
            if (c.track.length < 2) continue;

            const color = categoryColor(c.category);

            // Convert geo coords to screen pixels
            const points = c.track
                .map((p) => {
                    const px = map.project([p.lon, p.lat]);
                    return `${px.x},${px.y}`;
                })
                .join(' ');

            const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            polyline.setAttribute('points', points);
            polyline.setAttribute('fill', 'none');
            polyline.setAttribute('stroke', color);
            polyline.setAttribute('stroke-width', '3');
            polyline.setAttribute('stroke-dasharray', '10,6');
            polyline.setAttribute('stroke-opacity', '0.8');
            polyline.setAttribute('stroke-linecap', 'round');
            svg.appendChild(polyline);
        }
    };

    // Redraw on every map move/zoom
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
            // Remove DOM markers
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            // Remove track overlay
            trackOverlayRef.current?.remove();
            trackOverlayRef.current = null;
            hasFlown.current = false;
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            return;
        }

        // Inject pulse CSS
        injectCycloneCSS();

        // Create track overlay (SVG above wind)
        if (!trackOverlayRef.current) {
            trackOverlayRef.current = createTrackOverlay(map);
        }

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

                // Update track SVG overlay
                trackOverlayRef.current?.update(cyclones);

                // Remove old DOM markers
                for (const m of markersRef.current) m.remove();
                markersRef.current = [];

                // Create new DOM markers (z-index 500, above wind at 400)
                for (const c of cyclones) {
                    const el = createStormMarkerEl(c);
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
            if (refreshTimer.current) {
                clearInterval(refreshTimer.current);
                refreshTimer.current = null;
            }
            // Clean up
            for (const m of markersRef.current) m.remove();
            markersRef.current = [];
            trackOverlayRef.current?.remove();
            trackOverlayRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, mapReady]);
}
