/**
 * WindVelocityLayer — Leaflet Velocity Particle Layer for offline wind animation.
 *
 * Drop-in React component that:
 * - Fetches /wind_test.json (or live from Supabase edge function)
 * - Creates an animated particle wind field via leaflet-velocity-ts
 * - Cleanly mounts/unmounts from the parent Leaflet map
 *
 * Usage:
 *   <WindVelocityLayer map={leafletMap} visible={activeLayer === 'velocity'} />
 */

import React, { useEffect, useRef, useState } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('WindVelocityLayer');
import L from 'leaflet';

// ── Types ─────────────────────────────────────────────────────

interface WindVelocityLayerProps {
    /** The parent Leaflet map instance */
    map: L.Map | null;
    /** Whether this layer should be visible */
    visible: boolean;
    /** Optional: custom data URL (defaults to /wind_test.json) */
    dataUrl?: string;
    /** Show speed readout on hover */
    showReadout?: boolean;
}

// ── Marine-optimised color scale ──────────────────────────────

const WIND_COLORS = [
    'rgba(36, 104, 180, 0.5)', // 0-2  m/s — calm
    'rgba(60, 157, 194, 0.6)', // 2-4  m/s — light air
    'rgba(128, 205, 193, 0.6)', // 4-6  m/s — light breeze
    'rgba(151, 218, 168, 0.7)', // 6-8  m/s — gentle breeze
    'rgba(198, 231, 181, 0.7)', // 8-10 m/s — moderate
    'rgba(238, 247, 217, 0.7)', // 10-12 m/s — fresh
    'rgba(255, 238, 159, 0.8)', // 12-14 m/s — strong
    'rgba(252, 217, 125, 0.8)', // 14-16 m/s — near gale
    'rgba(255, 182, 100, 0.9)', // 16-18 m/s — gale
    'rgba(252, 150, 75, 0.9)', // 18-20 m/s — strong gale
    'rgba(250, 112, 52, 1.0)', // 20-22 m/s — storm
    'rgba(245, 64, 32, 1.0)', // 22+  m/s — violent storm
];

// ── Component ─────────────────────────────────────────────────

export const WindVelocityLayer: React.FC<WindVelocityLayerProps> = ({
    map,
    visible,
    dataUrl = '/wind_test.json',
    showReadout = true,
}) => {
    const layerRef = useRef<L.Layer | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [windData, setWindData] = useState<any[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    // ── Fetch wind data ────────────────────────────────────────
    useEffect(() => {
        if (!visible) return;

        let cancelled = false;

        const fetchData = async () => {
            try {
                const res = await fetch(dataUrl);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (!cancelled) {
                    setWindData(json);
                    setError(null);
                }
            } catch (err) {
                log.error(' Fetch failed:', err);
                if (!cancelled) setError(String(err));
            }
        };

        fetchData();

        return () => {
            cancelled = true;
        };
    }, [visible, dataUrl]);

    // ── Mount/unmount velocity layer ────────────────────────────
    useEffect(() => {
        if (!map || !visible || !windData) return;

        // Create velocity layer
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vLayer = (L as any).velocityLayer({
            displayValues: showReadout,
            displayOptions: {
                velocityType: 'GFS Wind',
                position: 'bottomleft',
                emptyString: 'No wind data',
                speedUnit: 'kt',
                showCardinal: true,
                angleConvention: 'bearingCW',
                directionString: 'Direction',
                speedString: 'Speed',
            },
            data: windData,
            maxVelocity: 25,
            velocityScale: 0.005,
            particleAge: 90,
            particleLineWidth: 1.5,
            particleMultiplier: 1 / 300,
            frameRate: 15,
            colorScale: WIND_COLORS,
            opacity: 0.85,
        });

        vLayer.addTo(map);
        layerRef.current = vLayer;

        return () => {
            // Clean removal
            if (layerRef.current && map.hasLayer(layerRef.current)) {
                map.removeLayer(layerRef.current);
            }
            layerRef.current = null;
        };
    }, [map, visible, windData, showReadout]);

    // ── Error badge ────────────────────────────────────────────
    if (error && visible) {
        return (
            <div className="absolute bottom-28 left-4 z-[900] bg-red-900/80 text-white text-xs px-3 py-2 rounded-lg border border-red-500/30">
                ⚠ Wind data unavailable
            </div>
        );
    }

    return null; // Pure Leaflet layer — no DOM rendering
};
