import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

interface GlobalWindLayerProps {
    map: L.Map | null;
    visible: boolean;
}

// Simplified global wind pattern data (in production, fetch from NOAA GFS or Windy API)
const GLOBAL_WIND_PATTERNS = [
    // Northern Hemisphere - Jet Stream
    { lat: 40, lon: -120, speed: 65, direction: 90, type: 'jet' },
    { lat: 42, lon: -80, speed: 70, direction: 85, type: 'jet' },
    { lat: 45, lon: -40, speed: 75, direction: 80, type: 'jet' },
    { lat: 48, lon: 0, speed: 68, direction: 90, type: 'jet' },
    { lat: 50, lon: 40, speed: 60, direction: 95, type: 'jet' },

    // Trade Winds
    { lat: 20, lon: -160, speed: 15, direction: 90, type: 'trade' },
    { lat: 18, lon: -120, speed: 18, direction: 85, type: 'trade' },
    { lat: 15, lon: -80, speed: 20, direction: 90, type: 'trade' },
    { lat: 12, lon: -40, speed: 16, direction: 95, type: 'trade' },

    // Southern Trade Winds
    { lat: -15, lon: -160, speed: 16, direction: 270, type: 'trade' },
    { lat: -18, lon: -100, speed: 19, direction: 275, type: 'trade' },
    { lat: -20, lon: -40, speed: 17, direction: 270, type: 'trade' },

    // Westerlies
    { lat: -45, lon: -140, speed: 35, direction: 270, type: 'westerly' },
    { lat: -48, lon: -80, speed: 40, direction: 265, type: 'westerly' },
    { lat: -50, lon: 0, speed: 38, direction: 270, type: 'westerly' },
];

// Pressure systems (simplified - in production, fetch real data)
const PRESSURE_SYSTEMS = [
    { lat: 35, lon: -75, type: 'H', pressure: 1025 }, // Bermuda High
    { lat: 25, lon: -155, type: 'H', pressure: 1022 }, // Pacific High
    { lat: 55, lon: -30, type: 'L', pressure: 995 }, // Iceland Low
    { lat: -40, lon: 80, type: 'L', pressure: 988 }, // Indian Ocean Low
];

export const GlobalWindLayer: React.FC<GlobalWindLayerProps> = ({ map, visible }) => {
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const offsetRef = useRef(0);

    useEffect(() => {
        if (!map || !visible) {
            // Clean up
            if (layerGroupRef.current) {
                map?.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
            return;
        }

        // Initialize layer group
        if (!layerGroupRef.current) {
            layerGroupRef.current = L.layerGroup().addTo(map);
        }

        const layerGroup = layerGroupRef.current;

        // Render pressure systems
        PRESSURE_SYSTEMS.forEach(system => {
            const isHigh = system.type === 'H';
            const color = isHigh ? '#ef4444' : '#3b82f6';
            const icon = L.divIcon({
                html: `
                    <div style="
                        width: 60px;
                        height: 60px;
                        display: flex;
                        align-items: center;
                        justify-center;
                        flex-direction: column;
                        font-family: system-ui;
                        pointer-events: none;
                    ">
                        <div style="
                            width: 50px;
                            height: 50px;
                            border-radius: 50%;
                            background: ${color}20;
                            border: 3px solid ${color};
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 28px;
                            font-weight: bold;
                            color: ${color};
                            box-shadow: 0 0 20px ${color}80;
                        ">
                            ${system.type}
                        </div>
                        <div style="
                            font-size: 10px;
                            font-weight: bold;
                            color: white;
                            background: rgba(0,0,0,0.7);
                            padding: 2px 6px;
                            border-radius: 4px;
                            margin-top: 4px;
                        ">
                            ${system.pressure} hPa
                        </div>
                    </div>
                `,
                className: 'pressure-system-marker',
                iconSize: [60, 60],
                iconAnchor: [30, 30],
            });

            const marker = L.marker([system.lat, system.lon], { icon })
                .bindTooltip(`${system.type === 'H' ? 'High' : 'Low'} Pressure: ${system.pressure} hPa`, {
                    permanent: false,
                    direction: 'top',
                    className: 'bg-black/80 text-white text-xs px-2 py-1 rounded border border-white/20'
                });

            layerGroup.addLayer(marker);
        });

        // Render wind streamlines with animation
        const renderStreamlines = () => {
            // Clear existing polylines (keep markers)
            layerGroup.eachLayer((layer) => {
                if (layer instanceof L.Polyline) {
                    layerGroup.removeLayer(layer);
                }
            });

            offsetRef.current = (offsetRef.current + 0.5) % 360;

            GLOBAL_WIND_PATTERNS.forEach((wind, idx) => {
                const { lat, lon, speed, direction } = wind;

                // Create curved streamline
                const points: L.LatLngExpression[] = [];
                const numPoints = 15;
                const length = speed / 10; // Scale length based on speed

                for (let i = 0; i < numPoints; i++) {
                    const t = i / (numPoints - 1);
                    const animOffset = (offsetRef.current + idx * 30) % 360;

                    // Calculate curve with slight wave
                    const rad = ((direction + animOffset * 0.1) * Math.PI) / 180;
                    const curvature = Math.sin(t * Math.PI * 2) * 2;

                    const newLat = lat + Math.sin(rad + curvature * 0.1) * length * t;
                    const newLon = lon + Math.cos(rad + curvature * 0.1) * length * t;

                    points.push([newLat, newLon]);
                }

                // Color based on speed
                let color = 'rgba(59,130,246,0.6)'; // Blue for light
                if (speed >= 60) color = 'rgba(239,68,68,0.8)'; // Red for jet stream
                else if (speed >= 30) color = 'rgba(249,115,22,0.7)'; // Orange for strong
                else if (speed >= 20) color = 'rgba(234,179,8,0.7)'; // Yellow for moderate

                // Create streamline with arrow
                const streamline = L.polyline(points, {
                    color: color,
                    weight: speed >= 60 ? 3 : 2,
                    opacity: 0.7,
                    dashArray: wind.type === 'jet' ? '10, 5' : '5, 5',
                    lineCap: 'round',
                    className: 'wind-streamline'
                });

                // Add arrow head at end
                const lastPoint = points[points.length - 1] as [number, number];
                const secondLastPoint = points[points.length - 2] as [number, number];

                const arrowIcon = L.divIcon({
                    html: `
                        <div style="
                            width: 0;
                            height: 0;
                            border-left: 5px solid transparent;
                            border-right: 5px solid transparent;
                            border-bottom: 10px solid ${color.replace('0.', '0.9').replace('0.8', '1.0')};
                            transform: rotate(${Math.atan2(lastPoint[0] - secondLastPoint[0], lastPoint[1] - secondLastPoint[1]) * 180 / Math.PI}deg);
                        "></div>
                    `,
                    className: 'wind-arrow',
                    iconSize: [10, 10],
                    iconAnchor: [5, 0],
                });

                const arrow = L.marker(lastPoint, { icon: arrowIcon, interactive: false });

                layerGroup.addLayer(streamline);
                layerGroup.addLayer(arrow);
            });

            // Continue animation
            animationFrameRef.current = requestAnimationFrame(renderStreamlines);
        };

        renderStreamlines();

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            if (layerGroupRef.current) {
                map.removeLayer(layerGroupRef.current);
                layerGroupRef.current = null;
            }
        };
    }, [map, visible]);

    return null; // This is a map overlay component, no DOM rendering
};
