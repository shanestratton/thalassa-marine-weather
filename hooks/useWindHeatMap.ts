/**
 * Wind Heat Map Hook
 * 
 * Renders a semi-transparent wind speed heat map on a canvas layer.
 * Uses the same noise-based sampling as the particle engine to create
 * a spatially varying wind intensity visualization.
 * 
 * The heat map is transparent enough to let coastline outlines from
 * the base map tiles show through.
 */
import { useEffect, useRef, MutableRefObject } from 'react';
import { WeatherMetrics } from '../types';

// Beaufort-inspired wind speed color scale (knots)
// Calm → Light → Moderate → Fresh → Strong → Gale → Storm
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

// Sample wind speed with spatial variation (same noise as particle engine)
function sampleWindSpeed(lat: number, lon: number, baseSpeed: number): number {
    const noise = Math.sin(lat * 3) * Math.cos(lon * 3);
    // Add finer noise for more natural-looking variation
    const fineNoise = Math.sin(lat * 8 + lon * 5) * Math.cos(lat * 5 - lon * 8) * 0.5;
    return Math.max(0, baseSpeed + (noise * 4) + (fineNoise * 2));
}

export const useWindHeatMap = (
    canvasRef: MutableRefObject<HTMLCanvasElement | null>,
    mapInstance: MutableRefObject<any>,
    activeLayer: string,
    metrics: WeatherMetrics,
    visible: boolean
) => {
    const rafRef = useRef<number>(0);

    useEffect(() => {
        const map = mapInstance.current;
        const canvas = canvasRef.current;
        const isWindLayer = activeLayer === 'wind';

        if (!map || !canvas || !visible || !isWindLayer) {
            // Clear the canvas when not visible
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx?.clearRect(0, 0, canvas.width, canvas.height);
            }
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const CELL_SIZE = 12; // px per grid cell — balance between detail and perf
        const OPACITY = 0.35; // transparent enough to see coastlines

        const render = () => {
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

            const baseSpeed = metrics.windSpeed || 0;
            if (baseSpeed < 0.5) return; // No wind, no heat map

            const cellW = CELL_SIZE * dpr;
            const cols = Math.ceil(w / cellW);
            const rows = Math.ceil(h / cellW);

            // Create an ImageData buffer for efficient pixel writing
            const imageData = ctx.createImageData(w, h);
            const data = imageData.data;

            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    const px = (col + 0.5) * cellW;
                    const py = (row + 0.5) * cellW;

                    // Convert pixel to lat/lon
                    const latlng = map.containerPointToLatLng([px / dpr, py / dpr]);
                    const speed = sampleWindSpeed(latlng.lat, latlng.lng, baseSpeed);
                    const [r, g, b] = getWindColor(speed);
                    const alpha = Math.round(OPACITY * 255);

                    // Fill the cell in the image data
                    const startX = Math.floor(col * cellW);
                    const startY = Math.floor(row * cellW);
                    const endX = Math.min(Math.floor((col + 1) * cellW), w);
                    const endY = Math.min(Math.floor((row + 1) * cellW), h);

                    for (let y = startY; y < endY; y++) {
                        for (let x = startX; x < endX; x++) {
                            const idx = (y * w + x) * 4;
                            data[idx] = r;
                            data[idx + 1] = g;
                            data[idx + 2] = b;
                            data[idx + 3] = alpha;
                        }
                    }
                }
            }

            ctx.putImageData(imageData, 0, 0);
        };

        // Initial render
        render();

        // Re-render on map movements
        const onMove = () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(render);
        };

        map.on('move', onMove);
        map.on('zoom', onMove);
        map.on('zoomend', onMove);
        map.on('resize', onMove);

        // Handle container resize
        const resizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(render);
        });
        if (canvas.parentElement) {
            resizeObserver.observe(canvas.parentElement);
        }

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            resizeObserver.disconnect();
            map.off('move', onMove);
            map.off('zoom', onMove);
            map.off('zoomend', onMove);
            map.off('resize', onMove);
        };
    }, [mapInstance.current, activeLayer, visible, metrics]);
};
