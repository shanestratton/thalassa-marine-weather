/**
 * Global Wind Layer
 * 
 * Renders a real-time global wind heat map with isobar contour lines
 * using data from the Open-Meteo free API.
 * 
 * Features:
 * - Wind speed heat map (Beaufort-scale color gradient)
 * - Wind direction arrows at grid points
 * - MSLP isobar contour lines (4 hPa intervals)
 * - H/L pressure system labels at extremes
 * - Auto-refetches when map pans/zooms significantly
 */
import React, { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import {
    fetchGlobalWindGrid,
    interpolateAtPoint,
    WindGridData,
} from '../../services/weather/api/globalWind';

interface GlobalWindLayerProps {
    map: L.Map | null;
    visible: boolean;
}

// Beaufort-inspired wind speed color scale (knots)
const WIND_COLORS: [number, [number, number, number]][] = [
    [0, [40, 80, 160]],     // Calm: deep blue
    [5, [30, 140, 200]],    // Light: sky blue
    [10, [50, 190, 160]],    // Gentle: teal
    [15, [80, 200, 80]],     // Moderate: green
    [20, [180, 200, 40]],    // Fresh: yellow-green
    [25, [240, 200, 0]],     // Strong: yellow
    [30, [240, 140, 0]],     // Near Gale: orange
    [35, [220, 60, 20]],     // Gale: red-orange
    [40, [180, 20, 40]],     // Strong Gale: red
    [50, [140, 0, 80]],      // Storm: dark magenta
    [65, [100, 0, 120]],     // Violent Storm: purple
];

function getWindColor(speed: number): [number, number, number] {
    if (speed <= WIND_COLORS[0][0]) return WIND_COLORS[0][1];
    if (speed >= WIND_COLORS[WIND_COLORS.length - 1][0]) return WIND_COLORS[WIND_COLORS.length - 1][1];

    for (let i = 0; i < WIND_COLORS.length - 1; i++) {
        const [s0, c0] = WIND_COLORS[i];
        const [s1, c1] = WIND_COLORS[i + 1];
        if (speed >= s0 && speed <= s1) {
            const t = (speed - s0) / (s1 - s0);
            return [
                Math.round(c0[0] + t * (c1[0] - c0[0])),
                Math.round(c0[1] + t * (c1[1] - c0[1])),
                Math.round(c0[2] + t * (c1[2] - c0[2])),
            ];
        }
    }
    return WIND_COLORS[0][1];
}

export const GlobalWindLayer: React.FC<GlobalWindLayerProps> = ({ map, visible }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const windDataRef = useRef<WindGridData | null>(null);
    const rafRef = useRef<number>(0);
    const fetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Create and manage canvas
    useEffect(() => {
        if (!map) return;

        // Create an overlay canvas
        const container = map.getContainer();
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.inset = '0';
        canvas.style.zIndex = '5';
        canvas.style.pointerEvents = 'none';
        container.appendChild(canvas);
        canvasRef.current = canvas;

        return () => {
            if (canvas.parentElement) {
                canvas.parentElement.removeChild(canvas);
            }
            canvasRef.current = null;
        };
    }, [map]);

    const renderHeatMap = useCallback(() => {
        const canvas = canvasRef.current;
        const data = windDataRef.current;
        if (!canvas || !data || !map || !visible) {
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx?.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const rect = canvas.parentElement?.getBoundingClientRect();
        if (!rect) return;

        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(rect.width * dpr);
        const h = Math.round(rect.height * dpr);

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
        }

        ctx.clearRect(0, 0, w, h);

        const CELL = 14 * dpr;
        const cols = Math.ceil(w / CELL);
        const rows = Math.ceil(h / CELL);
        const OPACITY = 0.35;

        const imageData = ctx.createImageData(w, h);
        const pixels = imageData.data;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const px = (col + 0.5) * CELL;
                const py = (row + 0.5) * CELL;

                const latlng = map.containerPointToLatLng([px / dpr, py / dpr]);
                const interpolated = interpolateAtPoint(data, latlng.lat, latlng.lng);
                const [r, g, b] = getWindColor(interpolated.speed);
                const alpha = Math.round(OPACITY * 255);

                const startX = Math.floor(col * CELL);
                const startY = Math.floor(row * CELL);
                const endX = Math.min(Math.floor((col + 1) * CELL), w);
                const endY = Math.min(Math.floor((row + 1) * CELL), h);

                for (let y = startY; y < endY; y++) {
                    for (let x = startX; x < endX; x++) {
                        const idx = (y * w + x) * 4;
                        pixels[idx] = r;
                        pixels[idx + 1] = g;
                        pixels[idx + 2] = b;
                        pixels[idx + 3] = alpha;
                    }
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);
    }, [map, visible]);

    const renderIsobarsAndArrows = useCallback(() => {
        const data = windDataRef.current;
        if (!map || !data || !visible) {
            if (layerGroupRef.current) {
                map?.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
            return;
        }

        // Clear existing layers
        if (layerGroupRef.current) {
            map.removeLayer(layerGroupRef.current);
        }
        layerGroupRef.current = L.layerGroup().addTo(map);
        const lg = layerGroupRef.current;

        const bounds = map.getBounds();
        const zoom = map.getZoom();

        // --- ISOBAR CONTOURS ---
        // Generate isobars at 4 hPa intervals using marching squares-style approach
        const isobarInterval = 4; // hPa
        const gridRes = 40; // Resolution for isobar sampling
        const latStep = (bounds.getNorth() - bounds.getSouth()) / gridRes;
        const lonStep = (bounds.getEast() - bounds.getWest()) / gridRes;

        // Build pressure grid
        const pressureGrid: number[][] = [];
        for (let r = 0; r <= gridRes; r++) {
            const row: number[] = [];
            for (let c = 0; c <= gridRes; c++) {
                const lat = bounds.getSouth() + r * latStep;
                const lon = bounds.getWest() + c * lonStep;
                const interp = interpolateAtPoint(data, lat, lon);
                row.push(interp.pressure);
            }
            pressureGrid.push(row);
        }

        // Find pressure range
        const allPressures = pressureGrid.flat();
        const minP = Math.floor(Math.min(...allPressures) / isobarInterval) * isobarInterval;
        const maxP = Math.ceil(Math.max(...allPressures) / isobarInterval) * isobarInterval;

        // Trace contours using simple marching squares
        for (let pLevel = minP; pLevel <= maxP; pLevel += isobarInterval) {
            const segments: [L.LatLng, L.LatLng][] = [];

            for (let r = 0; r < gridRes; r++) {
                for (let c = 0; c < gridRes; c++) {
                    const v00 = pressureGrid[r][c];
                    const v10 = pressureGrid[r][c + 1];
                    const v01 = pressureGrid[r + 1][c];
                    const v11 = pressureGrid[r + 1][c + 1];

                    const lat0 = bounds.getSouth() + r * latStep;
                    const lat1 = lat0 + latStep;
                    const lon0 = bounds.getWest() + c * lonStep;
                    const lon1 = lon0 + lonStep;

                    // Classify cell corners
                    const b00 = v00 >= pLevel ? 1 : 0;
                    const b10 = v10 >= pLevel ? 1 : 0;
                    const b01 = v01 >= pLevel ? 1 : 0;
                    const b11 = v11 >= pLevel ? 1 : 0;
                    const caseIdx = b00 | (b10 << 1) | (b01 << 2) | (b11 << 3);

                    if (caseIdx === 0 || caseIdx === 15) continue;

                    // Interpolation helper
                    const lerp = (a: number, b: number, va: number, vb: number) =>
                        a + (pLevel - va) / (vb - va) * (b - a);

                    // Edge midpoints (interpolated)
                    const top = () => L.latLng(lat0, lerp(lon0, lon1, v00, v10));
                    const bot = () => L.latLng(lat1, lerp(lon0, lon1, v01, v11));
                    const left = () => L.latLng(lerp(lat0, lat1, v00, v01), lon0);
                    const right = () => L.latLng(lerp(lat0, lat1, v10, v11), lon1);

                    // Marching squares lookup (simplified — no ambiguous saddles)
                    const addSeg = (a: L.LatLng, b: L.LatLng) => segments.push([a, b]);

                    switch (caseIdx) {
                        case 1: case 14: addSeg(top(), left()); break;
                        case 2: case 13: addSeg(top(), right()); break;
                        case 3: case 12: addSeg(left(), right()); break;
                        case 4: case 11: addSeg(left(), bot()); break;
                        case 5: case 10: addSeg(top(), left()); addSeg(bot(), right()); break;
                        case 6: case 9: addSeg(top(), bot()); break;
                        case 7: case 8: addSeg(bot(), right()); break;
                    }
                }
            }

            if (segments.length === 0) continue;

            // Draw isobar segments
            const isMajor = pLevel % 8 === 0;
            segments.forEach(([p1, p2]) => {
                L.polyline([p1, p2], {
                    color: 'rgba(255,255,255,0.5)',
                    weight: isMajor ? 1.5 : 0.8,
                    opacity: isMajor ? 0.6 : 0.3,
                    interactive: false,
                }).addTo(lg);
            });

            // Label major isobars
            if (isMajor && segments.length > 0) {
                const mid = segments[Math.floor(segments.length / 2)];
                const labelLat = (mid[0].lat + mid[1].lat) / 2;
                const labelLng = (mid[0].lng + mid[1].lng) / 2;

                const icon = L.divIcon({
                    html: `<span style="
                        font-size: 9px;
                        font-weight: bold;
                        color: rgba(255,255,255,0.7);
                        background: rgba(0,0,0,0.5);
                        padding: 1px 4px;
                        border-radius: 3px;
                        white-space: nowrap;
                        pointer-events: none;
                    ">${pLevel}</span>`,
                    className: 'isobar-label',
                    iconSize: [30, 14],
                    iconAnchor: [15, 7],
                });
                L.marker([labelLat, labelLng], { icon, interactive: false }).addTo(lg);
            }
        }

        // --- H/L PRESSURE SYSTEM LABELS ---
        // Find local extremes in the pressure grid
        const highPoints: { lat: number; lon: number; p: number }[] = [];
        const lowPoints: { lat: number; lon: number; p: number }[] = [];

        for (let r = 2; r < gridRes - 2; r += 4) {
            for (let c = 2; c < gridRes - 2; c += 4) {
                const lat = bounds.getSouth() + r * latStep;
                const lon = bounds.getWest() + c * lonStep;
                const p = pressureGrid[r][c];

                // Check if it's a local max/min in a 5x5 neighborhood
                let isMax = true, isMin = true;
                for (let dr = -2; dr <= 2 && (isMax || isMin); dr++) {
                    for (let dc = -2; dc <= 2 && (isMax || isMin); dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr, nc = c + dc;
                        if (nr < 0 || nr > gridRes || nc < 0 || nc > gridRes) continue;
                        const np = pressureGrid[nr]?.[nc];
                        if (np === undefined) continue;
                        if (np >= p) isMax = false;
                        if (np <= p) isMin = false;
                    }
                }

                if (isMax && p > 1015) highPoints.push({ lat, lon, p });
                if (isMin && p < 1010) lowPoints.push({ lat, lon, p });
            }
        }

        // Render H/L markers
        [...highPoints, ...lowPoints].forEach(({ lat, lon, p }) => {
            const isHigh = p > 1013;
            const color = isHigh ? '#ef4444' : '#3b82f6';
            const label = isHigh ? 'H' : 'L';

            const icon = L.divIcon({
                html: `
                    <div style="
                        display: flex; flex-direction: column; align-items: center;
                        pointer-events: none; font-family: system-ui;
                    ">
                        <div style="
                            width: 36px; height: 36px; border-radius: 50%;
                            background: ${color}25; border: 2.5px solid ${color};
                            display: flex; align-items: center; justify-content: center;
                            font-size: 22px; font-weight: 900; color: ${color};
                            box-shadow: 0 0 15px ${color}60;
                        ">${label}</div>
                        <div style="
                            font-size: 9px; font-weight: bold; color: white;
                            background: rgba(0,0,0,0.7); padding: 1px 5px;
                            border-radius: 3px; margin-top: 2px;
                        ">${Math.round(p)} hPa</div>
                    </div>
                `,
                className: 'pressure-label',
                iconSize: [40, 55],
                iconAnchor: [20, 28],
            });

            L.marker([lat, lon], { icon, interactive: false }).addTo(lg);
        });

        // --- WIND DIRECTION ARROWS ---
        // Only show at zoom >= 4 to avoid clutter
        if (zoom >= 4) {
            const arrowSpacing = zoom >= 7 ? 3 : zoom >= 5 ? 5 : 8;

            for (let i = 0; i < data.points.length; i++) {
                // Space out arrows
                const row = Math.floor(i / data.gridCols);
                const col = i % data.gridCols;
                if (row % arrowSpacing !== 0 || col % arrowSpacing !== 0) continue;

                const p = data.points[i];
                if (!bounds.contains([p.lat, p.lon])) continue;

                const icon = L.divIcon({
                    html: `<svg viewBox="0 0 24 24" width="16" height="16" style="
                        transform: rotate(${p.windDirection}deg);
                        filter: drop-shadow(0 0 2px rgba(0,0,0,0.8));
                    ">
                        <path d="M12 2L8 10h3v12h2V10h3z" fill="rgba(255,255,255,0.7)" />
                    </svg>`,
                    className: 'wind-arrow-marker',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                });

                L.marker([p.lat, p.lon], { icon, interactive: false })
                    .bindTooltip(`${Math.round(p.windSpeed)} kts ${Math.round(p.windDirection)}°`, {
                        permanent: false,
                        direction: 'top',
                    })
                    .addTo(lg);
            }
        }
    }, [map, visible]);

    // Fetch data and render
    const fetchAndRender = useCallback(async () => {
        if (!map || !visible) return;

        const bounds = map.getBounds();
        const data = await fetchGlobalWindGrid(
            bounds.getSouth(),
            bounds.getNorth(),
            bounds.getWest(),
            bounds.getEast()
        );

        if (data) {
            windDataRef.current = data;
            renderHeatMap();
            renderIsobarsAndArrows();
        }
    }, [map, visible, renderHeatMap, renderIsobarsAndArrows]);

    // Main effect
    useEffect(() => {
        if (!map || !visible) {
            // Clean up
            const canvas = canvasRef.current;
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx?.clearRect(0, 0, canvas.width, canvas.height);
            }
            if (layerGroupRef.current) {
                map?.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
            return;
        }

        // Initial fetch
        fetchAndRender();

        // Re-render heat map on move (no re-fetch)
        const onMove = () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(renderHeatMap);
        };

        // Debounced re-fetch on zoom/pan end
        const onMoveEnd = () => {
            if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
            fetchTimeoutRef.current = setTimeout(() => {
                fetchAndRender();
            }, 500);
        };

        map.on('move', onMove);
        map.on('moveend', onMoveEnd);
        map.on('zoomend', onMoveEnd);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
            map.off('move', onMove);
            map.off('moveend', onMoveEnd);
            map.off('zoomend', onMoveEnd);
            if (layerGroupRef.current) {
                map.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
        };
    }, [map, visible, fetchAndRender, renderHeatMap]);

    return null; // Map overlay component, no DOM rendering
};
