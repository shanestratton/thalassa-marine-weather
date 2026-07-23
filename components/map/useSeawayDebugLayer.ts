/**
 * useSeawayDebugLayer — the Seaway Graph debug overlay (masterplan Stage
 * IV Phase 10: "Output: debug map overlay only. Zero routing change.").
 *
 * When visible, compiles the graph for the current viewport from the
 * installed ENC cells (services/seaway/compileFromCells) and renders:
 *   • gates  — circles: port red / stbd green / midpoint white, opacity
 *     by pairing confidence, amber ring on half-gates; station labels;
 *   • edges  — sky-blue channel centreline spans (geometry-is-the-law);
 *   • rejected edges — dashed red with the rejection reason, so a
 *     missing edge is a visible fact, never a silent drop.
 *
 * Recompiles on debounced moveend + cell import/remove. When hidden,
 * sources are emptied (layers stay mounted — zero cost). Modeled on
 * useEncTestRouteLayer's idempotent-mount pattern.
 */
import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';

import { createLogger } from '../../utils/createLogger';
import { subscribe as subscribeCells } from '../../services/enc/EncHazardService';
import { compileSeawayGraphForViewport } from '../../services/seaway/compileFromCells';

const log = createLogger('useSeawayDebugLayer');

const SRC_GATES = 'thalassa-seaway-gates';
const SRC_EDGES = 'thalassa-seaway-edges';
const SRC_REJECTED = 'thalassa-seaway-rejected';
const LYR_EDGES = 'thalassa-seaway-edges-line';
const LYR_REJECTED = 'thalassa-seaway-rejected-line';
const LYR_GATES = 'thalassa-seaway-gates-circle';
const LYR_GATE_LABELS = 'thalassa-seaway-gates-label';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function useSeawayDebugLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
): void {
    const mountedRef = useRef(false);
    const compileToken = useRef(0);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        if (!mountedRef.current) {
            try {
                for (const id of [SRC_GATES, SRC_EDGES, SRC_REJECTED]) {
                    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY });
                }
                if (!map.getLayer(LYR_EDGES)) {
                    map.addLayer({
                        id: LYR_EDGES,
                        type: 'line',
                        source: SRC_EDGES,
                        paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-opacity': 0.9 },
                    });
                }
                if (!map.getLayer(LYR_REJECTED)) {
                    map.addLayer({
                        id: LYR_REJECTED,
                        type: 'line',
                        source: SRC_REJECTED,
                        paint: {
                            'line-color': '#f87171',
                            'line-width': 2,
                            'line-dasharray': [2, 2],
                            'line-opacity': 0.85,
                        },
                    });
                }
                if (!map.getLayer(LYR_GATES)) {
                    map.addLayer({
                        id: LYR_GATES,
                        type: 'circle',
                        source: SRC_GATES,
                        paint: {
                            'circle-radius': ['match', ['get', 'kind'], 'mid', 4, 5],
                            'circle-color': ['match', ['get', 'kind'], 'port', '#ef4444', 'stbd', '#22c55e', '#ffffff'],
                            'circle-opacity': [
                                'interpolate',
                                ['linear'],
                                ['coalesce', ['get', 'confidence'], 1],
                                0.4,
                                0.45,
                                0.95,
                                1,
                            ],
                            'circle-stroke-width': ['case', ['==', ['get', 'halfGate'], true], 2, 1],
                            'circle-stroke-color': [
                                'case',
                                ['==', ['get', 'halfGate'], true],
                                '#fbbf24', // amber ring = half-gate
                                'rgba(15, 23, 42, 0.8)',
                            ],
                        },
                    });
                }
                if (!map.getLayer(LYR_GATE_LABELS)) {
                    map.addLayer({
                        id: LYR_GATE_LABELS,
                        type: 'symbol',
                        source: SRC_GATES,
                        minzoom: 12,
                        filter: ['==', ['get', 'kind'], 'mid'],
                        layout: {
                            'text-field': ['to-string', ['get', 'station']],
                            'text-size': 10,
                            'text-offset': [0, 1.1],
                            'text-allow-overlap': true,
                        },
                        paint: {
                            'text-color': '#e2e8f0',
                            'text-halo-color': 'rgba(15, 23, 42, 0.9)',
                            'text-halo-width': 1.2,
                        },
                    });
                }
                mountedRef.current = true;
            } catch (err) {
                log.warn('mount failed', err);
                return;
            }
        }

        const setAll = (
            gates: GeoJSON.FeatureCollection,
            edges: GeoJSON.FeatureCollection,
            rejected: GeoJSON.FeatureCollection,
        ): void => {
            (map.getSource(SRC_GATES) as mapboxgl.GeoJSONSource | undefined)?.setData(gates);
            (map.getSource(SRC_EDGES) as mapboxgl.GeoJSONSource | undefined)?.setData(edges);
            (map.getSource(SRC_REJECTED) as mapboxgl.GeoJSONSource | undefined)?.setData(rejected);
        };

        if (!visible) {
            setAll(EMPTY, EMPTY, EMPTY);
            return;
        }

        const recompile = async (): Promise<void> => {
            const token = ++compileToken.current;
            try {
                const b = map.getBounds();
                if (!b) return;
                const result = await compileSeawayGraphForViewport([
                    b.getWest(),
                    b.getSouth(),
                    b.getEast(),
                    b.getNorth(),
                ]);
                if (token !== compileToken.current) return; // stale viewport
                if (!result) {
                    setAll(EMPTY, EMPTY, EMPTY);
                    return;
                }
                setAll(
                    result.overlay.gates as GeoJSON.FeatureCollection,
                    result.overlay.edges as GeoJSON.FeatureCollection,
                    result.overlay.rejected as GeoJSON.FeatureCollection,
                );
                log.warn(
                    `seaway overlay: ${result.graph.gates.length} gates / ${result.graph.edges.length} edges / ${result.rejected.length} rejected (${result.markCount} marks in view)`,
                );
            } catch (err) {
                log.warn('compile failed', err);
            }
        };

        void recompile();

        let moveTimer: ReturnType<typeof setTimeout> | null = null;
        const onMoveEnd = (): void => {
            if (moveTimer) clearTimeout(moveTimer);
            moveTimer = setTimeout(() => void recompile(), 400);
        };
        map.on('moveend', onMoveEnd);
        const unsubscribe = subscribeCells(() => void recompile());

        return () => {
            map.off('moveend', onMoveEnd);
            if (moveTimer) clearTimeout(moveTimer);
            unsubscribe();
        };
    }, [mapRef, mapReady, visible]);

    // Cleanup on full unmount (rare — MapHub stays mounted for the session).
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        return () => {
            if (!map || !mountedRef.current) return;
            try {
                for (const id of [LYR_GATE_LABELS, LYR_GATES, LYR_REJECTED, LYR_EDGES]) {
                    if (map.getLayer(id)) map.removeLayer(id);
                }
                for (const id of [SRC_GATES, SRC_EDGES, SRC_REJECTED]) {
                    if (map.getSource(id)) map.removeSource(id);
                }
            } catch {
                // Map may already be torn down on app exit — ignore.
            }
            mountedRef.current = false;
        };
    }, [mapRef, mapReady]);
}
