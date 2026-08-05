/**
 * useConsensusMatrix — post-route consensus matrix state: generation when a
 * passage completes (dynamic-imported engine), the route-sync playhead
 * marker, and the show/hide state consumed by the matrix panels.
 *
 * Extracted verbatim from MapHub.tsx as part of the MapHub decomposition.
 * Closure captures became the `deps` parameter; no logic changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { WindStore } from '../../stores/WindStore';
import type { ConsensusMatrixData } from '../../services/ConsensusMatrixEngine';
import type { usePassagePlanner } from './usePassagePlanner';

const log = createLogger('MapHub');

export interface ConsensusMatrixDeps {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    passage: Pick<ReturnType<typeof usePassagePlanner>, 'isoResultRef' | 'routeAnalysis' | 'departureTime'>;
    setIsoProgress: (p: null) => void;
}

export function useConsensusMatrix({ mapRef, passage, setIsoProgress }: ConsensusMatrixDeps) {
    const [showConsensus, setShowConsensus] = useState(false);
    const [consensusData, setConsensusData] = useState<ConsensusMatrixData | null>(null);
    const playheadMarkerRef = useRef<mapboxgl.Marker | null>(null);

    // Clear isochrone progress when route completes
    useEffect(() => {
        if (passage.isoResultRef.current) setIsoProgress(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis]);

    // Generate consensus data when route completes
    // Dynamic import — ConsensusMatrixEngine is heavy computation, only needed post-route
    useEffect(() => {
        const isoResult = passage.isoResultRef.current;
        if (!isoResult || !passage.routeAnalysis) {
            setConsensusData(null);
            return;
        }
        const windGrid = WindStore.getState().grid;
        if (!windGrid) return;

        (async () => {
            try {
                const { generateConsensusMatrix } = await import('../../services/ConsensusMatrixEngine');
                const data = await generateConsensusMatrix(
                    isoResult,
                    windGrid,
                    passage.departureTime || new Date().toISOString(),
                    undefined,
                    6,
                );
                setConsensusData(data);
            } catch (err) {
                log.warn('[Consensus] Failed to generate matrix:', err);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis, passage.departureTime]);

    // Route-sync playhead marker
    const handleScrubPosition = useCallback(
        (lat: number, lon: number) => {
            const map = mapRef.current;
            if (!map) return;

            if (!playheadMarkerRef.current) {
                const el = document.createElement('div');
                el.style.cssText = `
                width: 20px; height: 20px;
                background: linear-gradient(135deg, #38bdf8, #a78bfa);
                border: 3px solid #fff;
                border-radius: 50%;
                box-shadow: 0 0 16px rgba(56,189,248,0.5), 0 4px 12px rgba(0,0,0,0.3);
                transition: opacity 0.2s;
            `;
                playheadMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([lon, lat])
                    .addTo(map);
            } else {
                playheadMarkerRef.current.setLngLat([lon, lat]);
            }
        },
        [mapRef],
    );

    // Clean up playhead when consensus closes
    useEffect(() => {
        if (!showConsensus && playheadMarkerRef.current) {
            playheadMarkerRef.current.remove();
            playheadMarkerRef.current = null;
        }
    }, [showConsensus]);

    return { showConsensus, setShowConsensus, consensusData, handleScrubPosition };
}
